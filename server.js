const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'session-change-me';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@send.irada.work';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.GCAL_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.GCAL_CLIENT_SECRET || '';
const GCAL_CLIENT_ID = GOOGLE_CLIENT_ID;
const GCAL_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'irada.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
    password_hash TEXT, name TEXT NOT NULL,
    google_id TEXT, todoist_token TEXT, ticktick_token TEXT,
    gcal_refresh_token TEXT, gcal_connected INTEGER DEFAULT 0,
    selected_calendars TEXT DEFAULT '[]',
    reset_token TEXT, reset_token_expires TEXT,
    last_login_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#c4922a',
    todoist_project_id TEXT, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
    is_open INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL, notes TEXT DEFAULT '',
    due_date TEXT, priority INTEGER DEFAULT 3,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
    tags TEXT DEFAULT '[]', is_done INTEGER DEFAULT 0,
    is_urgent INTEGER DEFAULT 0, is_important INTEGER DEFAULT 0,
    pomos INTEGER DEFAULT 1, today_pick INTEGER DEFAULT 0,
    gcal_event_id TEXT, todoist_task_id TEXT, ticktick_task_id TEXT,
    sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT DEFAULT '🌱', name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS habit_logs (
    habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    log_date TEXT NOT NULL, PRIMARY KEY (habit_id, log_date)
  );
`);

// Migrations for existing databases
[
  'ALTER TABLE users ADD COLUMN google_id TEXT',
  'ALTER TABLE users ADD COLUMN todoist_token TEXT',
  'ALTER TABLE users ADD COLUMN ticktick_token TEXT',
  'ALTER TABLE users ADD COLUMN gcal_refresh_token TEXT',
  'ALTER TABLE users ADD COLUMN gcal_connected INTEGER DEFAULT 0',
  'ALTER TABLE users ADD COLUMN selected_calendars TEXT DEFAULT \'[]\'',
  'ALTER TABLE users ADD COLUMN reset_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_token_expires TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires TEXT',
  'ALTER TABLE users ADD COLUMN last_login_date TEXT',
  'ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ""',
  'ALTER TABLE tasks ADD COLUMN ticktick_task_id TEXT',
].forEach(sql => { try { db.exec(sql); } catch(e) {} });

app.use(cors());
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 30*24*60*60*1000, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const today = () => new Date().toISOString().slice(0, 10);
const parseTask = row => ({
  ...row, tags: JSON.parse(row.tags || '[]'),
  is_done: !!row.is_done, is_urgent: !!row.is_urgent,
  is_important: !!row.is_important, today_pick: !!row.today_pick,
  notes: row.notes || '',
});

// EMAIL
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log('No RESEND_API_KEY, email skipped'); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Irada <${FROM_EMAIL}>`, to, subject, html })
    });
    return r.ok;
  } catch(e) { console.error('Email error:', e.message); return false; }
}

// AUTH: EMAIL/PASSWORD
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id;
  // Mark for rollover check on next /me call
  req.session.check_rollover = true;
  res.json({ ok: true, name: user.name, email: user.email });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const todayStr = today();
  let needs_rollover = false;
  let incomplete_today_tasks = [];

  // Rollover check: new day since last login
  if (req.session.check_rollover || (user.last_login_date && user.last_login_date !== todayStr)) {
    needs_rollover = true;
    incomplete_today_tasks = db.prepare(
      'SELECT * FROM tasks WHERE user_id=? AND today_pick=1 AND is_done=0 AND parent_id IS NULL'
    ).all(req.session.userId).map(parseTask);
  }
  // Update last_login_date to today
  db.prepare('UPDATE users SET last_login_date=? WHERE id=?').run(todayStr, req.session.userId);
  req.session.check_rollover = false;

  res.json({
    id: user.id, name: user.name, email: user.email,
    gcal_connected: !!user.gcal_connected,
    has_todoist: !!user.todoist_token,
    has_ticktick: !!user.ticktick_token,
    selected_calendars: JSON.parse(user.selected_calendars || '[]'),
    needs_rollover,
    incomplete_today_tasks,
  });
});

// AUTH: GOOGLE SSO
function getGoogleOAuth() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, `${APP_URL}/api/auth/google/callback`);
}
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).send('Google OAuth not configured');
  const auth = getGoogleOAuth();
  const scopes = ['https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile'];
  const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes });
  res.redirect(url);
});
app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=oauth_failed');
  try {
    const auth = getGoogleOAuth();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data: profile } = await oauth2.userinfo.get();
    const email = profile.email.toLowerCase();
    let user = db.prepare('SELECT * FROM users WHERE email=? OR google_id=?').get(email, profile.id);
    const isNew = !user;
    if (!user) {
      const id = uid();
      db.prepare('INSERT INTO users (id,email,password_hash,name,google_id) VALUES (?,?,?,?,?)').run(id, email, '', profile.name, profile.id);
      try { seedUser(id); } catch(e) {}
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    } else {
      db.prepare('UPDATE users SET google_id=COALESCE(google_id,?) WHERE id=?').run(profile.id, user.id);
    }
    req.session.userId = user.id;
    req.session.check_rollover = true;
    res.redirect(isNew ? '/?settings=1' : '/');
  } catch(e) { console.error('Google OAuth error:', e.message); res.redirect('/?error=oauth_failed'); }
});

// AUTH: FORGOT/RESET PASSWORD
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (user && user.password_hash) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString();
    db.prepare('UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?').run(token, expires, user.id);
    const resetUrl = `${APP_URL}/login?reset=${token}`;
    await sendEmail(user.email, 'Reset your Irada password',
      `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#1a1714">
        <div style="background:#23211e;border-radius:12px;padding:28px;border:1px solid rgba(196,146,42,0.2)">
          <div style="font-family:Georgia,serif;font-size:24px;color:#f5f0e8;margin:0 0 4px">Irad<em style="font-style:italic;color:#e8b84b">a</em></div>
          <div style="font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7a7168;margin:0 0 24px">Direct your will</div>
          <h2 style="font-family:Georgia,serif;color:#f5f0e8;margin:0 0 12px;font-weight:400">Reset your password</h2>
          <p style="color:#7a7168;margin:0 0 20px;line-height:1.6">Click below to reset your Irada password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#c4922a;color:#1a1714;padding:12px 24px;border-radius:2px;text-decoration:none;font-weight:600;font-size:13px;letter-spacing:0.06em;text-transform:uppercase">Reset Password</a>
          <p style="color:#7a7168;font-size:12px;margin-top:24px;margin-bottom:0">If you didn't request this, ignore this email.</p>
        </div>
      </div>`
    );
  }
  res.json({ ok: true });
});
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  const user = db.prepare('SELECT * FROM users WHERE reset_token=?').get(token);
  const expires = user?.reset_token_expires || user?.reset_expires;
  if (!user || !expires || new Date(expires) < new Date()) return res.status(400).json({ error: 'Invalid or expired reset link' });
  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?').run(hash, user.id);
  res.json({ ok: true });
});

// ADMIN
app.post('/admin/create-user', async (req, res) => {
  const { adminSecret, email, password, name } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid admin secret' });
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'User already exists' });
  const hash = await bcrypt.hash(password, 12);
  const id = uid();
  db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(id, email.toLowerCase().trim(), hash, name);
  try { seedUser(id); } catch(e) { console.log('Seed note:', e.message); }
  res.json({ ok: true, id, email, name });
});

function seedUser(id) {
  db.pragma('foreign_keys = OFF');
  const p1=uid(),p2=uid(),s1=uid(),s2=uid(),s3=uid(),s4=uid(),s5=uid();
  const todayStr=new Date().toISOString().slice(0,10);
  const nxt=d=>new Date(Date.now()+d*86400000).toISOString().slice(0,10);
  db.prepare('INSERT OR IGNORE INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(p1,id,'Work','#8b5cf6',0);
  db.prepare('INSERT OR IGNORE INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(p2,id,'Personal','#c4922a',1);
  [s1,s2,s3].forEach((s,i)=>db.prepare('INSERT OR IGNORE INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(s,p1,id,['In Progress','This Week','Backlog'][i],i));
  [s4,s5].forEach((s,i)=>db.prepare('INSERT OR IGNORE INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(s,p2,id,['Errands','Goals'][i],i));
  const ins=db.prepare('INSERT OR IGNORE INTO tasks (id,user_id,name,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  [[uid(),'Review Q2 operations report',todayStr,1,p1,s1,'["urgent","review"]',1,1,2],[uid(),'Set up workflow templates',todayStr,2,p1,s1,'["research"]',0,1,3],[uid(),'Research competitors',nxt(1),2,p1,s2,'["research"]',1,0,2],[uid(),'Draft SOP template for onboarding',nxt(3),3,p1,s3,'[]',0,1,4],[uid(),'Book dentist appointment',todayStr,3,p2,s4,'["personal"]',1,0,1],[uid(),'Renew gym membership',nxt(2),4,p2,s4,'[]',0,0,1],[uid(),'Read Chapter 3',nxt(4),3,p2,s5,'["research"]',0,1,2]].forEach(t=>ins.run(id,...t));
  const insh=db.prepare('INSERT OR IGNORE INTO habits (id,user_id,emoji,name,sort_order) VALUES (?,?,?,?,?)');
  [[uid(),'💧','Drink 8 glasses of water',0],[uid(),'📚','Read for 20 minutes',1],[uid(),'🏃','Exercise',2],[uid(),'✍️','Journal or reflect',3]].forEach(h=>insh.run(id,...h));
  const hIds=db.prepare('SELECT id FROM habits WHERE user_id=? ORDER BY sort_order').all(id).map(r=>r.id);
  const insl=db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id,log_date) VALUES (?,?)');
  Object.entries({0:[0,1,2,3,5],1:[0,1,3,4,6,7],2:[1,2,4,7],3:[0,2,5]}).forEach(([i,days])=>days.forEach(d=>insl.run(hIds[i],new Date(Date.now()-d*86400000).toISOString().slice(0,10))));
  db.pragma('foreign_keys = ON');
}

// SETTINGS
app.get('/api/settings', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,gcal_connected,todoist_token,ticktick_token,selected_calendars FROM users WHERE id=?').get(req.session.userId);
  res.json({
    ...user,
    gcal_connected: !!user.gcal_connected,
    has_todoist: !!user.todoist_token,
    has_ticktick: !!user.ticktick_token,
    selected_calendars: JSON.parse(user.selected_calendars || '[]'),
  });
});
app.patch('/api/settings', requireAuth, async (req, res) => {
  const { todoist_token, ticktick_token, name, current_password, new_password, selected_calendars } = req.body;
  const updates=[]; const vals=[];
  if (name !== undefined) { updates.push('name=?'); vals.push(name); }
  if (todoist_token !== undefined) { updates.push('todoist_token=?'); vals.push(todoist_token || null); }
  if (ticktick_token !== undefined) { updates.push('ticktick_token=?'); vals.push(ticktick_token || null); }
  if (selected_calendars !== undefined) { updates.push('selected_calendars=?'); vals.push(JSON.stringify(selected_calendars)); }
  if (new_password && current_password) {
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.session.userId);
    if (user.password_hash) {
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    }
    updates.push('password_hash=?'); vals.push(await bcrypt.hash(new_password, 12));
  }
  if (updates.length) { vals.push(req.session.userId); db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...vals); }
  res.json({ ok: true });
});
app.post('/api/settings/disconnect', requireAuth, (req, res) => {
  const { service } = req.body;
  if (service === 'gcal') db.prepare('UPDATE users SET gcal_refresh_token=NULL, gcal_connected=0 WHERE id=?').run(req.session.userId);
  if (service === 'todoist') db.prepare('UPDATE users SET todoist_token=NULL WHERE id=?').run(req.session.userId);
  if (service === 'ticktick') db.prepare('UPDATE users SET ticktick_token=NULL WHERE id=?').run(req.session.userId);
  res.json({ ok: true });
});

// GCAL PER USER
function getUserGCal(userId) {
  const user = db.prepare('SELECT gcal_refresh_token,gcal_connected FROM users WHERE id=?').get(userId);
  if (!user?.gcal_connected || !user.gcal_refresh_token || !GCAL_CLIENT_ID) return null;
  const auth = new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: user.gcal_refresh_token });
  return google.calendar({ version: 'v3', auth });
}

function getGCalOAuth() {
  return new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, `${APP_URL}/api/gcal/callback`);
}

app.get('/api/gcal/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT gcal_connected FROM users WHERE id=?').get(req.session.userId);
  res.json({ configured: !!user?.gcal_connected });
});
app.get('/api/gcal/connect', requireAuth, (req, res) => {
  if (!GCAL_CLIENT_ID) return res.status(400).send('Google OAuth not configured');
  const auth = getGCalOAuth();
  const url = auth.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});
app.get('/api/gcal/callback', async (req, res) => {
  const { code } = req.query;
  if (!code || !req.session.userId) return res.redirect('/?settings=1&error=gcal_failed');
  try {
    const auth = getGCalOAuth();
    const { tokens } = await auth.getToken(code);
    const refreshToken = tokens.refresh_token || tokens.access_token;
    db.prepare('UPDATE users SET gcal_refresh_token=?, gcal_connected=1 WHERE id=?').run(refreshToken, req.session.userId);
    res.redirect('/?settings=1&gcal=connected');
  } catch(e) { console.error('GCal callback error:', e.message); res.redirect('/?settings=1&error=gcal_failed'); }
});

app.get('/api/gcal/calendars', requireAuth, async (req, res) => {
  const cal = getUserGCal(req.session.userId);
  if (!cal) return res.json([]);
  try {
    const user = db.prepare('SELECT selected_calendars FROM users WHERE id=?').get(req.session.userId);
    const selected = JSON.parse(user.selected_calendars || '[]');
    const { data } = await cal.calendarList.list({ maxResults: 100 });
    const calendars = (data.items || []).map(c => ({
      id: c.id,
      name: c.summary,
      backgroundColor: c.backgroundColor || '#c4922a',
      selected: selected.includes(c.id),
    }));
    res.json(calendars);
  } catch(e) { console.error('GCal calendars error:', e.message); res.json([]); }
});

app.get('/api/gcal/events', requireAuth, async (req, res) => {
  const cal = getUserGCal(req.session.userId);
  if (!cal) return res.json([]);
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const user = db.prepare('SELECT selected_calendars FROM users WHERE id=?').get(req.session.userId);
    const selected = JSON.parse(user.selected_calendars || '[]');
    // Get calendar colors for lookup
    let calColors = {};
    try {
      const { data: calList } = await cal.calendarList.list({ maxResults: 100 });
      (calList.items || []).forEach(c => { calColors[c.id] = c.backgroundColor || '#c4922a'; });
    } catch(e) {}

    const calIds = selected.length > 0 ? selected : ['primary'];
    const allEvents = [];
    for (const calId of calIds) {
      try {
        const { data } = await cal.events.list({
          calendarId: calId,
          timeMin: `${from}T00:00:00Z`,
          timeMax: `${to}T23:59:59Z`,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
        });
        (data.items || []).forEach(ev => {
          const start = ev.start?.date || ev.start?.dateTime?.slice(0,10);
          const end = ev.end?.date || ev.end?.dateTime?.slice(0,10);
          allEvents.push({
            id: ev.id,
            title: ev.summary || '(no title)',
            start,
            end,
            calendar_id: calId,
            color: calColors[calId] || '#c4922a',
            allDay: !!ev.start?.date,
            startTime: ev.start?.dateTime || null,
            endTime: ev.end?.dateTime || null,
          });
        });
      } catch(e) {}
    }
    res.json(allEvents);
  } catch(e) { console.error('GCal events error:', e.message); res.json([]); }
});

app.post('/api/gcal/sync', requireAuth, async (req, res) => {
  const cal = getUserGCal(req.session.userId);
  if (!cal) return res.status(400).json({ error: 'Google Calendar not connected. Go to Settings to connect.' });
  const tasks = db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.due_date IS NOT NULL AND t.is_done=0 AND t.parent_id IS NULL').all(req.session.userId).map(parseTask);
  const results = { created: 0, updated: 0, errors: [] };
  for (const task of tasks) {
    const tags=(task.tags||[]).length?`Tags: ${task.tags.map(t=>'#'+t).join(' ')}`:'';
    const notesStr=task.notes?`Notes: ${task.notes}`:'';
    const desc=[`${['','🔴 P1','🟠 P2','🟡 P3','⚪ P4'][task.priority]}`,`🍅 ${task.pomos||1}x25m`,task.proj_name?`Project: ${task.proj_name}`:'',tags,notesStr,'-- Irada'].filter(Boolean).join('\n');
    const event={summary:task.name,description:desc,start:{date:task.due_date},end:{date:task.due_date},colorId:task.priority===1?'11':task.priority===2?'6':'5'};
    try {
      if(task.gcal_event_id){await cal.events.update({calendarId:'primary',eventId:task.gcal_event_id,requestBody:event});results.updated++;}
      else{const r=await cal.events.insert({calendarId:'primary',requestBody:event});db.prepare('UPDATE tasks SET gcal_event_id=? WHERE id=?').run(r.data.id,task.id);results.created++;}
    } catch(err) {
      if(err.code===404||err.code===410){try{const r=await cal.events.insert({calendarId:'primary',requestBody:event});db.prepare('UPDATE tasks SET gcal_event_id=? WHERE id=?').run(r.data.id,task.id);results.created++;}catch(e){results.errors.push({task:task.name,error:e.message});}}
      else results.errors.push({task:task.name,error:err.message});
    }
  }
  res.json({ ok: true, ...results, total: tasks.length });
});

// TODOIST PER USER
async function tdReq(token, method, p, body) {
  if (!token) throw new Error('Todoist not connected');
  const r = await fetch(`https://api.todoist.com/rest/v2${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Todoist ${r.status}`);
  return r.json();
}
app.get('/api/todoist/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT todoist_token FROM users WHERE id=?').get(req.session.userId);
  res.json({ configured: !!user?.todoist_token });
});
app.post('/api/todoist/sync', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = db.prepare('SELECT todoist_token FROM users WHERE id=?').get(userId);
    if (!user?.todoist_token) return res.status(400).json({ error: 'Todoist not connected. Add your API token in Settings.' });
    const token = user.todoist_token;
    const [tdProjects,tdTasks] = await Promise.all([tdReq(token,'GET','/projects'),tdReq(token,'GET','/tasks')]);
    const tdProjByName=Object.fromEntries(tdProjects.map(p=>[p.name.toLowerCase(),p.id]));
    const tdProjById=Object.fromEntries(tdProjects.map(p=>[p.id,p.name]));
    let pushed=0,pulled=0;
    const localTasks=db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.parent_id IS NULL').all(userId).map(parseTask);
    for(const task of localTasks){
      let tdProjId=null;
      if(task.proj_name){tdProjId=tdProjByName[task.proj_name.toLowerCase()];if(!tdProjId){const np=await tdReq(token,'POST','/projects',{name:task.proj_name});tdProjId=np.id;tdProjByName[task.proj_name.toLowerCase()]=tdProjId;db.prepare('UPDATE projects SET todoist_project_id=? WHERE user_id=? AND name=?').run(tdProjId,userId,task.proj_name);}}
      const payload={content:task.name,description:task.notes||'',due_date:task.due_date||undefined,priority:task.priority===1?4:task.priority===2?3:task.priority===3?2:1,project_id:tdProjId||undefined,labels:task.tags||[]};
      if(task.is_done&&task.todoist_task_id){try{await tdReq(token,'POST',`/tasks/${task.todoist_task_id}/close`);}catch(e){}continue;}
      if(task.todoist_task_id){try{await tdReq(token,'POST',`/tasks/${task.todoist_task_id}`,payload);pushed++;}catch(e){if(e.message.includes('404')){const nc=await tdReq(token,'POST','/tasks',payload);db.prepare('UPDATE tasks SET todoist_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}}}
      else if(!task.is_done){const nc=await tdReq(token,'POST','/tasks',payload);db.prepare('UPDATE tasks SET todoist_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}
    }
    const existingTdIds=new Set(db.prepare('SELECT todoist_task_id FROM tasks WHERE user_id=? AND todoist_task_id IS NOT NULL').all(userId).map(r=>r.todoist_task_id));
    for(const tdt of tdTasks){
      if(existingTdIds.has(tdt.id))continue;
      let localProjId=null;
      if(tdt.project_id&&tdProjById[tdt.project_id]){const pname=tdProjById[tdt.project_id];let lp=db.prepare('SELECT id FROM projects WHERE user_id=? AND name=?').get(userId,pname);if(!lp){const nid=uid();db.prepare('INSERT INTO projects (id,user_id,name,color,todoist_project_id,sort_order) VALUES (?,?,?,?,?,?)').run(nid,userId,pname,'#6b7280',tdt.project_id,99);localProjId=nid;}else localProjId=lp.id;}
      const pri=tdt.priority===4?1:tdt.priority===3?2:tdt.priority===2?3:4;
      db.prepare('INSERT OR IGNORE INTO tasks (id,user_id,name,notes,due_date,priority,project_id,tags,is_done,pomos,todoist_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(uid(),userId,tdt.content,tdt.description||'',tdt.due?.date||null,pri,localProjId,JSON.stringify(tdt.labels||[]),0,1,tdt.id);
      pulled++;
    }
    res.json({ ok: true, pushed, pulled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TICKTICK PER USER
async function ttReq(token, method, p, body) {
  if (!token) throw new Error('TickTick not connected');
  const r = await fetch(`https://ticktick.com/open/v1${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`TickTick ${r.status}`);
  return r.json();
}
app.get('/api/ticktick/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT ticktick_token FROM users WHERE id=?').get(req.session.userId);
  res.json({ configured: !!user?.ticktick_token });
});
app.post('/api/ticktick/sync', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const user = db.prepare('SELECT ticktick_token FROM users WHERE id=?').get(userId);
    if (!user?.ticktick_token) return res.status(400).json({ error: 'TickTick not connected. Add your access token in Settings.' });
    const token = user.ticktick_token;
    const ttProjects = await ttReq(token,'GET','/project');
    const ttProjByName=Object.fromEntries((ttProjects||[]).map(p=>[p.name.toLowerCase(),p.id]));
    const ttProjById=Object.fromEntries((ttProjects||[]).map(p=>[p.id,p.name]));
    let pushed=0,pulled=0;
    const localTasks=db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.parent_id IS NULL AND t.is_done=0').all(userId).map(parseTask);
    for(const task of localTasks){
      let ttProjId=null;
      if(task.proj_name){ttProjId=ttProjByName[task.proj_name.toLowerCase()];if(!ttProjId){try{const np=await ttReq(token,'POST','/project',{name:task.proj_name});ttProjId=np.id;ttProjByName[task.proj_name.toLowerCase()]=ttProjId;}catch(e){}}}
      const pri=task.priority===1?5:task.priority===2?3:task.priority===3?1:0;
      const payload={title:task.name,content:task.notes||'',priority:pri,projectId:ttProjId||undefined,dueDate:task.due_date?task.due_date+'T00:00:00+0000':undefined,tags:task.tags||[]};
      if(task.ticktick_task_id){try{await ttReq(token,'POST',`/task/${task.ticktick_task_id}`,{...payload,id:task.ticktick_task_id});pushed++;}catch(e){if(e.message.includes('404')||e.message.includes('400')){try{const nc=await ttReq(token,'POST','/task',payload);db.prepare('UPDATE tasks SET ticktick_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}catch(e2){}}}}
      else{try{const nc=await ttReq(token,'POST','/task',payload);db.prepare('UPDATE tasks SET ticktick_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}catch(e){}}
    }
    const existingTtIds=new Set(db.prepare('SELECT ticktick_task_id FROM tasks WHERE user_id=? AND ticktick_task_id IS NOT NULL').all(userId).map(r=>r.ticktick_task_id));
    for(const proj of (ttProjects||[])){
      try{
        const projData=await ttReq(token,'GET',`/project/${proj.id}/data`);
        for(const ttt of (projData.tasks||[])){
          if(existingTtIds.has(ttt.id)||ttt.status===2)continue;
          let localProjId=null;
          if(ttt.projectId&&ttProjById[ttt.projectId]){const pname=ttProjById[ttt.projectId];let lp=db.prepare('SELECT id FROM projects WHERE user_id=? AND name=?').get(userId,pname);if(!lp){const nid=uid();db.prepare('INSERT INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(nid,userId,pname,'#6b7280',99);localProjId=nid;}else localProjId=lp.id;}
          const pri=ttt.priority>=5?1:ttt.priority>=3?2:ttt.priority>=1?3:4;
          db.prepare('INSERT OR IGNORE INTO tasks (id,user_id,name,notes,due_date,priority,project_id,tags,is_done,pomos,ticktick_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(uid(),userId,ttt.title,ttt.content||'',ttt.dueDate?ttt.dueDate.slice(0,10):null,pri,localProjId,JSON.stringify(ttt.tags||[]),0,1,ttt.id);
          pulled++;
        }
      }catch(e){}
    }
    res.json({ ok: true, pushed, pulled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SYNC ALL
app.post('/api/sync/all', requireAuth, async (req, res) => {
  const results = { todoist: null, ticktick: null, gcal: null };
  const userId = req.session.userId;
  const user = db.prepare('SELECT todoist_token,ticktick_token,gcal_connected FROM users WHERE id=?').get(userId);
  const cookie = req.headers.cookie || '';
  const base = `http://localhost:${PORT}`;
  if (user?.todoist_token) { try { const r=await fetch(`${base}/api/todoist/sync`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie}}); results.todoist=await r.json(); } catch(e){results.todoist={error:e.message};} }
  if (user?.ticktick_token) { try { const r=await fetch(`${base}/api/ticktick/sync`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie}}); results.ticktick=await r.json(); } catch(e){results.ticktick={error:e.message};} }
  if (user?.gcal_connected) { try { const r=await fetch(`${base}/api/gcal/sync`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie}}); results.gcal=await r.json(); } catch(e){results.gcal={error:e.message};} }
  res.json({ ok: true, ...results });
});

// PROJECTS
app.get('/api/projects', requireAuth, (req, res) => {
  const projects=db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  const sections=db.prepare('SELECT * FROM sections WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  res.json(projects.map(p=>({...p,sections:sections.filter(s=>s.project_id===p.id).map(s=>({...s,is_open:!!s.is_open}))})));
});
app.post('/api/projects', requireAuth, (req, res) => {
  const {id,name,color}=req.body;
  db.prepare('INSERT INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(id,req.session.userId,name,color||'#c4922a',db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=?').get(req.session.userId).c);
  res.json({ok:true});
});
app.delete('/api/projects/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });

// SECTIONS
app.post('/api/sections', requireAuth, (req, res) => {
  const {id,project_id,name}=req.body;
  db.prepare('INSERT INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(id,project_id,req.session.userId,name,db.prepare('SELECT COUNT(*) as c FROM sections WHERE project_id=?').get(project_id).c);
  res.json({ok:true});
});
app.patch('/api/sections/:id', requireAuth, (req, res) => { db.prepare('UPDATE sections SET is_open=? WHERE id=? AND user_id=?').run(req.body.is_open?1:0,req.params.id,req.session.userId); res.json({ok:true}); });
app.delete('/api/sections/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE tasks SET section_id=NULL WHERE section_id=? AND user_id=?').run(req.params.id,req.session.userId);
  db.prepare('DELETE FROM sections WHERE id=? AND user_id=?').run(req.params.id,req.session.userId);
  res.json({ok:true});
});

// TASKS
app.get('/api/tasks', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY priority,due_date,created_at').all(req.session.userId).map(parseTask)));
app.post('/api/tasks', requireAuth, (req, res) => {
  const {id,name,notes,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos,parent_id}=req.body;
  db.prepare('INSERT INTO tasks (id,user_id,parent_id,name,notes,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,req.session.userId,parent_id||null,name,notes||'',due_date||null,priority||3,project_id||null,section_id||null,JSON.stringify(tags||[]),is_urgent?1:0,is_important?1:0,pomos||1,db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id=?').get(req.session.userId).c);
  res.json({ok:true});
});
app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const t=req.body;
  db.prepare(`UPDATE tasks SET name=COALESCE(?,name),notes=COALESCE(?,notes),due_date=?,priority=COALESCE(?,priority),project_id=?,section_id=?,tags=COALESCE(?,tags),is_done=COALESCE(?,is_done),is_urgent=COALESCE(?,is_urgent),is_important=COALESCE(?,is_important),pomos=COALESCE(?,pomos),today_pick=COALESCE(?,today_pick) WHERE id=? AND user_id=?`).run(t.name??null,t.notes??null,'due_date'in t?(t.due_date||null):undefined,t.priority??null,'project_id'in t?(t.project_id||null):undefined,'section_id'in t?(t.section_id||null):undefined,t.tags?JSON.stringify(t.tags):null,t.is_done!==undefined?(t.is_done?1:0):null,t.is_urgent!==undefined?(t.is_urgent?1:0):null,t.is_important!==undefined?(t.is_important?1:0):null,t.pomos??null,t.today_pick!==undefined?(t.today_pick?1:0):null,req.params.id,req.session.userId);
  res.json({ok:true});
});
app.delete('/api/tasks/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });

// HABITS
app.get('/api/habits', requireAuth, (req, res) => {
  const habits=db.prepare('SELECT * FROM habits WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  const logs=db.prepare('SELECT hl.* FROM habit_logs hl JOIN habits h ON hl.habit_id=h.id WHERE h.user_id=?').all(req.session.userId);
  res.json(habits.map(h=>({...h,log:Object.fromEntries(logs.filter(l=>l.habit_id===h.id).map(l=>[l.log_date,true]))})));
});
app.post('/api/habits', requireAuth, (req, res) => { const {id,emoji,name}=req.body; db.prepare('INSERT INTO habits (id,user_id,emoji,name,sort_order) VALUES (?,?,?,?,?)').run(id,req.session.userId,emoji||'🌱',name,db.prepare('SELECT COUNT(*) as c FROM habits WHERE user_id=?').get(req.session.userId).c); res.json({ok:true}); });
app.patch('/api/habits/:id', requireAuth, (req, res) => { db.prepare('UPDATE habits SET emoji=COALESCE(?,emoji),name=COALESCE(?,name) WHERE id=? AND user_id=?').run(req.body.emoji||null,req.body.name||null,req.params.id,req.session.userId); res.json({ok:true}); });
app.delete('/api/habits/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM habits WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });
app.post('/api/habits/:id/log', requireAuth, (req, res) => {
  const {date,done}=req.body;
  if(done) db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id,log_date) VALUES (?,?)').run(req.params.id,date);
  else db.prepare('DELETE FROM habit_logs WHERE habit_id=? AND log_date=?').run(req.params.id,date);
  res.json({ok:true});
});

// WAITLIST
db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
app.post('/api/waitlist', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  try {
    db.prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?)').run(email.toLowerCase().trim());
    console.log(`Waitlist signup: ${email}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Could not save email' }); }
});

// ROUTING
// / → landing for guests, app for logged-in users
app.get('/', (req, res) => {
  if (req.session.userId) {
    const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.session.userId);
    if (user) return res.sendFile(path.join(__dirname,'public','index.html'));
  }
  res.sendFile(path.join(__dirname,'public','landing.html'));
});
// /login → always serve the app shell (handles ?reset= and other URL params)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
// Everything else → app (handles /?reset=token, /?settings=1, etc.)
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => console.log(`Irada running at http://localhost:${PORT}`));
