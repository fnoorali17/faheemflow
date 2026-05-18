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
    last_login_date TEXT, theme TEXT DEFAULT 'light',
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
    sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
    is_deleted INTEGER DEFAULT 0, deleted_at TEXT
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
  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_date TEXT NOT NULL,
    title TEXT,
    body TEXT NOT NULL DEFAULT '',
    mood TEXT,
    word_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    organization TEXT,
    role TEXT,
    email TEXT,
    phone TEXT,
    type TEXT DEFAULT 'professional',
    notes TEXT DEFAULT '',
    follow_up_date TEXT,
    follow_up_frequency INTEGER,
    last_contacted TEXT,
    status TEXT DEFAULT 'active',
    avatar_color TEXT DEFAULT '#c4922a',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    notes TEXT DEFAULT '',
    linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now'))
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
  'ALTER TABLE users ADD COLUMN theme TEXT DEFAULT \'light\'',
  'ALTER TABLE tasks ADD COLUMN notes TEXT DEFAULT ""',
  'ALTER TABLE tasks ADD COLUMN ticktick_task_id TEXT',
  'ALTER TABLE tasks ADD COLUMN is_deleted INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN deleted_at TEXT',
  'ALTER TABLE tasks ADD COLUMN in_matrix INTEGER DEFAULT 1',
  'ALTER TABLE users ADD COLUMN user_project_mappings TEXT DEFAULT \'[]\'',
  'ALTER TABLE tasks ADD COLUMN linked_person_id TEXT',
  'ALTER TABLE projects ADD COLUMN ticktick_project_id TEXT',
  'ALTER TABLE sections ADD COLUMN ticktick_section_id TEXT',
  'ALTER TABLE users ADD COLUMN ticktick_inbox_project_id TEXT',
  "ALTER TABLE users ADD COLUMN font_size TEXT DEFAULT 'default'",
].forEach(sql => { try { db.exec(sql); } catch(e) {} });

// Cleanup: permanently delete tasks soft-deleted more than 30 days ago
try {
  const cutoff30 = new Date(Date.now() - 30*24*60*60*1000).toISOString();
  const cleaned = db.prepare('DELETE FROM tasks WHERE is_deleted=1 AND deleted_at < ?').run(cutoff30);
  if (cleaned.changes > 0) console.log(`Cleanup: permanently removed ${cleaned.changes} task(s) deleted before ${cutoff30.slice(0,10)}`);
} catch(e) { console.error('Cleanup error:', e.message); }

app.use(cors());
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 30*24*60*60*1000, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const today = () => new Date().toISOString().slice(0, 10);
const stripEmoji = s => (s||'').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu,'').replace(/\s+/g,' ').trim();
const parseTask = row => ({
  ...row, tags: JSON.parse(row.tags || '[]'),
  is_done: !!row.is_done, is_urgent: !!row.is_urgent,
  is_important: !!row.is_important, today_pick: !!row.today_pick,
  is_deleted: !!row.is_deleted,
  in_matrix: row.in_matrix === undefined ? 1 : (row.in_matrix === 0 ? 0 : 1),
  notes: row.notes || '',
});

function personStatus(p) {
  const t = today();
  const diffDays = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
  if (p.follow_up_date) {
    const d = diffDays(p.follow_up_date, t);
    if (d < 0) return { follow_up_status: 'overdue', follow_up_status_label: 'Overdue', days_until_followup: d };
    if (d <= 7) return { follow_up_status: 'due_soon', follow_up_status_label: 'Due soon', days_until_followup: d };
    return { follow_up_status: 'upcoming', follow_up_status_label: 'Upcoming', days_until_followup: d };
  }
  if (p.last_contacted) {
    const d = diffDays(t, p.last_contacted);
    if (d > 90) return { follow_up_status: 'dormant', follow_up_status_label: 'Dormant', days_since_contact: d };
    return { follow_up_status: 'active', follow_up_status_label: 'Active', days_since_contact: d };
  }
  return { follow_up_status: 'never', follow_up_status_label: 'Not yet contacted' };
}

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
      'SELECT * FROM tasks WHERE user_id=? AND today_pick=1 AND is_done=0 AND parent_id IS NULL AND (is_deleted=0 OR is_deleted IS NULL)'
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
    theme: user.theme || 'light',
    font_size: user.font_size || 'default',
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
  if (!code) return res.redirect('/login?error=oauth_failed');
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
    res.redirect(isNew ? '/login?settings=1' : '/login');
  } catch(e) { console.error('Google OAuth error:', e.message); res.redirect('/login?error=oauth_failed'); }
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
  const user = db.prepare('SELECT id,name,email,gcal_connected,todoist_token,ticktick_token,selected_calendars,theme,user_project_mappings,ticktick_inbox_project_id,font_size FROM users WHERE id=?').get(req.session.userId);
  const projects = db.prepare('SELECT id,name FROM projects WHERE user_id=? ORDER BY sort_order,name').all(req.session.userId);
  res.json({
    ...user,
    gcal_connected: !!user.gcal_connected,
    has_todoist: !!user.todoist_token,
    has_ticktick: !!user.ticktick_token,
    selected_calendars: JSON.parse(user.selected_calendars || '[]'),
    theme: user.theme || 'light',
    font_size: user.font_size || 'default',
    project_mappings: JSON.parse(user.user_project_mappings || '[]'),
    ticktick_inbox_project_id: user.ticktick_inbox_project_id || null,
    projects,
  });
});
app.patch('/api/settings', requireAuth, async (req, res) => {
  const { todoist_token, ticktick_token, name, current_password, new_password, selected_calendars, theme, project_mappings, ticktick_inbox_project_id, font_size } = req.body;
  const updates=[]; const vals=[];
  if (name !== undefined) { updates.push('name=?'); vals.push(name); }
  if (todoist_token !== undefined) { updates.push('todoist_token=?'); vals.push(todoist_token || null); }
  if (ticktick_token !== undefined) { updates.push('ticktick_token=?'); vals.push(ticktick_token || null); }
  if (selected_calendars !== undefined) { updates.push('selected_calendars=?'); vals.push(JSON.stringify(selected_calendars)); }
  if (theme !== undefined) { updates.push('theme=?'); vals.push(theme === 'dark' ? 'dark' : 'light'); }
  if (project_mappings !== undefined) { updates.push('user_project_mappings=?'); vals.push(JSON.stringify(Array.isArray(project_mappings)?project_mappings:[])); }
  if (ticktick_inbox_project_id !== undefined) { updates.push('ticktick_inbox_project_id=?'); vals.push(ticktick_inbox_project_id || null); }
  if (font_size !== undefined) { updates.push('font_size=?'); vals.push(['small','default','large','xlarge'].includes(font_size)?font_size:'default'); }
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
  if (!code || !req.session.userId) return res.redirect('/login?error=gcal_failed');
  try {
    const auth = getGCalOAuth();
    const { tokens } = await auth.getToken(code);
    const refreshToken = tokens.refresh_token || tokens.access_token;
    db.prepare('UPDATE users SET gcal_refresh_token=?, gcal_connected=1 WHERE id=?').run(refreshToken, req.session.userId);
    res.redirect('/login?settings=1&gcal=connected');
  } catch(e) { console.error('GCal callback error:', e.message); res.redirect('/login?settings=1&error=gcal_failed'); }
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
  const tasks = db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.due_date IS NOT NULL AND t.is_done=0 AND t.parent_id IS NULL AND (t.is_deleted=0 OR t.is_deleted IS NULL)').all(req.session.userId).map(parseTask);
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
    const tdProjByName=Object.fromEntries(tdProjects.map(p=>[stripEmoji(p.name).toLowerCase(),p.id]));
    const tdProjById=Object.fromEntries(tdProjects.map(p=>[p.id,stripEmoji(p.name)]));
    let pushed=0,pulled=0;
    const localTasks=db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.parent_id IS NULL AND (t.is_deleted=0 OR t.is_deleted IS NULL)').all(userId).map(parseTask);
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
    const user = db.prepare('SELECT ticktick_token,ticktick_inbox_project_id FROM users WHERE id=?').get(userId);
    if (!user?.ticktick_token) return res.status(400).json({ error: 'TickTick not connected. Add your access token in Settings.' });
    const token = user.ticktick_token;
    const inboxProjId = user.ticktick_inbox_project_id || null;
    const ttProjects = await ttReq(token,'GET','/project');
    const ttProjByName=Object.fromEntries((ttProjects||[]).map(p=>[stripEmoji(p.name).toLowerCase(),p.id]));
    // Map id → original name with emoji (for display/storage); stripped used only in WHERE matching
    const ttProjById=Object.fromEntries((ttProjects||[]).map(p=>[p.id,p.name]));
    // Pre-fetch all project data (tasks + columns) once
    const ttProjData={};
    for(const proj of (ttProjects||[])){
      try{
        const data=await ttReq(token,'GET',`/project/${proj.id}/data`);
        // Log full response shape to diagnose field names
        console.log('TT /data for project', proj.id, proj.name, '→',
          'tasks:', data.tasks?.length??0,
          'columns:', data.columns?.length??'MISSING',
          'response keys:', Object.keys(data).join(', '),
          'first column sample:', JSON.stringify(data.columns?.[0]||data.column?.[0]||data.lists?.[0]||null)
        );
        // Try multiple possible field names TickTick might use
        const cols=data.columns||data.column||data.lists||data.sections||data.kanbanColumns||[];
        // Normalise column objects — field names may vary
        const normalizeCol=(c)=>({id:c.id||c.columnId||c.listId,name:c.name||c.title||c.columnName||''});
        const normalizedCols=cols.map(normalizeCol).filter(c=>c.id);
        ttProjData[proj.id]={
          tasks:data.tasks||[],
          cols:normalizedCols,
          colById:Object.fromEntries(normalizedCols.map(c=>[c.id,stripEmoji(c.name)])),
          colByName:Object.fromEntries(normalizedCols.map(c=>[stripEmoji(c.name).toLowerCase(),c.id]))
        };
        if(normalizedCols.length>0){
          console.log('TT columns found for', proj.name, ':', normalizedCols.map(c=>c.name).join(', '));
        } else {
          console.warn('TT NO COLUMNS for project:', proj.name, '— full response keys:', Object.keys(data).join(', '));
        }
      }catch(e){
        console.error('TT /data fetch FAILED for project', proj.id, proj.name, ':', e.message);
        ttProjData[proj.id]={tasks:[],cols:[],colById:{},colByName:{}};
      }
    }
    // SECTION CREATION PASS: ensure all TickTick columns exist as Irada sections
    // before processing tasks so the per-task lookup is a simple ID lookup.
    let sectionsCreated=0;
    for(const [ttProjId,pd] of Object.entries(ttProjData)){
      if(!pd.cols.length)continue;
      const ttProjName=ttProjById[ttProjId];
      // Prefer ticktick_project_id match; fall back to name
      let localProj=db.prepare('SELECT id FROM projects WHERE user_id=? AND ticktick_project_id=?').get(userId,ttProjId);
      if(!localProj&&ttProjName){
        // Match on original emoji name OR stripped — handles previously-stripped imports
        localProj=db.prepare('SELECT id FROM projects WHERE user_id=? AND (LOWER(name)=LOWER(?) OR LOWER(name)=LOWER(?))').get(userId,ttProjName,stripEmoji(ttProjName));
        if(localProj)db.prepare('UPDATE projects SET ticktick_project_id=? WHERE id=?').run(ttProjId,localProj.id);
      }
      if(!localProj)continue;
      for(const col of pd.cols){
        if(!col.id||!col.name)continue;
        if(col.name.toLowerCase()==='not sectioned')continue;
        let sec=db.prepare('SELECT id,ticktick_section_id FROM sections WHERE user_id=? AND project_id=? AND ticktick_section_id=?').get(userId,localProj.id,col.id);
        if(!sec)sec=db.prepare('SELECT id,ticktick_section_id FROM sections WHERE user_id=? AND project_id=? AND (LOWER(name)=LOWER(?) OR LOWER(name)=LOWER(?))').get(userId,localProj.id,col.name,stripEmoji(col.name));
        if(!sec){
          const sid=uid();
          const cnt=db.prepare('SELECT COUNT(*) as c FROM sections WHERE project_id=?').get(localProj.id).c;
          db.prepare('INSERT INTO sections (id,project_id,user_id,name,sort_order,is_open,ticktick_section_id) VALUES (?,?,?,?,?,?,?)').run(sid,localProj.id,userId,col.name,cnt,1,col.id);
          console.log('TT created section:',col.name,'in project',localProj.id);
          sectionsCreated++;
        }else if(!sec.ticktick_section_id){
          db.prepare('UPDATE sections SET ticktick_section_id=? WHERE id=?').run(col.id,sec.id);
          console.log('TT backfilled ticktick_section_id for:',col.name);
        }
      }
    }
    if(sectionsCreated>0)console.log('TT section creation pass: created',sectionsCreated,'sections');

    let pushed=0,pulled=0;
    // PUSH: local → TickTick (with section → column mapping)
    const localTasks=db.prepare('SELECT t.*,p.name as proj_name,s.name as sec_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id LEFT JOIN sections s ON t.section_id=s.id WHERE t.user_id=? AND t.parent_id IS NULL AND t.is_done=0 AND (t.is_deleted=0 OR t.is_deleted IS NULL)').all(userId).map(parseTask);
    for(const task of localTasks){
      let ttProjId=null;
      if(task.proj_name){ttProjId=ttProjByName[task.proj_name.toLowerCase()];if(!ttProjId){try{const np=await ttReq(token,'POST','/project',{name:task.proj_name});ttProjId=np.id;ttProjByName[task.proj_name.toLowerCase()]=ttProjId;ttProjData[ttProjId]={tasks:[],cols:[],colById:{},colByName:{}};}catch(e){}}}
      let ttColId=null;
      if(task.sec_name&&ttProjId&&ttProjData[ttProjId]){
        const secKey=stripEmoji(task.sec_name).toLowerCase();
        ttColId=ttProjData[ttProjId].colByName[secKey];
        if(!ttColId){try{const nc=await ttReq(token,'POST',`/project/${ttProjId}/section`,{name:task.sec_name});if(nc?.id){ttColId=nc.id;ttProjData[ttProjId].colByName[secKey]=ttColId;ttProjData[ttProjId].colById[ttColId]=task.sec_name;}}catch(e){}}
      }
      const pri=task.priority===1?5:task.priority===2?3:task.priority===3?1:0;
      const payload={title:task.name,content:task.notes||'',priority:pri,projectId:ttProjId||undefined,dueDate:task.due_date?task.due_date+'T00:00:00+0000':undefined,tags:task.tags||[]};
      if(ttColId)payload.columnId=ttColId;
      if(task.ticktick_task_id){try{await ttReq(token,'POST',`/task/${task.ticktick_task_id}`,{...payload,id:task.ticktick_task_id});pushed++;}catch(e){if(e.message.includes('404')||e.message.includes('400')){try{const nc=await ttReq(token,'POST','/task',payload);db.prepare('UPDATE tasks SET ticktick_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}catch(e2){}}}}
      else{try{const nc=await ttReq(token,'POST','/task',payload);db.prepare('UPDATE tasks SET ticktick_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;}catch(e){}}
    }
    // PULL: TickTick → local (using pre-fetched data, map columns → sections)
    const existingTtIds=new Set(db.prepare('SELECT ticktick_task_id FROM tasks WHERE user_id=? AND ticktick_task_id IS NOT NULL').all(userId).map(r=>r.ticktick_task_id));
    for(const proj of (ttProjects||[])){
      const pd=ttProjData[proj.id]||{tasks:[],colById:{}};
      for(const ttt of pd.tasks){
        if(existingTtIds.has(ttt.id)||ttt.status===2)continue;
        let localProjId=null;
        if(!ttt.projectId){
          // Inbox task — route to user's configured inbox destination
          localProjId=inboxProjId;
          console.log('TT inbox task:',ttt.title,'→ project:',inboxProjId||'unassigned');
        } else if(ttt.projectId&&ttProjById[ttt.projectId]){const pname=ttProjById[ttt.projectId];let lp=db.prepare('SELECT id FROM projects WHERE user_id=? AND (ticktick_project_id=? OR LOWER(name)=LOWER(?) OR LOWER(name)=LOWER(?))').get(userId,ttt.projectId,pname,stripEmoji(pname));if(!lp){const nid=uid();db.prepare('INSERT INTO projects (id,user_id,name,color,ticktick_project_id,sort_order) VALUES (?,?,?,?,?,?)').run(nid,userId,pname,'#6b7280',ttt.projectId,99);localProjId=nid;}else{if(!lp.ticktick_project_id)db.prepare('UPDATE projects SET ticktick_project_id=? WHERE id=?').run(ttt.projectId,lp.id);localProjId=lp.id;}}
        // Section lookup: sections were created upfront in the creation pass above,
        // so this is now a direct ticktick_section_id lookup — no creation needed here.
        const taskColumnId=ttt.columnId||ttt.column_id||ttt.listId||ttt.sectionId||null;
        let localSecId=null;
        if(taskColumnId&&localProjId){
          const sec=db.prepare('SELECT id FROM sections WHERE user_id=? AND project_id=? AND ticktick_section_id=?').get(userId,localProjId,taskColumnId);
          if(sec)localSecId=sec.id;
          else console.warn('TT task "'+ttt.title+'" — no section for columnId:',taskColumnId,'in project:',localProjId);
        }
        const pri=ttt.priority>=5?1:ttt.priority>=3?2:ttt.priority>=1?3:4;
        db.prepare('INSERT OR IGNORE INTO tasks (id,user_id,name,notes,due_date,priority,project_id,section_id,tags,is_done,pomos,ticktick_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(uid(),userId,ttt.title,ttt.content||'',ttt.dueDate?ttt.dueDate.slice(0,10):null,pri,localProjId,localSecId,JSON.stringify(ttt.tags||[]),0,1,ttt.id);
        pulled++;
      }
    }
    res.json({ok:true,pushed,pulled});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TICKTICK IMPORT STRUCTURE
const TT_PALETTE=['#8b5cf6','#3b82f6','#22c55e','#f97316','#ec4899','#c4922a','#1e5c5c'];
const normalizeCol=(c)=>({id:c.id||c.columnId||c.listId,name:c.name||c.title||c.columnName||''});
app.post('/api/ticktick/import-structure', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT ticktick_token FROM users WHERE id=?').get(req.session.userId);
  if (!user?.ticktick_token) return res.status(400).json({ error: 'TickTick not connected' });
  const token = user.ticktick_token;
  try {
    const ttProjects = await ttReq(token,'GET','/project');
    const existingProjs = db.prepare('SELECT * FROM projects WHERE user_id=?').all(req.session.userId);
    const toCreateProjs=[],toCreateSecs=[];
    let colorIdx=existingProjs.length;
    // Build forward-map: ttId → local project id (covers both id-matched and name-matched)
    const ttProjToLocal={};
    existingProjs.forEach(p=>{ if(p.ticktick_project_id) ttProjToLocal[p.ticktick_project_id]=p.id; });
    for(const proj of (ttProjects||[])){
      const pname=proj.name;                        // original with emoji — used for storage
      const pnameStripped=stripEmoji(proj.name);    // stripped — used only for matching
      // Match by ticktick_project_id first, then by name (try both emoji and stripped)
      let existing=existingProjs.find(p=>p.ticktick_project_id===proj.id);
      if(!existing)existing=existingProjs.find(p=>stripEmoji(p.name).toLowerCase()===pnameStripped.toLowerCase());
      if(existing&&!ttProjToLocal[proj.id])ttProjToLocal[proj.id]=existing.id;
      if(!existing)toCreateProjs.push({ttId:proj.id,name:pname,color:TT_PALETTE[colorIdx++%TT_PALETTE.length]});
      const localProjId=existing?.id||null;
      try{
        const data=await ttReq(token,'GET',`/project/${proj.id}/data`);
        // Same column normalization as sync route — try multiple field names
        const rawCols=data.columns||data.column||data.lists||data.sections||data.kanbanColumns||[];
        const cols=rawCols.map(normalizeCol).filter(c=>c.id&&c.name&&c.name.toLowerCase()!=='not sectioned');
        const existingSecs=localProjId?db.prepare('SELECT * FROM sections WHERE user_id=? AND project_id=?').all(req.session.userId,localProjId):[];
        for(const col of cols){
          const cname=col.name;                       // original with emoji — used for storage
          const cnameStripped=stripEmoji(col.name);   // stripped — used only for matching
          const existingSec=existingSecs.find(s=>s.ticktick_section_id===col.id||stripEmoji(s.name).toLowerCase()===cnameStripped.toLowerCase());
          if(!existingSec)toCreateSecs.push({ttId:col.id,ttProjId:proj.id,name:cname});
        }
      }catch(e){console.error('import-structure /data failed for',proj.id,proj.name,':',e.message);}
    }
    if(req.body.apply){
      // Create missing projects first
      toCreateProjs.forEach(pp=>{
        const nid=uid();
        const cnt=db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=?').get(req.session.userId).c;
        db.prepare('INSERT INTO projects (id,user_id,name,color,ticktick_project_id,sort_order) VALUES (?,?,?,?,?,?)').run(nid,req.session.userId,pp.name,pp.color,pp.ttId,cnt);
        ttProjToLocal[pp.ttId]=nid;
      });
      // Backfill ticktick_project_id on name-matched projects that don't have it yet
      existingProjs.forEach(p=>{
        if(!p.ticktick_project_id){
          const ttProj=ttProjects.find(tp=>stripEmoji(tp.name).toLowerCase()===stripEmoji(p.name).toLowerCase());
          if(ttProj)db.prepare('UPDATE projects SET ticktick_project_id=? WHERE id=?').run(ttProj.id,p.id);
        }
      });
      // Create missing sections
      let secCount=0;
      toCreateSecs.forEach(ss=>{
        const lpid=ttProjToLocal[ss.ttProjId];if(!lpid)return;
        const cnt=db.prepare('SELECT COUNT(*) as c FROM sections WHERE project_id=?').get(lpid).c;
        const sid=uid();
        db.prepare('INSERT INTO sections (id,project_id,user_id,name,ticktick_section_id,is_open,sort_order) VALUES (?,?,?,?,?,?,?)').run(sid,lpid,req.session.userId,ss.name,ss.ttId,1,cnt);
        secCount++;
      });
      return res.json({ok:true,projectsCreated:toCreateProjs.length,sectionsCreated:secCount});
    }
    res.json({ok:true,projects:toCreateProjs,sections:toCreateSecs});
  }catch(e){res.status(500).json({error:e.message});}
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
app.patch('/api/sections/:id', requireAuth, (req, res) => {
  const {is_open, name} = req.body;
  if (is_open !== undefined) db.prepare('UPDATE sections SET is_open=? WHERE id=? AND user_id=?').run(is_open?1:0,req.params.id,req.session.userId);
  if (name !== undefined && name.trim()) db.prepare('UPDATE sections SET name=? WHERE id=? AND user_id=?').run(name.trim(),req.params.id,req.session.userId);
  res.json({ok:true});
});
app.delete('/api/sections/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE tasks SET section_id=NULL WHERE section_id=? AND user_id=?').run(req.params.id,req.session.userId);
  db.prepare('DELETE FROM sections WHERE id=? AND user_id=?').run(req.params.id,req.session.userId);
  res.json({ok:true});
});
app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const {name, color} = req.body;
  const upd=[]; const vals=[];
  if (name !== undefined) { upd.push('name=?'); vals.push(name); }
  if (color !== undefined) { upd.push('color=?'); vals.push(color); }
  if (upd.length) { vals.push(req.params.id, req.session.userId); db.prepare(`UPDATE projects SET ${upd.join(',')} WHERE id=? AND user_id=?`).run(...vals); }
  res.json({ok:true});
});
app.patch('/api/sections/:id/rename', requireAuth, (req, res) => {
  const {name} = req.body;
  if (!name) return res.status(400).json({error:'name required'});
  db.prepare('UPDATE sections SET name=? WHERE id=? AND user_id=?').run(name, req.params.id, req.session.userId);
  res.json({ok:true});
});
app.post('/api/projects/reorder', requireAuth, (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({error:'Array required'});
  db.transaction(() => { items.forEach(({id,sort_order}) => db.prepare('UPDATE projects SET sort_order=? WHERE id=? AND user_id=?').run(sort_order,id,req.session.userId)); })();
  res.json({ok:true});
});
app.post('/api/sections/reorder', requireAuth, (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) return res.status(400).json({error:'Array required'});
  db.transaction(() => { items.forEach(({id,sort_order}) => db.prepare('UPDATE sections SET sort_order=? WHERE id=? AND user_id=?').run(sort_order,id,req.session.userId)); })();
  res.json({ok:true});
});

// TASKS
app.get('/api/tasks', requireAuth, (req, res) => res.json(db.prepare('SELECT t.*, per.name as linked_person_name FROM tasks t LEFT JOIN people per ON t.linked_person_id=per.id WHERE t.user_id=? AND (t.is_deleted=0 OR t.is_deleted IS NULL) ORDER BY t.priority,t.due_date,t.created_at').all(req.session.userId).map(parseTask)));
app.get('/api/tasks/deleted', requireAuth, (req, res) => {
  const cutoff = new Date(Date.now() - 30*24*60*60*1000).toISOString();
  res.json(db.prepare('SELECT * FROM tasks WHERE user_id=? AND is_deleted=1 AND (deleted_at IS NULL OR deleted_at > ?) ORDER BY deleted_at DESC').all(req.session.userId, cutoff).map(parseTask));
});
app.post('/api/tasks', requireAuth, (req, res) => {
  const {id,name,notes,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos,parent_id}=req.body;
  db.prepare('INSERT INTO tasks (id,user_id,parent_id,name,notes,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,req.session.userId,parent_id||null,name,notes||'',due_date||null,priority||3,project_id||null,section_id||null,JSON.stringify(tags||[]),is_urgent?1:0,is_important?1:0,pomos||1,db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id=?').get(req.session.userId).c);
  res.json({ok:true});
});
app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const t=req.body;
  db.prepare(`UPDATE tasks SET name=COALESCE(?,name),notes=COALESCE(?,notes),due_date=?,priority=COALESCE(?,priority),project_id=?,section_id=?,tags=COALESCE(?,tags),is_done=COALESCE(?,is_done),is_urgent=COALESCE(?,is_urgent),is_important=COALESCE(?,is_important),pomos=COALESCE(?,pomos),today_pick=COALESCE(?,today_pick),in_matrix=COALESCE(?,in_matrix) WHERE id=? AND user_id=?`).run(t.name??null,t.notes??null,'due_date'in t?(t.due_date||null):undefined,t.priority??null,'project_id'in t?(t.project_id||null):undefined,'section_id'in t?(t.section_id||null):undefined,t.tags?JSON.stringify(t.tags):null,t.is_done!==undefined?(t.is_done?1:0):null,t.is_urgent!==undefined?(t.is_urgent?1:0):null,t.is_important!==undefined?(t.is_important?1:0):null,t.pomos??null,t.today_pick!==undefined?(t.today_pick?1:0):null,t.in_matrix!==undefined?(t.in_matrix?1:0):null,req.params.id,req.session.userId);
  res.json({ok:true});
});
app.post('/api/tasks/:id/restore', requireAuth, (req, res) => {
  db.prepare('UPDATE tasks SET is_deleted=0, deleted_at=NULL WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  db.prepare('UPDATE tasks SET is_deleted=0, deleted_at=NULL WHERE parent_id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ok:true});
});
app.delete('/api/tasks/:id/permanent', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ok:true});
});
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const ts = new Date().toISOString();
  db.prepare('UPDATE tasks SET is_deleted=1, deleted_at=? WHERE id=? AND user_id=?').run(ts, req.params.id, req.session.userId);
  db.prepare('UPDATE tasks SET is_deleted=1, deleted_at=? WHERE parent_id=? AND user_id=?').run(ts, req.params.id, req.session.userId);
  res.json({ok:true});
});

// JOURNAL
app.get('/api/journal', requireAuth, (req, res) => {
  const entries = db.prepare('SELECT * FROM journal_entries WHERE user_id=? ORDER BY entry_date DESC, created_at DESC').all(req.session.userId);
  res.json(entries);
});
app.get('/api/journal/date/:date', requireAuth, (req, res) => {
  const entry = db.prepare('SELECT * FROM journal_entries WHERE user_id=? AND entry_date=?').get(req.session.userId, req.params.date);
  res.json(entry || null);
});
app.post('/api/journal', requireAuth, (req, res) => {
  const { entry_date, title, body, mood } = req.body;
  if (!entry_date) return res.status(400).json({ error: 'entry_date required' });
  const word_count = (body || '').trim().split(/\s+/).filter(Boolean).length;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM journal_entries WHERE user_id=? AND entry_date=?').get(req.session.userId, entry_date);
  if (existing) {
    db.prepare('UPDATE journal_entries SET title=?, body=?, mood=?, word_count=?, updated_at=? WHERE id=? AND user_id=?').run(title||null, body||'', mood||null, word_count, now, existing.id, req.session.userId);
    res.json({ ok: true, id: existing.id });
  } else {
    const eid = uid();
    db.prepare('INSERT INTO journal_entries (id,user_id,entry_date,title,body,mood,word_count) VALUES (?,?,?,?,?,?,?)').run(eid, req.session.userId, entry_date, title||null, body||'', mood||null, word_count);
    res.json({ ok: true, id: eid });
  }
});
app.delete('/api/journal/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM journal_entries WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

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

// ADMIN: test email
app.get('/admin/test-email', async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const ok = await sendEmail('FNoorali@gmail.com', 'Irada test email',
    `<p style="font-family:sans-serif;font-size:15px;color:#1a1714">Test email from Irada. Resend is working.</p>`
  );
  res.json({ ok, resend_key_set: !!RESEND_API_KEY, from: FROM_EMAIL });
});

// PEOPLE
app.get('/api/people', requireAuth, (req, res) => {
  const people = db.prepare("SELECT * FROM people WHERE user_id=? AND status!='archived' ORDER BY sort_order,name").all(req.session.userId);
  res.json(people.map(p => ({...p, ...personStatus(p)})));
});
app.get('/api/people/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM people WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const interactions = db.prepare('SELECT * FROM interactions WHERE person_id=? ORDER BY date DESC,created_at DESC').all(req.params.id);
  res.json({...p, ...personStatus(p), interactions});
});
app.post('/api/people', requireAuth, (req, res) => {
  const { name, organization, role, email, phone, type, notes, follow_up_date, follow_up_frequency, avatar_color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uid();
  const cnt = db.prepare('SELECT COUNT(*) as c FROM people WHERE user_id=?').get(req.session.userId).c;
  db.prepare('INSERT INTO people (id,user_id,name,organization,role,email,phone,type,notes,follow_up_date,follow_up_frequency,avatar_color,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.session.userId, name, organization||null, role||null, email||null, phone||null, type||'professional', notes||'', follow_up_date||null, follow_up_frequency||null, avatar_color||'#c4922a', cnt);
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(id);
  res.json({...p, ...personStatus(p)});
});
app.patch('/api/people/:id', requireAuth, (req, res) => {
  const { name, organization, role, email, phone, type, notes, follow_up_date, follow_up_frequency, avatar_color, status } = req.body;
  const existing = db.prepare('SELECT id FROM people WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const now = new Date().toISOString();
  const updates = ['updated_at=?'], vals = [now];
  if (name !== undefined) { updates.push('name=?'); vals.push(name); }
  if (organization !== undefined) { updates.push('organization=?'); vals.push(organization||null); }
  if (role !== undefined) { updates.push('role=?'); vals.push(role||null); }
  if (email !== undefined) { updates.push('email=?'); vals.push(email||null); }
  if (phone !== undefined) { updates.push('phone=?'); vals.push(phone||null); }
  if (type !== undefined) { updates.push('type=?'); vals.push(type); }
  if (notes !== undefined) { updates.push('notes=?'); vals.push(notes||''); }
  if (follow_up_date !== undefined) { updates.push('follow_up_date=?'); vals.push(follow_up_date||null); }
  if (follow_up_frequency !== undefined) { updates.push('follow_up_frequency=?'); vals.push(follow_up_frequency||null); }
  if (avatar_color !== undefined) { updates.push('avatar_color=?'); vals.push(avatar_color); }
  if (status !== undefined) { updates.push('status=?'); vals.push(status); }
  vals.push(req.params.id, req.session.userId);
  db.prepare(`UPDATE people SET ${updates.join(',')} WHERE id=? AND user_id=?`).run(...vals);
  const p = db.prepare('SELECT * FROM people WHERE id=?').get(req.params.id);
  res.json({...p, ...personStatus(p)});
});
app.delete('/api/people/:id', requireAuth, (req, res) => {
  db.prepare("UPDATE people SET status='archived',updated_at=? WHERE id=? AND user_id=?").run(new Date().toISOString(), req.params.id, req.session.userId);
  res.json({ ok: true });
});

// INTERACTIONS
app.get('/api/people/:id/interactions', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM interactions WHERE person_id=? AND user_id=? ORDER BY date DESC,created_at DESC').all(req.params.id, req.session.userId));
});
app.post('/api/people/:id/interactions', requireAuth, (req, res) => {
  const { type, date, notes, linked_task_id } = req.body;
  if (!type || !date) return res.status(400).json({ error: 'type and date required' });
  const iid = uid();
  db.prepare('INSERT INTO interactions (id,person_id,user_id,type,date,notes,linked_task_id) VALUES (?,?,?,?,?,?,?)').run(iid, req.params.id, req.session.userId, type, date, notes||'', linked_task_id||null);
  db.prepare('UPDATE people SET last_contacted=?,updated_at=? WHERE id=? AND user_id=? AND (last_contacted IS NULL OR last_contacted < ?)').run(date, new Date().toISOString(), req.params.id, req.session.userId, date);
  res.json(db.prepare('SELECT * FROM interactions WHERE id=?').get(iid));
});
app.delete('/api/interactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM interactions WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

// ADMIN: view waitlist
app.get('/admin/waitlist', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare('SELECT email, created_at FROM waitlist ORDER BY created_at DESC').all();
  res.json({ count: rows.length, emails: rows });
});

app.delete('/admin/reset-user-data', (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (!user) return res.status(404).json({ error: 'User not found' });
  const uid = user.id;
  const counts = db.transaction(() => ({
    tasks:    db.prepare('DELETE FROM tasks    WHERE user_id=?').run(uid).changes,
    sections: db.prepare('DELETE FROM sections WHERE user_id=?').run(uid).changes,
    projects: db.prepare('DELETE FROM projects WHERE user_id=?').run(uid).changes,
    habits:   db.prepare('DELETE FROM habits   WHERE user_id=?').run(uid).changes,
    journal:  db.prepare('DELETE FROM journal_entries WHERE user_id=?').run(uid).changes,
    people:   db.prepare('DELETE FROM people   WHERE user_id=?').run(uid).changes,
  }))();
  console.log(`Admin reset for ${email}:`, counts);
  res.json({ ok: true, email, deleted: counts });
});

// WAITLIST
db.exec(`CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  try {
    db.prepare('INSERT OR IGNORE INTO waitlist (email) VALUES (?)').run(email.toLowerCase().trim());
    console.log(`Waitlist signup: ${email}`);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    sendEmail('FNoorali@gmail.com', 'New Irada waitlist signup',
      `<pre style="font-family:monospace;font-size:13px;color:#1a1714;line-height:1.7">Someone just joined the Irada waitlist.

Email: ${email}
Time:  ${ts}

To invite them run:
curl -X POST https://irada.work/admin/invite-user \\
  -H 'Content-Type: application/json' \\
  -d '{"adminSecret":"admin123","email":"${email}","name":"Friend"}'

View full waitlist:
curl https://irada.work/admin/waitlist?secret=admin123</pre>`
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'Could not save email' }); }
});

// ROUTING
// / → always landing page
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname,'public','landing.html'));
});
// /login → always serve the app shell (handles ?reset= and other URL params)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname,'public','app.html')));
// Everything else → app (handles /?reset=token, /?settings=1, etc.)
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','app.html')));

app.listen(PORT, () => console.log(`Irada running at http://localhost:${PORT}`));
