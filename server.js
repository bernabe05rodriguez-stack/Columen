const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 80;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'columen2026';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'columen-verify-2026';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://redhawk-columen.bm6z1s.easypanel.host';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL env var missing');
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });
const q = (sql, params) => pool.query(sql, params);

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS consultas (
    id SERIAL PRIMARY KEY,
    telefono TEXT,
    area TEXT,
    nombre TEXT,
    dni TEXT,
    email TEXT,
    consulta TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS bot_state (
    telefono TEXT PRIMARY KEY,
    step TEXT,
    area TEXT,
    nombre TEXT,
    dni TEXT,
    email TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  await q(`DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '1 day'`);
  console.log('[db] initialized');
}

initDb().catch(err => {
  console.error('[FATAL] DB init failed:', err);
  process.exit(1);
});

// Helper: format timestamp to Argentina local string for display
function formatAR(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }).replace('T', ' ').slice(0, 19);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Auth helpers ---
async function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO sessions (token) VALUES ($1)', [token]);
  return token;
}

async function isAuthenticated(req) {
  const token = req.cookies.session;
  if (!token) return false;
  const { rows } = await q("SELECT token FROM sessions WHERE token = $1 AND created_at > NOW() - INTERVAL '1 day'", [token]);
  return rows.length > 0;
}

// --- Webhook: legacy endpoint (por si algo quedó apuntando aca) ---
app.post('/api/webhook', async (req, res) => {
  const d = req.body || {};
  console.log('Webhook received:', JSON.stringify(d));
  await q('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES ($1,$2,$3,$4,$5,$6)',
    [d.telefono || '', d.area || '', d.nombre || '', d.dni || '', d.email || '', d.consulta || '']);
  res.json({ status: 'ok' });
});

// --- Admin login page ---
app.get('/admin/login', async (req, res) => {
  if (await isAuthenticated(req)) return res.redirect('/admin');
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

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = await createSession();
    res.cookie('session', token, { httpOnly: true, maxAge: 86400000, sameSite: 'lax' });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', async (req, res) => {
  const token = req.cookies.session;
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie('session');
  res.redirect('/admin/login');
});

// Lightweight count endpoint for auto-refresh
app.get('/admin/count', async (req, res) => {
  if (!(await isAuthenticated(req))) return res.status(401).json({ error: 'unauth' });
  const { rows } = await q('SELECT COUNT(*)::int as c FROM consultas');
  res.json({ count: rows[0].c });
});

// --- Admin dashboard ---
app.get('/admin', async (req, res) => {
  if (!(await isAuthenticated(req))) return res.redirect('/admin/login');

  const f = {
    q: (req.query.q || '').trim(),
    area: (req.query.area || '').trim(),
    desde: (req.query.desde || '').trim(),
    hasta: (req.query.hasta || '').trim(),
  };
  const where = [];
  const params = [];
  let i = 1;
  if (f.q) {
    where.push(`(nombre ILIKE $${i} OR dni ILIKE $${i} OR email ILIKE $${i} OR telefono ILIKE $${i} OR consulta ILIKE $${i})`);
    params.push(`%${f.q}%`); i++;
  }
  if (f.area) { where.push(`LOWER(area) LIKE $${i}`); params.push(`%${f.area.toLowerCase()}%`); i++; }
  if (f.desde) { where.push(`(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date >= $${i}::date`); params.push(f.desde); i++; }
  if (f.hasta) { where.push(`(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date <= $${i}::date`); params.push(f.hasta); i++; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows: consultas } = await q(`SELECT * FROM consultas ${whereSql} ORDER BY created_at DESC`, params);
  const { rows: [{ c: totalJuridico }] } = await q("SELECT COUNT(*)::int as c FROM consultas WHERE LOWER(area) LIKE '%juridic%'");
  const { rows: [{ c: totalNotarial }] } = await q("SELECT COUNT(*)::int as c FROM consultas WHERE LOWER(area) LIKE '%notarial%'");
  const { rows: [{ c: totalAll }] } = await q('SELECT COUNT(*)::int as c FROM consultas');
  const total = consultas.length;
  const filtered = total !== totalAll;

  const rows = consultas.map(c => `
    <tr>
      <td>${c.id}</td>
      <td>${escapeHtml(formatAR(c.created_at))}</td>
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
  <div><span style="color:#999;margin-right:16px">Admin</span><a href="/admin/logout">Salir</a></div>
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

app.post('/consulta', async (req, res) => {
  const { telefono, area, nombre, dni, email, consulta } = req.body;
  await q('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES ($1,$2,$3,$4,$5,$6)',
    [telefono || '', area || '', nombre || '', dni || '', email || '', consulta || '']);
  res.redirect(`/consulta?sent=1`);
});

// --- WhatsApp bot (Cloud API directo, sin Kapso) ---
const processedMessages = new Set();
const debugLog = [];
function logDebug(event) {
  debugLog.push({ ts: new Date().toISOString(), ...event });
  if (debugLog.length > 100) debugLog.shift();
}

async function waSend(payload) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('[WA] Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_ID env vars');
    return;
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
    }
    return data;
  } catch (err) {
    console.error('[WA] fetch failed', err.message);
    logDebug({ kind: 'send_fetch_failed', error: err.message });
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
async function getState(tel) {
  const { rows } = await q('SELECT * FROM bot_state WHERE telefono = $1', [tel]);
  return rows[0] || null;
}
async function setState(tel, fields) {
  const existing = await getState(tel);
  if (existing) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => fields[k]);
    await q(`UPDATE bot_state SET ${sets}, updated_at = NOW() WHERE telefono = $${keys.length + 1}`, [...values, tel]);
  } else {
    await q('INSERT INTO bot_state (telefono, step, area, nombre, dni, email) VALUES ($1,$2,$3,$4,$5,$6)',
      [tel, fields.step || null, fields.area || null, fields.nombre || null, fields.dni || null, fields.email || null]);
  }
}
async function clearState(tel) {
  await q('DELETE FROM bot_state WHERE telefono = $1', [tel]);
}

async function handleButtonReply(from, buttonId) {
  let area = null;
  if (buttonId === 'area_juridico') area = 'juridico';
  if (buttonId === 'area_notarial') area = 'notarial';
  if (!area) return;
  await setState(from, { step: 'nombre', area });
  const label = area === 'juridico' ? 'Jurídico' : 'Notarial';
  await sendText(from, `Perfecto! Consulta *${label}* seleccionada.\n\nVamos a tomar tus datos. Por favor, escribí tu *nombre completo*:`);
}

async function handleTextInFlow(from, text) {
  const state = await getState(from);
  if (!state || !state.step) {
    return sendWelcomeButtons(from);
  }
  const clean = (text || '').trim();
  if (!clean) return;

  if (state.step === 'nombre') {
    if (clean.length < 2) return sendText(from, 'El nombre parece muy corto. Por favor escribí tu nombre completo:');
    await setState(from, { step: 'dni', nombre: clean });
    return sendText(from, `Gracias ${clean.split(' ')[0]}.\n\nAhora tu *número de DNI* (solo números):`);
  }

  if (state.step === 'dni') {
    const digits = clean.replace(/[.\s-]/g, '');
    if (!/^\d{7,10}$/.test(digits)) {
      return sendText(from, 'DNI inválido. Escribí solo los números (7 a 10 dígitos):');
    }
    await setState(from, { step: 'email', dni: digits });
    return sendText(from, 'Perfecto.\n\nAhora tu *email*:');
  }

  if (state.step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      return sendText(from, 'El email no parece válido. Probá de nuevo:');
    }
    await setState(from, { step: 'consulta', email: clean });
    return sendText(from, 'Último paso.\n\n*Contanos brevemente tu consulta*:');
  }

  if (state.step === 'consulta') {
    if (clean.length < 5) return sendText(from, 'Por favor describí un poco más tu consulta:');
    const final = await getState(from);
    await q('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES ($1,$2,$3,$4,$5,$6)',
      [from, final.area || '', final.nombre || '', final.dni || '', final.email || '', clean]);
    await clearState(from);
    return sendText(from, `Gracias ${final.nombre?.split(' ')[0] || ''}! Tu consulta de tipo *${final.area === 'juridico' ? 'Jurídico' : 'Notarial'}* fue registrada correctamente.\n\nUn profesional de COLUMEN se va a comunicar con vos a la brevedad.`);
  }
}

// Debug endpoint - muestra ultimos eventos del bot
app.get('/bot-debug', async (req, res) => {
  if (req.query.key !== 'columen-debug-2026') return res.status(403).json({ error: 'forbidden' });
  const { rows: states } = await q('SELECT * FROM bot_state ORDER BY updated_at DESC LIMIT 20');
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
      return handleButtonReply(from, msg.interactive.button_reply.id);
    }

    if (msg.type === 'text') {
      const body = msg.text?.body || '';
      const state = await getState(from);
      if (state && state.step) {
        return handleTextInFlow(from, body);
      }
      return sendWelcomeButtons(from);
    }
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
