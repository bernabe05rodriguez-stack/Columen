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

// Database - use /data if exists (Docker volume), fallback to ./data
const fs = require('fs');
const DB_DIR = fs.existsSync('/data') ? '/data' : './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'columen.db'));
db.pragma('journal_mode = WAL');
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
`);

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

// --- Admin dashboard ---
app.get('/admin', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');

  const consultas = db.prepare('SELECT * FROM consultas ORDER BY created_at DESC').all();
  const totalJuridico = db.prepare("SELECT COUNT(*) as c FROM consultas WHERE LOWER(area) LIKE '%juridic%'").get().c;
  const totalNotarial = db.prepare("SELECT COUNT(*) as c FROM consultas WHERE LOWER(area) LIKE '%notarial%'").get().c;
  const total = consultas.length;

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
</style></head><body>
<div class="topbar">
  <h1>COLUMEN</h1>
  <div><span style="color:#999;margin-right:16px">Admin</span><a href="/admin/logout">Salir</a></div>
</div>
<div class="stats">
  <div class="stat"><div class="num">${total}</div><div class="label">Total consultas</div></div>
  <div class="stat"><div class="num">${totalJuridico}</div><div class="label">Juridico</div></div>
  <div class="stat"><div class="num">${totalNotarial}</div><div class="label">Notarial</div></div>
</div>
<div class="table-wrap">
  ${total === 0 ? '<div class="empty">No hay consultas aun</div>' : `
  <table>
    <thead><tr><th>#</th><th>Fecha</th><th>Telefono</th><th>Area</th><th>Nombre</th><th>DNI</th><th>Email</th><th>Consulta</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}
</div>
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
  res.redirect(`/consulta?sent=1`);
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
