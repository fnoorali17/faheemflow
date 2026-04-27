const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'session-change-me';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(path.join(dataDir, 'faheemflow.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6',
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
    name TEXT NOT NULL, due_date TEXT, priority INTEGER DEFAULT 3,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
    tags TEXT DEFAULT '[]', is_done INTEGER DEFAULT 0,
    is_urgent INTEGER DEFAULT 0, is_important INTEGER DEFAULT 0,
    pomos INTEGER DEFAULT 1, today_pick INTEGER DEFAULT 0,
    gcal_event_id TEXT, todoist_task_id TEXT,
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

app.use(cors());
app.use(express.json());
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const parseTask = row => ({
  ...row, tags: JSON.parse(row.tags || '[]'),
  is_done: !!row.is_done, is_urgent: !!row.is_urgent,
  is_important: !!row.is_important, today_pick: !!row.today_pick,
});

// AUTH
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.userId = user.id;
  res.json({ ok: true, name: user.name, email: user.email });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(req.session.userId);
  res.json(user);
});

// ADMIN CREATE USER
app.post('/admin/create-user', async (req, res) => {
  const { adminSecret, email, password, name } = req.body;
  if (adminSecret !== ADMIN_SECRET) return res.status(403).json({ error: 'Invalid admin secret' });
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'User already exists' });
  const hash = await bcrypt.hash(password, 12);
  const id = uid();
  db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(id, email.toLowerCase().trim(), hash, name);
  // Seed sample data for new user (wrapped in try/catch to handle restarts gracefully)
  try { db.pragma('foreign_keys = OFF');
  const p1 = uid(), p2 = uid(), s1 = uid(), s2 = uid(), s3 = uid(), s4 = uid(), s5 = uid();
  const today = new Date().toISOString().slice(0, 10);
  const nxt = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  db.prepare('INSERT OR IGNORE INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(p1, id, 'Work', '#8b5cf6', 0);
  db.prepare('INSERT OR IGNORE INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(p2, id, 'Personal', '#3b82f6', 1);
  [s1,s2,s3].forEach((s,i) => db.prepare('INSERT OR IGNORE INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(s, p1, id, ['In Progress','This Week','Backlog'][i], i));
  [s4,s5].forEach((s,i) => db.prepare('INSERT OR IGNORE INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(s, p2, id, ['Errands','Goals'][i], i));
  const ins = db.prepare('INSERT OR IGNORE INTO tasks (id,user_id,name,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  [[uid(),'Review Q2 operations report',today,1,p1,s1,'["urgent","review"]',1,1,2],[uid(),'Set up Claude workflow templates',today,2,p1,s1,'["research"]',0,1,3],[uid(),'Research AI consulting competitors',nxt(1),2,p1,s2,'["research"]',1,0,2],[uid(),'Draft SOP template for onboarding',nxt(3),3,p1,s3,'[]',0,1,4],[uid(),'Book dentist appointment',today,3,p2,s4,'["personal"]',1,0,1],[uid(),'Renew gym membership',nxt(2),4,p2,s4,'[]',0,0,1],[uid(),'Read AI for Everyone Chapter 3',nxt(4),3,p2,s5,'["research"]',0,1,2]].forEach(t => ins.run(id, ...t));
  const insh = db.prepare('INSERT OR IGNORE INTO habits (id,user_id,emoji,name,sort_order) VALUES (?,?,?,?,?)');
  [[uid(),'💧','Drink 8 glasses of water',0],[uid(),'📚','Read for 20 minutes',1],[uid(),'🏃','Exercise',2],[uid(),'✍️','Journal or reflect',3]].forEach(h => insh.run(id, ...h));
  const hIds = db.prepare('SELECT id FROM habits WHERE user_id=? ORDER BY sort_order').all(id).map(r => r.id);
  const insl = db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id,log_date) VALUES (?,?)');
  Object.entries({0:[0,1,2,3,5],1:[0,1,3,4,6,7],2:[1,2,4,7],3:[0,2,5]}).forEach(([i,days]) => days.forEach(d => insl.run(hIds[i], new Date(Date.now()-d*86400000).toISOString().slice(0,10))));
  db.pragma('foreign_keys = ON');
  } catch(e) { console.log('Seed note:', e.message); }
  res.json({ ok: true, id, email, name });
});

// GCAL
function getGCal() {
  const { GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN } = process.env;
  if (!GCAL_CLIENT_ID || !GCAL_CLIENT_SECRET || !GCAL_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(GCAL_CLIENT_ID, GCAL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GCAL_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}
app.get('/api/gcal/status', requireAuth, (req, res) => res.json({ configured: !!(process.env.GCAL_CLIENT_ID && process.env.GCAL_CLIENT_SECRET && process.env.GCAL_REFRESH_TOKEN) }));
app.post('/api/gcal/sync', requireAuth, async (req, res) => {
  const cal = getGCal();
  if (!cal) return res.status(400).json({ error: 'Google Calendar not configured. Add GCAL_CLIENT_ID, GCAL_CLIENT_SECRET and GCAL_REFRESH_TOKEN to Railway environment variables.' });
  const tasks = db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.due_date IS NOT NULL AND t.is_done=0 AND t.parent_id IS NULL').all(req.session.userId).map(parseTask);
  const results = { created: 0, updated: 0, errors: [] };
  for (const task of tasks) {
    const tags = (task.tags||[]).length ? `Tags: ${task.tags.map(t=>'#'+t).join(' ')}` : '';
    const desc = [`${['','🔴 P1','🟠 P2','🔵 P3','⚪ P4'][task.priority]}`, `🍅 ${task.pomos||1}×25m`, task.proj_name?`Project: ${task.proj_name}`:'', tags, '\n— FaheemFlow'].filter(Boolean).join('\n');
    const event = { summary: task.name, description: desc, start:{date:task.due_date}, end:{date:task.due_date}, colorId: task.priority===1?'11':task.priority===2?'6':'1' };
    try {
      if (task.gcal_event_id) { await cal.events.update({calendarId:'primary',eventId:task.gcal_event_id,requestBody:event}); results.updated++; }
      else { const r=await cal.events.insert({calendarId:'primary',requestBody:event}); db.prepare('UPDATE tasks SET gcal_event_id=? WHERE id=?').run(r.data.id,task.id); results.created++; }
    } catch(err) {
      if (err.code===404||err.code===410) { try { const r=await cal.events.insert({calendarId:'primary',requestBody:event}); db.prepare('UPDATE tasks SET gcal_event_id=? WHERE id=?').run(r.data.id,task.id); results.created++; } catch(e){results.errors.push({task:task.name,error:e.message});} }
      else results.errors.push({task:task.name,error:err.message});
    }
  }
  res.json({ ok: true, ...results, total: tasks.length });
});

// TODOIST
async function tdReq(method, path, body) {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new Error('TODOIST_API_TOKEN not set');
  const r = await fetch(`https://api.todoist.com/rest/v2${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Todoist ${r.status}`);
  return r.json();
}
app.get('/api/todoist/status', requireAuth, (req, res) => res.json({ configured: !!process.env.TODOIST_API_TOKEN }));
app.post('/api/todoist/sync', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [tdProjects, tdTasks] = await Promise.all([tdReq('GET','/projects'), tdReq('GET','/tasks')]);
    const tdProjByName = Object.fromEntries(tdProjects.map(p => [p.name.toLowerCase(), p.id]));
    const tdProjById = Object.fromEntries(tdProjects.map(p => [p.id, p.name]));
    let pushed = 0, pulled = 0;
    // Push local → Todoist
    const localTasks = db.prepare('SELECT t.*,p.name as proj_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.user_id=? AND t.parent_id IS NULL').all(userId).map(parseTask);
    for (const task of localTasks) {
      let tdProjId = null;
      if (task.proj_name) {
        tdProjId = tdProjByName[task.proj_name.toLowerCase()];
        if (!tdProjId) { const np = await tdReq('POST','/projects',{name:task.proj_name}); tdProjId = np.id; tdProjByName[task.proj_name.toLowerCase()] = tdProjId; db.prepare('UPDATE projects SET todoist_project_id=? WHERE user_id=? AND name=?').run(tdProjId,userId,task.proj_name); }
      }
      const payload = { content: task.name, due_date: task.due_date||undefined, priority: task.priority===1?4:task.priority===2?3:task.priority===3?2:1, project_id: tdProjId||undefined, labels: task.tags||[], description: `🍅 ${task.pomos||1}×25m | FaheemFlow` };
      if (task.is_done && task.todoist_task_id) { try { await tdReq('POST',`/tasks/${task.todoist_task_id}/close`); } catch(e){} continue; }
      if (task.todoist_task_id) { try { await tdReq('POST',`/tasks/${task.todoist_task_id}`,payload); pushed++; } catch(e) { if(e.message.includes('404')){const nc=await tdReq('POST','/tasks',payload);db.prepare('UPDATE tasks SET todoist_task_id=? WHERE id=?').run(nc.id,task.id);pushed++;} } }
      else if (!task.is_done) { const nc=await tdReq('POST','/tasks',payload); db.prepare('UPDATE tasks SET todoist_task_id=? WHERE id=?').run(nc.id,task.id); pushed++; }
    }
    // Pull Todoist → local
    const existingTdIds = new Set(db.prepare('SELECT todoist_task_id FROM tasks WHERE user_id=? AND todoist_task_id IS NOT NULL').all(userId).map(r=>r.todoist_task_id));
    for (const tdt of tdTasks) {
      if (existingTdIds.has(tdt.id)) continue;
      let localProjId = null;
      if (tdt.project_id && tdProjById[tdt.project_id]) {
        const pname = tdProjById[tdt.project_id];
        let lp = db.prepare('SELECT id FROM projects WHERE user_id=? AND name=?').get(userId, pname);
        if (!lp) { const nid=uid(); db.prepare('INSERT INTO projects (id,user_id,name,color,todoist_project_id,sort_order) VALUES (?,?,?,?,?,?)').run(nid,userId,pname,'#6b7280',tdt.project_id,99); localProjId=nid; }
        else localProjId = lp.id;
      }
      const pri = tdt.priority===4?1:tdt.priority===3?2:tdt.priority===2?3:4;
      db.prepare('INSERT INTO tasks (id,user_id,name,due_date,priority,project_id,tags,is_done,pomos,todoist_task_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(uid(),userId,tdt.content,tdt.due?.date||null,pri,localProjId,JSON.stringify(tdt.labels||[]),0,1,tdt.id);
      pulled++;
    }
    res.json({ ok: true, pushed, pulled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PROJECTS
app.get('/api/projects', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  const sections = db.prepare('SELECT * FROM sections WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  res.json(projects.map(p => ({ ...p, sections: sections.filter(s=>s.project_id===p.id).map(s=>({...s,is_open:!!s.is_open})) })));
});
app.post('/api/projects', requireAuth, (req, res) => {
  const { id, name, color } = req.body;
  db.prepare('INSERT INTO projects (id,user_id,name,color,sort_order) VALUES (?,?,?,?,?)').run(id,req.session.userId,name,color||'#3b82f6',db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id=?').get(req.session.userId).c);
  res.json({ ok: true });
});
app.delete('/api/projects/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });

// SECTIONS
app.post('/api/sections', requireAuth, (req, res) => {
  const { id, project_id, name } = req.body;
  db.prepare('INSERT INTO sections (id,project_id,user_id,name,sort_order) VALUES (?,?,?,?,?)').run(id,project_id,req.session.userId,name,db.prepare('SELECT COUNT(*) as c FROM sections WHERE project_id=?').get(project_id).c);
  res.json({ ok: true });
});
app.patch('/api/sections/:id', requireAuth, (req, res) => { db.prepare('UPDATE sections SET is_open=? WHERE id=? AND user_id=?').run(req.body.is_open?1:0,req.params.id,req.session.userId); res.json({ok:true}); });
app.delete('/api/sections/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE tasks SET section_id=NULL WHERE section_id=? AND user_id=?').run(req.params.id,req.session.userId);
  db.prepare('DELETE FROM sections WHERE id=? AND user_id=?').run(req.params.id,req.session.userId);
  res.json({ ok: true });
});

// TASKS
app.get('/api/tasks', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY priority,due_date,created_at').all(req.session.userId).map(parseTask)));
app.post('/api/tasks', requireAuth, (req, res) => {
  const { id, name, due_date, priority, project_id, section_id, tags, is_urgent, is_important, pomos, parent_id } = req.body;
  db.prepare('INSERT INTO tasks (id,user_id,parent_id,name,due_date,priority,project_id,section_id,tags,is_urgent,is_important,pomos,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,req.session.userId,parent_id||null,name,due_date||null,priority||3,project_id||null,section_id||null,JSON.stringify(tags||[]),is_urgent?1:0,is_important?1:0,pomos||1,db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id=?').get(req.session.userId).c);
  res.json({ ok: true });
});
app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const t = req.body;
  db.prepare(`UPDATE tasks SET name=COALESCE(?,name),due_date=?,priority=COALESCE(?,priority),project_id=?,section_id=?,tags=COALESCE(?,tags),is_done=COALESCE(?,is_done),is_urgent=COALESCE(?,is_urgent),is_important=COALESCE(?,is_important),pomos=COALESCE(?,pomos),today_pick=COALESCE(?,today_pick) WHERE id=? AND user_id=?`).run(t.name??null,'due_date'in t?(t.due_date||null):undefined,t.priority??null,'project_id'in t?(t.project_id||null):undefined,'section_id'in t?(t.section_id||null):undefined,t.tags?JSON.stringify(t.tags):null,t.is_done!==undefined?(t.is_done?1:0):null,t.is_urgent!==undefined?(t.is_urgent?1:0):null,t.is_important!==undefined?(t.is_important?1:0):null,t.pomos??null,t.today_pick!==undefined?(t.today_pick?1:0):null,req.params.id,req.session.userId);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });

// HABITS
app.get('/api/habits', requireAuth, (req, res) => {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id=? ORDER BY sort_order,created_at').all(req.session.userId);
  const logs = db.prepare('SELECT hl.* FROM habit_logs hl JOIN habits h ON hl.habit_id=h.id WHERE h.user_id=?').all(req.session.userId);
  res.json(habits.map(h => ({ ...h, log: Object.fromEntries(logs.filter(l=>l.habit_id===h.id).map(l=>[l.log_date,true])) })));
});
app.post('/api/habits', requireAuth, (req, res) => { const {id,emoji,name}=req.body; db.prepare('INSERT INTO habits (id,user_id,emoji,name,sort_order) VALUES (?,?,?,?,?)').run(id,req.session.userId,emoji||'🌱',name,db.prepare('SELECT COUNT(*) as c FROM habits WHERE user_id=?').get(req.session.userId).c); res.json({ok:true}); });
app.patch('/api/habits/:id', requireAuth, (req, res) => { db.prepare('UPDATE habits SET emoji=COALESCE(?,emoji),name=COALESCE(?,name) WHERE id=? AND user_id=?').run(req.body.emoji||null,req.body.name||null,req.params.id,req.session.userId); res.json({ok:true}); });
app.delete('/api/habits/:id', requireAuth, (req, res) => { db.prepare('DELETE FROM habits WHERE id=? AND user_id=?').run(req.params.id,req.session.userId); res.json({ok:true}); });
app.post('/api/habits/:id/log', requireAuth, (req, res) => {
  const { date, done } = req.body;
  if (done) db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id,log_date) VALUES (?,?)').run(req.params.id,date);
  else db.prepare('DELETE FROM habit_logs WHERE habit_id=? AND log_date=?').run(req.params.id,date);
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, () => console.log(`FaheemFlow running at http://localhost:${PORT}`));
