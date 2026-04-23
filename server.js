const express = require('express');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'columen2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'columen-verify-2026';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://redhawk-columen.bm6z1s.easypanel.host';

// Database - use /data if exists (Docker volume), fallback to ./data
const fs = require('fs');
const DB_DIR = fs.existsSync('/data') ? '/data' : './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'columen.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const BACKUP_DIR = path.join(DB_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const BACKUP_KEEP = 50;
let backupRunning = false;
async function snapshotDB(reason = 'periodic') {
  if (backupRunning) return;
  backupRunning = true;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const dst = path.join(BACKUP_DIR, `columen-${ts}-${reason}.db`);
    await db.backup(dst);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
    while (files.length > BACKUP_KEEP) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch {}
    }
    console.log('[backup] snapshot', reason, path.basename(dst));
  } catch (e) {
    console.error('[backup] error', e.message);
  } finally {
    backupRunning = false;
  }
}
setInterval(() => snapshotDB('hourly'), 60 * 60 * 1000);
snapshotDB('startup');
db.exec(`
  CREATE TABLE IF NOT EXISTS consultas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT,
    area TEXT,
    nombre TEXT,
    dni TEXT,
    email TEXT,
    consulta TEXT,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS bot_state (
    telefono TEXT PRIMARY KEY,
    step TEXT,
    area TEXT,
    nombre TEXT,
    dni TEXT,
    email TEXT,
    updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT,
    telefono TEXT NOT NULL,
    direction TEXT NOT NULL,
    type TEXT,
    body TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_tel ON messages (telefono, created_at);
  CREATE TABLE IF NOT EXISTS conversations (
    telefono TEXT PRIMARY KEY,
    last_body TEXT,
    last_at DATETIME,
    last_direction TEXT,
    unread INTEGER DEFAULT 0,
    bot_paused INTEGER DEFAULT 0
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT (datetime('now','localtime')))`);
function runMigration(name, fn) {
  const existing = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(name);
  if (existing) return;
  fn();
  db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  console.log('[migration] applied:', name);
}
// Pre-existing rows were stored in UTC (before TZ was set). Shift them -3h to Argentina time.
runMigration('fix_tz_argentina_2026_04', () => {
  db.prepare("UPDATE consultas SET created_at = datetime(created_at, '-3 hours')").run();
});

// Cleanup old sessions (older than 24h)
db.exec(`DELETE FROM sessions WHERE created_at < datetime('now', '-1 day')`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Auth helpers ---
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  return token;
}

function isAuthenticated(req) {
  const token = req.cookies.session;
  if (!token) return false;
  const row = db.prepare("SELECT token FROM sessions WHERE token = ? AND created_at > datetime('now', '-1 day')").get(token);
  return !!row;
}

// --- Webhook: receives data from Kapso ---
app.post('/api/webhook', (req, res) => {
  const data = req.body;
  console.log('Webhook received:', JSON.stringify(data));
  const stmt = db.prepare('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(
    data.telefono || '',
    data.area || '',
    data.nombre || '',
    data.dni || '',
    data.email || '',
    data.consulta || ''
  );
  snapshotDB('consulta');
  res.json({ status: 'ok' });
});

// --- Admin login page ---
app.get('/admin/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/admin');
  const error = req.query.error ? '<p style="color:#e74c3c;margin-bottom:16px">Usuario o contraseña incorrectos</p>' : '';
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin - COLUMEN</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#f4f0e4;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-family:serif;font-size:24px;color:#1c1c1c;margin-bottom:8px;text-align:center}
  .sub{color:#8a6d2b;font-size:13px;text-align:center;margin-bottom:28px;letter-spacing:.1em;text-transform:uppercase}
  label{display:block;font-size:13px;font-weight:500;color:#555;margin-bottom:6px}
  input{width:100%;padding:12px;border:1px solid #ddd6c4;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none}
  input:focus{border-color:#8a6d2b}
  button{width:100%;padding:14px;background:#1c1c1c;color:#f4f0e4;border:none;border-radius:999px;font-size:15px;font-weight:500;cursor:pointer}
  button:hover{background:#2a2a2a}
</style></head><body>
<div class="card">
  <h1>COLUMEN</h1>
  <div class="sub">Panel de Administracion</div>
  ${error}
  <form method="POST" action="/admin/login">
    <label>Usuario</label>
    <input type="text" name="username" required autofocus>
    <label>Contraseña</label>
    <input type="password" name="password" required>
    <button type="submit">Ingresar</button>
  </form>
</div></body></html>`);
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = createSession();
    res.cookie('session', token, { httpOnly: true, maxAge: 86400000, sameSite: 'lax' });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
  const token = req.cookies.session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('session');
  res.redirect('/admin/login');
});

// Lightweight count endpoint for auto-refresh
app.get('/admin/count', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const { c } = db.prepare('SELECT COUNT(*) as c FROM consultas').get();
  res.json({ count: c });
});

// --- Admin dashboard ---
app.get('/admin', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');

  const f = {
    q: (req.query.q || '').trim(),
    area: (req.query.area || '').trim(),
    desde: (req.query.desde || '').trim(),
    hasta: (req.query.hasta || '').trim(),
  };
  const where = [];
  const params = [];
  if (f.q) {
    where.push('(nombre LIKE ? OR dni LIKE ? OR email LIKE ? OR telefono LIKE ? OR consulta LIKE ?)');
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like);
  }
  if (f.area) { where.push('LOWER(area) LIKE ?'); params.push(`%${f.area.toLowerCase()}%`); }
  if (f.desde) { where.push('date(created_at) >= date(?)'); params.push(f.desde); }
  if (f.hasta) { where.push('date(created_at) <= date(?)'); params.push(f.hasta); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const consultas = db.prepare(`SELECT * FROM consultas ${whereSql} ORDER BY created_at DESC`).all(...params);
  const totalJuridico = db.prepare("SELECT COUNT(*) as c FROM consultas WHERE LOWER(area) LIKE '%juridic%'").get().c;
  const totalNotarial = db.prepare("SELECT COUNT(*) as c FROM consultas WHERE LOWER(area) LIKE '%notarial%'").get().c;
  const totalAll = db.prepare('SELECT COUNT(*) as c FROM consultas').get().c;
  const total = consultas.length;
  const filtered = total !== totalAll;

  const rows = consultas.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${escapeHtml(c.created_at || '')}</td>
      <td>${escapeHtml(c.telefono)}</td>
      <td><span class="badge ${c.area?.toLowerCase().includes('juridic') ? 'badge-j' : 'badge-n'}">${escapeHtml(c.area)}</span></td>
      <td>${escapeHtml(c.nombre)}</td>
      <td>${escapeHtml(c.dni)}</td>
      <td>${escapeHtml(c.email)}</td>
      <td class="consulta-cell">${escapeHtml(c.consulta)}</td>
    </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin - COLUMEN</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#f4f0e4;color:#1c1c1c;min-height:100vh}
  .topbar{background:#1c1c1c;color:#f4f0e4;padding:16px 28px;display:flex;justify-content:space-between;align-items:center}
  .topbar h1{font-family:serif;font-size:20px;font-weight:400;letter-spacing:.15em}
  .topbar a{color:#b8974a;font-size:13px;text-decoration:none}
  .topbar a:hover{color:#f4f0e4}
  .stats{display:flex;gap:16px;padding:24px 28px;flex-wrap:wrap}
  .stat{background:#fff;border:1px solid #ddd6c4;border-radius:12px;padding:20px 24px;flex:1;min-width:140px}
  .stat .num{font-size:32px;font-weight:600;color:#1c1c1c}
  .stat .label{font-size:12px;color:#8a6d2b;text-transform:uppercase;letter-spacing:.1em;margin-top:4px}
  .table-wrap{padding:0 28px 40px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  th{background:#1c1c1c;color:#f4f0e4;padding:12px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;text-align:left;font-weight:500}
  td{padding:10px 14px;border-bottom:1px solid #eee8d9;font-size:14px}
  tr:hover td{background:#faf7f0}
  .badge{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:500}
  .badge-j{background:#e8f0fe;color:#1a5cb0}
  .badge-n{background:#fef3e0;color:#8a6d2b}
  .consulta-cell{max-width:250px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .empty{text-align:center;padding:60px;color:#999;font-size:16px}
  .filters{padding:0 28px 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .filters .f{display:flex;flex-direction:column;gap:4px}
  .filters label{font-size:11px;color:#8a6d2b;text-transform:uppercase;letter-spacing:.08em;font-weight:500}
  .filters input,.filters select{padding:8px 12px;border:1px solid #ddd6c4;border-radius:8px;font-size:14px;font-family:inherit;background:#fff;outline:none;min-width:140px}
  .filters input:focus,.filters select:focus{border-color:#8a6d2b}
  .filters .btn{padding:9px 18px;background:#1c1c1c;color:#f4f0e4;border:none;border-radius:999px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
  .filters .btn:hover{background:#2a2a2a}
  .filters .btn.ghost{background:transparent;color:#1c1c1c;border:1px solid #ddd6c4}
  .filters .btn.ghost:hover{background:#f4f0e4}
  .filter-info{padding:0 28px 8px;font-size:13px;color:#8a6d2b}
</style></head><body>
<div class="topbar">
  <h1>COLUMEN</h1>
  <div><a href="/admin" style="margin-right:18px">Consultas</a><a href="/admin/inbox" style="margin-right:18px">Inbox</a><a href="/admin/backup" style="margin-right:18px">Backup</a><a href="/admin/logout">Salir</a></div>
</div>
<div class="stats">
  <div class="stat"><div class="num">${totalAll}</div><div class="label">Total consultas</div></div>
  <div class="stat"><div class="num">${totalJuridico}</div><div class="label">Juridico</div></div>
  <div class="stat"><div class="num">${totalNotarial}</div><div class="label">Notarial</div></div>
</div>
<form class="filters" method="get" action="/admin">
  <div class="f"><label>Buscar</label><input type="text" name="q" value="${escapeHtml(f.q)}" placeholder="Nombre, DNI, email, tel, texto..."></div>
  <div class="f"><label>Area</label>
    <select name="area">
      <option value="">Todas</option>
      <option value="juridico" ${f.area === 'juridico' ? 'selected' : ''}>Juridico</option>
      <option value="notarial" ${f.area === 'notarial' ? 'selected' : ''}>Notarial</option>
    </select>
  </div>
  <div class="f"><label>Desde</label><input type="date" name="desde" value="${escapeHtml(f.desde)}"></div>
  <div class="f"><label>Hasta</label><input type="date" name="hasta" value="${escapeHtml(f.hasta)}"></div>
  <button type="submit" class="btn">Filtrar</button>
  ${filtered ? '<a href="/admin" class="btn ghost">Limpiar</a>' : ''}
</form>
${filtered ? `<div class="filter-info">Mostrando ${total} de ${totalAll} consultas</div>` : ''}
<div class="table-wrap">
  ${total === 0 ? `<div class="empty">${filtered ? 'No hay resultados con esos filtros' : 'No hay consultas aun'}</div>` : `
  <table>
    <thead><tr><th>#</th><th>Fecha</th><th>Telefono</th><th>Area</th><th>Nombre</th><th>DNI</th><th>Email</th><th>Consulta</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</div>
<script>
(function(){
  const baseline = ${totalAll};
  setInterval(async () => {
    try {
      const r = await fetch('/admin/count', { credentials: 'same-origin' });
      if (!r.ok) return;
      const { count } = await r.json();
      if (count !== baseline) location.reload();
    } catch {}
  }, 5000);
})();
</script>
</body></html>`);
});

// --- Backups ---
app.get('/admin/backup', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');
  const files = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse()
    : [];
  const liveSize = fs.existsSync(DB_PATH) ? (fs.statSync(DB_PATH).size / 1024).toFixed(1) : '?';
  const list = files.map(f => {
    const size = (fs.statSync(path.join(BACKUP_DIR, f)).size / 1024).toFixed(1);
    return `<tr><td><code>${escapeHtml(f)}</code></td><td>${size} KB</td><td><a href="/admin/backup/download?file=${encodeURIComponent(f)}">Descargar</a></td></tr>`;
  }).join('');
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backup - COLUMEN</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#f4f0e4;color:#1c1c1c;min-height:100vh}
  .topbar{background:#1c1c1c;color:#f4f0e4;padding:16px 28px;display:flex;justify-content:space-between;align-items:center}
  .topbar h1{font-family:serif;font-size:20px;letter-spacing:.15em;font-weight:400}
  .topbar a{color:#b8974a;font-size:13px;text-decoration:none;margin-left:18px}
  .topbar a:hover{color:#f4f0e4}
  .wrap{max-width:880px;margin:0 auto;padding:28px}
  .card{background:#fff;border:1px solid #ddd6c4;border-radius:12px;padding:24px;margin-bottom:20px}
  h2{font-family:serif;font-size:22px;margin-bottom:6px}
  .sub{color:#8a6d2b;font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:18px}
  .btn{display:inline-block;padding:10px 18px;background:#1c1c1c;color:#f4f0e4;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px}
  .btn:hover{background:#2a2a2a}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th{background:#1c1c1c;color:#f4f0e4;padding:10px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
  td{padding:8px 10px;border-bottom:1px solid #eee8d9;font-size:13px}
  td a{color:#8a6d2b;text-decoration:none;font-weight:500}
  .warn{background:#fff3cd;border:1px solid #f0e6b6;color:#856404;padding:14px;border-radius:10px;margin-bottom:20px;font-size:14px;line-height:1.5}
</style></head><body>
<div class="topbar"><h1>COLUMEN</h1><div><a href="/admin">Consultas</a><a href="/admin/inbox">Inbox</a><a href="/admin/backup">Backup</a><a href="/admin/logout">Salir</a></div></div>
<div class="wrap">
  <div class="warn"><b>⚠️ Persistencia crítica</b>: los backups viven en <code>/data/backups/</code>. Si <code>/data</code> no tiene volumen montado en EasyPanel, se pierden en cada rebuild junto con la DB principal. Usá <b>Descargar DB actual</b> para guardar una copia off-site.</div>
  <div class="card">
    <h2>DB actual</h2>
    <div class="sub">${liveSize} KB · ${DB_PATH}</div>
    <a class="btn" href="/admin/backup/download">⬇ Descargar DB actual</a>
  </div>
  <div class="card">
    <h2>Snapshots</h2>
    <div class="sub">${files.length} backups · se conservan los últimos ${BACKUP_KEEP}</div>
    ${files.length ? `<table><thead><tr><th>Archivo</th><th>Tamaño</th><th></th></tr></thead><tbody>${list}</tbody></table>` : '<p style="color:#999">No hay snapshots aún.</p>'}
  </div>
</div>
</body></html>`);
});

app.get('/admin/backup/download', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');
  const f = req.query.file;
  if (f) {
    if (!/^columen-[\w\-:]+\.db$/.test(f)) return res.status(400).send('invalid filename');
    const p = path.join(BACKUP_DIR, f);
    if (!fs.existsSync(p)) return res.status(404).send('not found');
    return res.download(p, f);
  }
  if (!fs.existsSync(DB_PATH)) return res.status(404).send('db not found');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.download(DB_PATH, `columen-live-${ts}.db`);
});

// --- Admin Inbox (WhatsApp) ---
function resolveName(tel) {
  const row = db.prepare("SELECT nombre FROM consultas WHERE telefono = ? AND nombre != '' ORDER BY id DESC LIMIT 1").get(tel);
  if (row?.nombre) return row.nombre;
  const st = db.prepare('SELECT nombre FROM bot_state WHERE telefono = ? AND nombre IS NOT NULL').get(tel);
  return st?.nombre || '';
}

app.get('/admin/inbox/data', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const convs = db.prepare(`
    SELECT telefono, last_body, last_at, last_direction, unread, bot_paused
    FROM conversations
    ORDER BY last_at DESC
  `).all();
  const withNames = convs.map(c => ({ ...c, nombre: resolveName(c.telefono) }));
  const totalUnread = withNames.reduce((a, c) => a + (c.unread || 0), 0);
  res.json({ conversations: withNames, totalUnread });
});

app.get('/admin/inbox/:tel/messages', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const messages = db.prepare('SELECT id, direction, type, body, created_at FROM messages WHERE telefono = ? ORDER BY id ASC LIMIT 500').all(tel);
  let conv = db.prepare('SELECT * FROM conversations WHERE telefono = ?').get(tel);
  if (!conv) conv = { telefono: tel, bot_paused: 0, unread: 0 };
  const nombre = resolveName(tel);
  const lastIn = db.prepare("SELECT created_at FROM messages WHERE telefono = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tel);
  let canSend = true;
  if (lastIn?.created_at) {
    const hoursAgo = (Date.now() - new Date(lastIn.created_at.replace(' ', 'T')).getTime()) / 3600000;
    canSend = hoursAgo < 24;
  } else {
    canSend = false;
  }
  res.json({ messages, conversation: { ...conv, nombre }, canSend });
});

app.post('/admin/inbox/:tel/read', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  db.prepare('UPDATE conversations SET unread = 0 WHERE telefono = ?').run(req.params.tel);
  res.json({ ok: true });
});

app.post('/admin/inbox/:tel/bot', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const pausedInt = req.body?.paused ? 1 : 0;
  const exists = db.prepare('SELECT telefono FROM conversations WHERE telefono = ?').get(req.params.tel);
  if (!exists) {
    db.prepare("INSERT INTO conversations (telefono, last_at, bot_paused) VALUES (?, datetime('now','localtime'), ?)").run(req.params.tel, pausedInt);
  } else {
    db.prepare('UPDATE conversations SET bot_paused = ? WHERE telefono = ?').run(pausedInt, req.params.tel);
  }
  if (!pausedInt) db.prepare('DELETE FROM bot_state WHERE telefono = ?').run(req.params.tel);
  res.json({ ok: true });
});

app.post('/admin/inbox/:tel/send', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty' });
  const exists = db.prepare('SELECT telefono FROM conversations WHERE telefono = ?').get(tel);
  if (exists) {
    db.prepare('UPDATE conversations SET bot_paused = 1 WHERE telefono = ?').run(tel);
  } else {
    db.prepare("INSERT INTO conversations (telefono, last_at, bot_paused) VALUES (?, datetime('now','localtime'), 1)").run(tel);
  }
  const result = await sendText(tel, body);
  if (result?.error) return res.status(502).json({ error: 'wa_error', detail: result.error.message || 'Error de WhatsApp', raw: result.error });
  res.json({ ok: true });
});

app.get('/admin/inbox', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inbox - COLUMEN</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:'Inter',system-ui,sans-serif;background:#f4f0e4;color:#1c1c1c;display:flex;flex-direction:column;height:100vh}
  .topbar{background:#1c1c1c;color:#f4f0e4;padding:14px 28px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
  .topbar h1{font-family:serif;font-size:20px;font-weight:400;letter-spacing:.15em}
  .topbar a{color:#b8974a;font-size:13px;text-decoration:none;margin-right:18px}
  .topbar a:hover{color:#f4f0e4}
  .topbar .r a:last-child{margin-right:0}
  .layout{flex:1;display:flex;overflow:hidden}
  .sidebar{width:340px;background:#fff;border-right:1px solid #ddd6c4;display:flex;flex-direction:column;flex-shrink:0}
  .sidebar h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:#8a6d2b;padding:16px 20px 8px;font-weight:500}
  .conv-list{flex:1;overflow-y:auto}
  .conv{padding:14px 18px;border-bottom:1px solid #f0ead9;cursor:pointer;display:flex;gap:10px;align-items:flex-start;position:relative}
  .conv:hover{background:#faf7f0}
  .conv.active{background:#f4f0e4}
  .conv .avatar{width:38px;height:38px;border-radius:50%;background:#e8dfc5;color:#8a6d2b;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;flex-shrink:0}
  .conv .body{flex:1;min-width:0}
  .conv .row1{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .conv .name{font-weight:500;font-size:14px;color:#1c1c1c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .conv .time{font-size:11px;color:#999;flex-shrink:0}
  .conv .preview{font-size:13px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
  .conv .badge{background:#8a6d2b;color:#fff;font-size:11px;padding:1px 7px;border-radius:999px;margin-left:6px;font-weight:500}
  .conv .bot-tag{font-size:10px;padding:1px 6px;border-radius:4px;background:#e8f0fe;color:#1a5cb0;margin-left:4px}
  .conv .bot-tag.off{background:#fef0e8;color:#c23b1e}
  .chat{flex:1;display:flex;flex-direction:column;background:#efe9da;min-width:0}
  .chat-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#999;font-size:15px;padding:40px;text-align:center}
  .chat-header{background:#fff;padding:14px 22px;border-bottom:1px solid #ddd6c4;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
  .chat-header .info{display:flex;align-items:center;gap:12px}
  .chat-header .avatar{width:40px;height:40px;border-radius:50%;background:#e8dfc5;color:#8a6d2b;display:flex;align-items:center;justify-content:center;font-weight:600}
  .chat-header .name{font-weight:600;font-size:15px}
  .chat-header .tel{font-size:12px;color:#888}
  .mode-toggle{display:flex;align-items:center;gap:8px;font-size:13px}
  .mode-toggle button{padding:6px 12px;border:1px solid #ddd6c4;background:#fff;color:#1c1c1c;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500}
  .mode-toggle button.active{background:#1c1c1c;color:#f4f0e4;border-color:#1c1c1c}
  .messages{flex:1;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:8px}
  .msg{max-width:72%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap}
  .msg .time{display:block;font-size:10px;color:#999;margin-top:4px;text-align:right}
  .msg.in{background:#fff;align-self:flex-start;border-bottom-left-radius:4px}
  .msg.out{background:#d9c28a;color:#1c1c1c;align-self:flex-end;border-bottom-right-radius:4px}
  .msg .meta{font-size:10px;opacity:.6;margin-top:2px}
  .composer{background:#fff;padding:14px 22px;border-top:1px solid #ddd6c4;display:flex;gap:10px;align-items:flex-end;flex-shrink:0}
  .composer textarea{flex:1;border:1px solid #ddd6c4;border-radius:18px;padding:10px 14px;font-size:14px;font-family:inherit;resize:none;outline:none;min-height:40px;max-height:120px}
  .composer textarea:focus{border-color:#8a6d2b}
  .composer button{background:#1c1c1c;color:#f4f0e4;border:none;border-radius:999px;padding:10px 22px;font-size:14px;font-weight:500;cursor:pointer;height:40px}
  .composer button:disabled{opacity:.5;cursor:not-allowed}
  .banner{background:#fff3cd;color:#856404;padding:10px 22px;font-size:13px;border-bottom:1px solid #f0e6b6;text-align:center}
  .banner.err{background:#f8d7da;color:#721c24;border-color:#f5c6cb}
  .empty-list{padding:32px 20px;color:#999;text-align:center;font-size:14px}
</style></head><body>
<div class="topbar">
  <h1>COLUMEN</h1>
  <div class="r"><a href="/admin">Consultas</a><a href="/admin/inbox">Inbox</a><a href="/admin/backup">Backup</a><a href="/admin/logout">Salir</a></div>
</div>
<div class="layout">
  <div class="sidebar">
    <h2>Conversaciones <span id="totalUnread" style="color:#c23b1e"></span></h2>
    <div class="conv-list" id="convList"><div class="empty-list">Cargando…</div></div>
  </div>
  <div class="chat" id="chat">
    <div class="chat-empty">Seleccioná una conversación</div>
  </div>
</div>
<script>
(function(){
  let activeTel = null;
  let convs = [];
  let lastMsgId = 0;
  let canSend = true;

  function initials(s){ if(!s) return '?'; const p=s.trim().split(/\\s+/); return ((p[0]?.[0]||'')+(p[1]?.[0]||'')).toUpperCase() || '?'; }
  function formatTime(iso){ if(!iso) return ''; const d=new Date(iso.replace(' ','T')); const now=new Date(); const same=d.toDateString()===now.toDateString(); return same ? d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}) : d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}); }
  function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  async function loadConvs(){
    const r = await fetch('/admin/inbox/data', { credentials:'same-origin' });
    if (!r.ok) return;
    const { conversations, totalUnread } = await r.json();
    convs = conversations;
    document.getElementById('totalUnread').textContent = totalUnread ? '('+totalUnread+')' : '';
    renderSidebar();
  }

  function renderSidebar(){
    const el = document.getElementById('convList');
    if (!convs.length) { el.innerHTML = '<div class="empty-list">Sin mensajes aún</div>'; return; }
    el.innerHTML = convs.map(c => {
      const name = c.nombre || c.telefono;
      const botTag = c.bot_paused ? '<span class="bot-tag off">Humano</span>' : '<span class="bot-tag">Bot</span>';
      const unread = c.unread ? '<span class="badge">'+c.unread+'</span>' : '';
      return '<div class="conv '+(c.telefono===activeTel?'active':'')+'" data-tel="'+c.telefono+'">'+
        '<div class="avatar">'+initials(name)+'</div>'+
        '<div class="body">'+
          '<div class="row1"><div class="name">'+escapeHtml(name)+botTag+'</div><div class="time">'+formatTime(c.last_at)+'</div></div>'+
          '<div class="preview">'+(c.last_direction==='out'?'<span style="color:#8a6d2b">Tú: </span>':'')+escapeHtml((c.last_body||'').slice(0,60))+unread+'</div>'+
        '</div></div>';
    }).join('');
    el.querySelectorAll('.conv').forEach(n => n.addEventListener('click', () => openConv(n.dataset.tel)));
  }

  async function openConv(tel){
    activeTel = tel;
    lastMsgId = 0;
    document.querySelectorAll('.conv').forEach(n => n.classList.toggle('active', n.dataset.tel===tel));
    await loadMessages(true);
    await fetch('/admin/inbox/'+encodeURIComponent(tel)+'/read', { method:'POST', credentials:'same-origin' });
    loadConvs();
  }

  async function loadMessages(scroll){
    if (!activeTel) return;
    const r = await fetch('/admin/inbox/'+encodeURIComponent(activeTel)+'/messages', { credentials:'same-origin' });
    if (!r.ok) return;
    const { messages, conversation, canSend: cs } = await r.json();
    canSend = cs;
    renderChat(messages, conversation);
    if (scroll) requestAnimationFrame(()=>{ const m=document.getElementById('msgs'); if(m) m.scrollTop=m.scrollHeight; });
    if (messages.length) lastMsgId = messages[messages.length-1].id;
  }

  function renderChat(messages, conv){
    const name = conv.nombre || conv.telefono;
    const paused = !!conv.bot_paused;
    const msgsHtml = messages.map(m => {
      const cls = m.direction==='out' ? 'out' : 'in';
      return '<div class="msg '+cls+'">'+escapeHtml(m.body)+'<span class="time">'+formatTime(m.created_at)+'</span></div>';
    }).join('');
    const warnBanner = !canSend ? '<div class="banner">Fuera de la ventana de 24 hs de WhatsApp. Esperá a que el cliente escriba primero.</div>' : '';
    document.getElementById('chat').innerHTML =
      '<div class="chat-header">'+
        '<div class="info"><div class="avatar">'+initials(name)+'</div>'+
          '<div><div class="name">'+escapeHtml(name)+'</div><div class="tel">+'+escapeHtml(conv.telefono)+'</div></div>'+
        '</div>'+
        '<div class="mode-toggle">'+
          '<span>Modo:</span>'+
          '<button id="btnBot" class="'+(!paused?'active':'')+'">Bot</button>'+
          '<button id="btnHuman" class="'+(paused?'active':'')+'">Humano</button>'+
        '</div>'+
      '</div>'+
      warnBanner+
      '<div class="messages" id="msgs">'+msgsHtml+'</div>'+
      '<div class="composer">'+
        '<textarea id="inp" rows="1" placeholder="'+(canSend?'Escribí un mensaje…':'Solo lectura (ventana de 24 hs cerrada)')+'" '+(canSend?'':'disabled')+'></textarea>'+
        '<button id="btnSend" '+(canSend?'':'disabled')+'>Enviar</button>'+
      '</div>';
    document.getElementById('btnBot').addEventListener('click', ()=>toggleBot(false));
    document.getElementById('btnHuman').addEventListener('click', ()=>toggleBot(true));
    const inp = document.getElementById('inp');
    const btn = document.getElementById('btnSend');
    btn.addEventListener('click', sendMsg);
    inp.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMsg(); } });
    inp.addEventListener('input', ()=>{ inp.style.height='auto'; inp.style.height=Math.min(120, inp.scrollHeight)+'px'; });
    inp.focus();
  }

  async function toggleBot(paused){
    if (!activeTel) return;
    await fetch('/admin/inbox/'+encodeURIComponent(activeTel)+'/bot', {
      method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({paused})
    });
    await loadMessages(false);
    loadConvs();
  }

  async function sendMsg(){
    const inp = document.getElementById('inp');
    const btn = document.getElementById('btnSend');
    const body = inp.value.trim();
    if (!body || !activeTel) return;
    btn.disabled = true;
    inp.disabled = true;
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(activeTel)+'/send', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify({ body })
      });
      if (!r.ok) {
        const j = await r.json().catch(()=>({}));
        alert('Error enviando: '+(j.detail||j.error||'desconocido'));
      } else {
        inp.value = '';
        inp.style.height='auto';
        await loadMessages(true);
        loadConvs();
      }
    } finally {
      btn.disabled = false;
      inp.disabled = false;
      inp.focus();
    }
  }

  loadConvs();
  setInterval(()=>{ loadConvs(); if (activeTel) loadMessages(false); }, 4000);
})();
</script>
</body></html>`);
});

// --- Formulario de consulta (abierto desde WhatsApp) ---
app.get('/consulta', (req, res) => {
  const area = req.query.area || '';
  const tel = req.query.tel || '';
  const sent = req.query.sent === '1';
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Consulta - COLUMEN</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:#f4f0e4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:18px;padding:36px 28px;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .logo{text-align:center;margin-bottom:6px}
  .logo span{font-family:serif;font-size:22px;letter-spacing:.2em;color:#1c1c1c}
  .area-badge{display:block;text-align:center;margin-bottom:24px}
  .area-badge span{background:${area.toLowerCase().includes('juridic') ? '#e8f0fe' : '#fef3e0'};color:${area.toLowerCase().includes('juridic') ? '#1a5cb0' : '#8a6d2b'};padding:5px 16px;border-radius:999px;font-size:13px;font-weight:500}
  h2{font-family:serif;font-size:20px;color:#1c1c1c;margin-bottom:4px;text-align:center}
  .sub{color:#8a6d2b;font-size:12px;text-align:center;margin-bottom:24px;letter-spacing:.08em;text-transform:uppercase}
  label{display:block;font-size:13px;font-weight:500;color:#555;margin-bottom:5px}
  input,textarea{width:100%;padding:12px;border:1px solid #ddd6c4;border-radius:10px;font-size:15px;margin-bottom:14px;outline:none;font-family:inherit}
  input:focus,textarea:focus{border-color:#8a6d2b;box-shadow:0 0 0 3px rgba(138,109,43,.1)}
  textarea{resize:vertical;min-height:90px}
  button{width:100%;padding:14px;background:#1c1c1c;color:#f4f0e4;border:none;border-radius:999px;font-size:15px;font-weight:500;cursor:pointer;margin-top:4px}
  button:hover{background:#2a2a2a}
  button:disabled{opacity:.5;cursor:not-allowed}
  .success{text-align:center;padding:40px 20px}
  .success .check{font-size:48px;margin-bottom:16px}
  .success h2{margin-bottom:12px}
  .success p{color:#666;font-size:15px;line-height:1.5}
</style></head><body>
<div class="card">
  ${sent ? `
  <div class="success">
    <div class="check">&#10003;</div>
    <h2>Consulta enviada</h2>
    <p>Gracias! Un profesional de COLUMEN te va a contactar a la brevedad.</p>
    <p style="margin-top:16px;font-size:13px;color:#999">Ya podes cerrar esta ventana.</p>
  </div>` : `
  <div class="logo"><span>COLUMEN</span></div>
  ${area ? '<div class="area-badge"><span>Consulta ' + escapeHtml(area) + '</span></div>' : ''}
  <h2>Completa tus datos</h2>
  <div class="sub">Te contactaremos a la brevedad</div>
  <form method="POST" action="/consulta" id="formConsulta">
    <input type="hidden" name="area" value="${escapeHtml(area)}">
    <input type="hidden" name="telefono" value="${escapeHtml(tel)}">
    <label>Nombre completo *</label>
    <input type="text" name="nombre" required autocomplete="name">
    <label>DNI *</label>
    <input type="text" name="dni" required inputmode="numeric" pattern="[0-9.]{7,12}">
    <label>Email *</label>
    <input type="email" name="email" required autocomplete="email">
    <label>Tu consulta *</label>
    <textarea name="consulta" required placeholder="Describe brevemente tu consulta..."></textarea>
    <button type="submit" id="btnEnviar">Enviar consulta</button>
  </form>
  <script>
    document.getElementById('formConsulta').addEventListener('submit', function(){
      document.getElementById('btnEnviar').disabled = true;
      document.getElementById('btnEnviar').textContent = 'Enviando...';
    });
  </script>`}
</div></body></html>`);
});

app.post('/consulta', (req, res) => {
  const { telefono, area, nombre, dni, email, consulta } = req.body;
  db.prepare('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES (?, ?, ?, ?, ?, ?)').run(
    telefono || '', area || '', nombre || '', dni || '', email || '', consulta || ''
  );
  snapshotDB('consulta');
  res.redirect(`/consulta?sent=1`);
});

// --- WhatsApp bot (Cloud API directo, sin Kapso) ---
const processedMessages = new Set();
const debugLog = [];
function logDebug(event) {
  debugLog.push({ ts: new Date().toISOString(), ...event });
  if (debugLog.length > 100) debugLog.shift();
}

function recordMessage(tel, direction, type, body, waId) {
  try {
    db.prepare('INSERT INTO messages (wa_id, telefono, direction, type, body) VALUES (?,?,?,?,?)').run(waId || null, tel, direction, type || 'text', body || '');
    const existing = db.prepare('SELECT telefono, unread FROM conversations WHERE telefono = ?').get(tel);
    if (existing) {
      const unread = direction === 'in' ? existing.unread + 1 : existing.unread;
      db.prepare("UPDATE conversations SET last_body=?, last_at=datetime('now','localtime'), last_direction=?, unread=? WHERE telefono=?").run(body || '', direction, unread, tel);
    } else {
      const unread = direction === 'in' ? 1 : 0;
      db.prepare("INSERT INTO conversations (telefono, last_body, last_at, last_direction, unread) VALUES (?,?,datetime('now','localtime'),?,?)").run(tel, body || '', direction, unread);
    }
  } catch (e) {
    console.error('[inbox] recordMessage error', e.message);
  }
}

function outboundBodyFor(payload) {
  if (payload.type === 'text') return payload.text?.body || '';
  if (payload.type === 'interactive') {
    const main = payload.interactive?.body?.text || '';
    const btns = (payload.interactive?.action?.buttons || []).map(b => `[${b.reply?.title}]`).join(' ');
    return btns ? `${main}\n${btns}` : main;
  }
  return `[${payload.type}]`;
}

async function waSend(payload) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('[WA] Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID env vars');
    return { error: { message: 'WhatsApp no configurado' } };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[WA] send error', JSON.stringify(data));
      logDebug({ kind: 'send_error', status: res.status, data });
    } else {
      logDebug({ kind: 'send_ok', to: payload.to, type: payload.type });
      const waId = data?.messages?.[0]?.id;
      recordMessage(payload.to, 'out', payload.type, outboundBodyFor(payload), waId);
    }
    return data;
  } catch (err) {
    console.error('[WA] fetch failed', err.message);
    logDebug({ kind: 'send_fetch_failed', error: err.message });
    return { error: { message: err.message } };
  }
}

function sendWelcomeButtons(to) {
  return waSend({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: 'Hola! Bienvenido a *COLUMEN* - Estudio Legal & Notarial.\n\nPara orientarte mejor, seleccioná el área de tu consulta:' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'area_juridico', title: 'Jurídico' } },
          { type: 'reply', reply: { id: 'area_notarial', title: 'Notarial' } },
        ],
      },
    },
  });
}

function sendText(to, body) {
  return waSend({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body },
  });
}

// --- State machine del bot ---
const getState = (tel) => db.prepare('SELECT * FROM bot_state WHERE telefono = ?').get(tel);
const setState = (tel, fields) => {
  const existing = getState(tel);
  if (existing) {
    const keys = Object.keys(fields);
    const sets = keys.map(k => `${k} = ?`).join(', ') + ", updated_at = datetime('now','localtime')";
    db.prepare(`UPDATE bot_state SET ${sets} WHERE telefono = ?`).run(...keys.map(k => fields[k]), tel);
  } else {
    db.prepare('INSERT INTO bot_state (telefono, step, area, nombre, dni, email) VALUES (?,?,?,?,?,?)').run(
      tel, fields.step || null, fields.area || null, fields.nombre || null, fields.dni || null, fields.email || null
    );
  }
};
const clearState = (tel) => db.prepare('DELETE FROM bot_state WHERE telefono = ?').run(tel);

async function handleButtonReply(from, buttonId) {
  let area = null;
  if (buttonId === 'area_juridico') area = 'juridico';
  if (buttonId === 'area_notarial') area = 'notarial';
  if (!area) return;
  setState(from, { step: 'nombre', area });
  const label = area === 'juridico' ? 'Jurídico' : 'Notarial';
  await sendText(from, `Perfecto! Consulta *${label}* seleccionada.\n\nVamos a tomar tus datos. Por favor, escribí tu *nombre completo*:`);
}

async function handleTextInFlow(from, text) {
  const state = getState(from);
  if (!state || !state.step) {
    return sendWelcomeButtons(from);
  }
  const clean = (text || '').trim();
  if (!clean) return;

  if (state.step === 'nombre') {
    if (clean.length < 2) return sendText(from, 'El nombre parece muy corto. Por favor escribí tu nombre completo:');
    setState(from, { step: 'dni', nombre: clean });
    return sendText(from, `Gracias ${clean.split(' ')[0]}.\n\nAhora tu *número de DNI* (solo números):`);
  }

  if (state.step === 'dni') {
    const digits = clean.replace(/[.\s-]/g, '');
    if (!/^\d{7,10}$/.test(digits)) {
      return sendText(from, 'DNI inválido. Escribí solo los números (7 a 10 dígitos):');
    }
    setState(from, { step: 'email', dni: digits });
    return sendText(from, 'Perfecto.\n\nAhora tu *email*:');
  }

  if (state.step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return sendText(from, 'El email no parece válido. Probá de nuevo:');
    }
    setState(from, { step: 'consulta', email: clean });
    return sendText(from, 'Último paso.\n\n*Contanos brevemente tu consulta*:');
  }

  if (state.step === 'consulta') {
    if (clean.length < 5) return sendText(from, 'Por favor describí un poco más tu consulta:');
    const final = getState(from);
    db.prepare('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES (?,?,?,?,?,?)').run(
      from, final.area || '', final.nombre || '', final.dni || '', final.email || '', clean
    );
    snapshotDB('consulta');
    clearState(from);
    return sendText(from, `Gracias ${final.nombre?.split(' ')[0] || ''}! Tu consulta de tipo *${final.area === 'juridico' ? 'Jurídico' : 'Notarial'}* fue registrada correctamente.\n\nUn profesional de COLUMEN se va a comunicar con vos a la brevedad.`);
  }
}

// Debug endpoint - muestra ultimos eventos del bot
app.get('/bot-debug', (req, res) => {
  if (req.query.key !== 'columen-debug-2026') return res.status(403).json({ error: 'forbidden' });
  const states = db.prepare('SELECT * FROM bot_state ORDER BY updated_at DESC LIMIT 20').all();
  res.json({ events: debugLog.slice().reverse(), states });
});

// Webhook verification (GET) - Meta llama esto una vez para confirmar la URL
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('[WA] webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Webhook receiver (POST) - mensajes entrantes de WhatsApp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    logDebug({ kind: 'webhook_in', hasMsg: !!msg, msgType: msg?.type, from: msg?.from });
    if (!msg) return;

    if (processedMessages.has(msg.id)) { logDebug({ kind: 'dedup_skip', id: msg.id }); return; }
    processedMessages.add(msg.id);
    if (processedMessages.size > 500) {
      const first = processedMessages.values().next().value;
      processedMessages.delete(first);
    }

    const from = msg.from;
    console.log('[WA] msg from', from, 'type', msg.type);

    if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
      const br = msg.interactive.button_reply;
      recordMessage(from, 'in', 'button_reply', `[botón] ${br.title}`, msg.id);
      const conv = db.prepare('SELECT bot_paused FROM conversations WHERE telefono = ?').get(from);
      if (conv?.bot_paused) return;
      return handleButtonReply(from, br.id);
    }

    if (msg.type === 'text') {
      const body = msg.text?.body || '';
      recordMessage(from, 'in', 'text', body, msg.id);
      const conv = db.prepare('SELECT bot_paused FROM conversations WHERE telefono = ?').get(from);
      if (conv?.bot_paused) return;
      const state = getState(from);
      if (state && state.step) {
        return handleTextInFlow(from, body);
      }
      return sendWelcomeButtons(from);
    }

    recordMessage(from, 'in', msg.type, `[${msg.type}]`, msg.id);
  } catch (err) {
    console.error('[WA] webhook handler error', err);
  }
});

// --- Serve landing page ---
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Columen running on port ${PORT}`);
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
