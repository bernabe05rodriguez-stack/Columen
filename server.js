const express = require('express');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Config centralizada — único lugar que lee process.env.*
const config = require('./src/config');
const {
  NODE_ENV, IS_PROD, PORT,
  ADMIN_USER, ADMIN_PASS, ADMIN_PASS_HASH, SESSION_SECRET,
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN, APP_SECRET,
  RECONTACT_TEMPLATE_NAME, RECONTACT_TEMPLATE_LANG, RECONTACT_TEMPLATE_PREVIEW,
  PUBLIC_URL,
  BACKUP_OFFSITE_TOKEN, BACKUP_OFFSITE_REPO, BACKUP_OFFSITE_BRANCH,
} = config;
config.logConfigWarnings();

const app = express();

// Anonimiza teléfono para logs en producción (mantiene 4 últimos dígitos)
function maskTel(tel) {
  if (!tel || typeof tel !== 'string') return '?';
  if (!IS_PROD) return tel;
  return tel.length > 4 ? '+...' + tel.slice(-4) : tel;
}

// Database — abierta y configurada en src/db/index.js (única fuente de verdad)
const fs = require('fs');
const dbModule = require('./src/db');
const { db, runMigration, DB_PATH, BACKUP_DIR, DB_DIR } = dbModule;
const BACKUP_KEEP = 50;
// BACKUP_OFFSITE_TOKEN/REPO/BRANCH ya importados desde src/config arriba

async function pushBackupOffsite(localPath, repoPath) {
  if (!BACKUP_OFFSITE_TOKEN || !BACKUP_OFFSITE_REPO) return;
  try {
    const buf = fs.readFileSync(localPath);
    const content = buf.toString('base64');
    const url = `https://api.github.com/repos/${BACKUP_OFFSITE_REPO}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(BACKUP_OFFSITE_BRANCH)}`;
    const headers = {
      Authorization: `Bearer ${BACKUP_OFFSITE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    let sha = null;
    try {
      const head = await fetch(url, { headers });
      if (head.ok) sha = (await head.json()).sha;
    } catch {}
    const putUrl = `https://api.github.com/repos/${BACKUP_OFFSITE_REPO}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
    const body = { message: `backup: ${repoPath} (${new Date().toISOString()})`, content, branch: BACKUP_OFFSITE_BRANCH };
    if (sha) body.sha = sha;
    const r = await fetch(putUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const t = await r.text();
      console.error('[backup-offsite] failed', r.status, t.slice(0, 200));
      return false;
    }
    console.log('[backup-offsite] pushed', repoPath, `(${(buf.length/1024).toFixed(1)} KB)`);
    return true;
  } catch (e) {
    console.error('[backup-offsite] error', e.message);
    return false;
  }
}

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
    if (reason === 'hourly' || reason === 'startup' || reason === 'manual') {
      const today = new Date().toISOString().slice(0, 10);
      (async () => {
        try {
          await pushBackupOffsite(dst, 'snapshots/latest.db');
          await pushBackupOffsite(dst, `snapshots/daily/columen-${today}.db`);
        } catch {}
      })();
    }
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

// _migrations table + runMigration() ya inicializados por src/db
// Pre-existing rows were stored in UTC (before TZ was set). Shift them -3h to Argentina time.
runMigration('fix_tz_argentina_2026_04', () => {
  db.prepare("UPDATE consultas SET created_at = datetime(created_at, '-3 hours')").run();
});
runMigration('add_media_fields_2026_04', () => {
  try { db.exec('ALTER TABLE messages ADD COLUMN media_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN media_mime TEXT'); } catch {}
});
runMigration('add_status_field_2026_04', () => {
  try { db.exec('ALTER TABLE messages ADD COLUMN status TEXT'); } catch {}
});
runMigration('add_labels_2026_04', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#8a6d2b',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_labels (
    telefono TEXT,
    label_id INTEGER,
    PRIMARY KEY (telefono, label_id)
  )`);
  const existing = db.prepare('SELECT COUNT(*) as c FROM labels').get().c;
  if (!existing) {
    const colors = ['#1a5cb0', '#8a6d2b', '#c23b1e', '#2e7d32', '#6a1b9a'];
    ['Jurídico','Notarial','Urgente','Cerrado','Seguimiento'].forEach((n,i) =>
      db.prepare('INSERT OR IGNORE INTO labels (name, color) VALUES (?,?)').run(n, colors[i])
    );
  }
});
runMigration('add_indexes_2026_04', () => {
  // Aditivas: solo CREATE INDEX IF NOT EXISTS, nunca tocan datos
  db.exec('CREATE INDEX IF NOT EXISTS idx_consultas_area ON consultas(area)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_consultas_created ON consultas(created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status) WHERE status IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_last_at ON conversations(last_at DESC)');
});
runMigration('processed_messages_2026_04', () => {
  // Reemplaza el Set en memoria — sobrevive a restarts
  db.exec(`CREATE TABLE IF NOT EXISTS processed_messages (
    wa_id TEXT PRIMARY KEY,
    processed_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);
});
runMigration('add_templates_2026_04', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);
  // Seed con plantillas frecuentes de un estudio legal
  const existing = db.prepare('SELECT COUNT(*) as c FROM templates').get().c;
  if (!existing) {
    const seeds = [
      ['Saludo inicial', 'Hola, gracias por contactarte con Columen. Soy parte del equipo y estaré asistiéndote.'],
      ['Pedido de DNI', 'Para avanzar con tu consulta necesito que me envíes una foto del DNI (frente y dorso).'],
      ['Pedido de documentación', 'Para analizar tu caso necesito que me envíes la documentación correspondiente. Podés mandar fotos o PDF por acá mismo.'],
      ['Honorarios', 'Los honorarios se acuerdan por escrito antes de iniciar el trabajo, conforme a las pautas del Colegio de Abogados de Mendoza. ¿Querés que te detalle el costo de tu caso?'],
      ['Cierre + agenda', 'Perfecto. Te confirmo la reunión y te paso el resumen por acá. Cualquier consulta, escribime.'],
      ['Fuera de horario', 'Recibimos tu mensaje fuera del horario de atención (Lun-Vie 9 a 18 hs Mendoza). Te respondemos en cuanto retomemos.'],
    ];
    seeds.forEach(([n, b]) => db.prepare('INSERT INTO templates (name, body) VALUES (?,?)').run(n, b));
  }
});

// Cleanup old sessions (older than 24h) y processed_messages (older than 7 días)
db.exec(`DELETE FROM sessions WHERE created_at < datetime('now', '-1 day')`);
db.exec(`DELETE FROM processed_messages WHERE processed_at < datetime('now', '-7 days')`);
// Cleanup periódico cada 6h
setInterval(() => {
  try {
    db.exec(`DELETE FROM sessions WHERE created_at < datetime('now', '-1 day')`);
    db.exec(`DELETE FROM processed_messages WHERE processed_at < datetime('now', '-7 days')`);
  } catch (e) { console.error('[cleanup] error', e.message); }
}, 6 * 60 * 60 * 1000);

app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    // Only the Meta webhook needs raw body for HMAC verification
    if (req.originalUrl === '/webhook') req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// --- Security headers (helmet) ---
// CSP afinado: admin tiene mucho inline JS/CSS; emojis base64; Google Fonts; media de Meta CDN
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'https:', 'blob:'],
      'media-src': ["'self'", 'blob:', 'https:'],
      'connect-src': ["'self'", 'https://graph.facebook.com'],
      'frame-src': ['https://www.google.com', 'https://maps.google.com'],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': [],
    },
  },
  crossOriginEmbedderPolicy: false, // permite que admin/media (Meta CDN) se embeba
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

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

// --- Meta webhook signature verification (X-Hub-Signature-256) ---
function verifyMetaSignature(req, res, next) {
  if (!APP_SECRET) {
    console.error('[WA] webhook rejected: APP_SECRET not configured');
    return res.status(500).send('server misconfigured');
  }
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !sig.startsWith('sha256=')) {
    return res.status(401).send('missing signature');
  }
  const provided = sig.slice(7);
  const raw = req.rawBody || Buffer.from('');
  const expected = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  let ok = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn('[WA] webhook rejected: invalid signature');
    return res.status(401).send('invalid signature');
  }
  next();
}

// --- CSRF protection (double-submit cookie) ---
// La cookie csrf NO es httpOnly (el JS la lee y la envía como header X-CSRF-Token).
// SameSite=strict garantiza que solo se envíe en navegación same-site.
function ensureCsrfToken(req, res) {
  let token = req.cookies && req.cookies['csrf'];
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf', token, {
      httpOnly: false,
      sameSite: 'strict',
      secure: IS_PROD,
      maxAge: 86400000,
      path: '/',
    });
    if (req.cookies) req.cookies['csrf'] = token;
  }
  return token;
}
function requireCsrf(req, res, next) {
  const cookieToken = req.cookies && req.cookies['csrf'];
  const headerToken = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  if (!cookieToken || !headerToken) return res.status(403).json({ error: 'csrf_missing' });
  let ok = false;
  try {
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { ok = false; }
  if (!ok) return res.status(403).json({ error: 'csrf_invalid' });
  next();
}
// Generar/refrescar token al cargar cualquier GET de /admin
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path.startsWith('/admin')) ensureCsrfToken(req, res);
  next();
});

// --- Login rate limiter (anti brute-force) ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiados intentos. Probá de nuevo en 15 minutos.',
});

// --- Admin login page ---
app.get('/admin/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/admin');
  const error = req.query.error ? '<div class="err">Usuario o contraseña incorrectos</div>' : '';
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin · COLUMEN</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--navy:#1a2744;--navy-2:#233050;--cream:#f4f0e4;--cream-2:#ece6d5;--cream-border:#d8d0bc;--gold:#8a6d2b;--gold-soft:#b8974a;--ink:#1c1c1c;--accent:#6aacd6}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--navy);position:relative;overflow:hidden}
  body::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 900px 700px at 80% 10%,rgba(184,151,74,.18),transparent 60%),radial-gradient(ellipse 700px 600px at 0% 100%,rgba(106,172,214,.12),transparent 65%);pointer-events:none}
  body::after{content:'';position:absolute;inset:0;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .5 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");opacity:.06;mix-blend-mode:soft-light;pointer-events:none}
  .card{background:#fff;border-radius:20px;padding:48px 44px 38px;width:100%;max-width:440px;box-shadow:0 30px 80px -20px rgba(0,0,0,.5),0 8px 24px -8px rgba(0,0,0,.25);position:relative;z-index:1;border:1px solid rgba(255,255,255,.08)}
  .logo{display:flex;justify-content:center;margin-bottom:22px}
  .logo svg{width:200px;height:auto;max-width:100%}
  @media(max-width:480px){
    body{padding:16px;align-items:flex-start;padding-top:8vh}
    .card{padding:36px 24px 28px;border-radius:18px}
    .logo svg{width:170px}
    .sub{font-size:11px;letter-spacing:.16em;margin-bottom:24px}
    label{font-size:11px}
    input{font-size:16px;padding:13px 14px}
    button{padding:14px;font-size:15px}
  }
  .sub{color:var(--gold);font-size:11.5px;text-align:center;margin-bottom:28px;letter-spacing:.18em;text-transform:uppercase;font-weight:500}
  .err{background:#fdf0ee;border:1px solid #f5d6cf;color:#a3372a;padding:11px 14px;border-radius:10px;font-size:13.5px;margin-bottom:18px;text-align:center}
  label{display:block;font-size:11.5px;font-weight:600;color:var(--gold);margin-bottom:7px;letter-spacing:.08em;text-transform:uppercase}
  input{width:100%;padding:12px 14px;border:1.5px solid var(--cream-border);border-radius:10px;font-size:15px;margin-bottom:16px;outline:none;font-family:inherit;color:var(--ink);background:#fcfaf3;transition:border-color .2s,box-shadow .2s,background .2s}
  input:focus{border-color:var(--gold-soft);background:#fff;box-shadow:0 0 0 4px rgba(184,151,74,.12)}
  button{width:100%;padding:14px;background:var(--navy);color:var(--cream);border:none;border-radius:10px;font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;letter-spacing:.02em;transition:background .2s,box-shadow .2s,transform .1s;margin-top:6px}
  button:hover{background:var(--navy-2);box-shadow:0 8px 20px -6px rgba(26,39,68,.4)}
  button:active{transform:scale(.98)}
  .foot{margin-top:22px;text-align:center;font-size:12px;color:rgba(28,28,28,.45)}
</style></head><body>
<div class="card">
  <div class="logo">
    <svg viewBox="0 0 690 170" xmlns="http://www.w3.org/2000/svg">
      <circle cx="62" cy="84" r="43" fill="none" stroke="#1a2744" stroke-width="2"/>
      <path d="M 92.3 68.6 A 34 34 0 1 0 92.3 99.4" fill="none" stroke="#6aacd6" stroke-width="5.5" stroke-linecap="round"/>
      <circle cx="92.3" cy="68.6" r="4.6" fill="#6aacd6"/>
      <circle cx="92.3" cy="99.4" r="4.6" fill="#6aacd6"/>
      <line x1="124" y1="42" x2="124" y2="128" stroke="#1a2744" stroke-width="1.2" opacity="0.35"/>
      <text x="140" y="98" font-family="'Lora',Georgia,serif" font-size="56" font-weight="700" letter-spacing="5" fill="#1a2744">COLUMEN</text>
      <text x="142" y="126" font-family="'Inter',sans-serif" font-size="14.5" font-weight="600" letter-spacing="5" fill="#1a2744">LEGAL &amp; NOTARIAL</text>
    </svg>
  </div>
  <div class="sub">Panel de Administración</div>
  ${error}
  <form method="POST" action="/admin/login">
    <label>Usuario</label>
    <input type="text" name="username" required autofocus autocomplete="username">
    <label>Contraseña</label>
    <input type="password" name="password" required autocomplete="current-password">
    <button type="submit">Ingresar</button>
  </form>
  <div class="foot">© ${new Date().getFullYear()} Columen Legal &amp; Notarial</div>
</div></body></html>`);
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  let ok = false;
  if (username === ADMIN_USER && typeof password === 'string') {
    if (ADMIN_PASS_HASH) {
      try { ok = bcrypt.compareSync(password, ADMIN_PASS_HASH); } catch { ok = false; }
    } else if (ADMIN_PASS) {
      // Plaintext fallback (one-deploy compat). Logged so we know to remove it.
      ok = password === ADMIN_PASS;
      if (ok) console.warn('[auth] login via plaintext ADMIN_PASS — migrate to ADMIN_PASS_HASH');
    }
  }
  if (ok) {
    const token = createSession();
    res.cookie('session', token, {
      httpOnly: true,
      maxAge: 86400000,
      sameSite: 'strict',
      secure: IS_PROD,
      path: '/',
    });
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

// Export consultas a CSV (con filtros opcionales)
app.get('/admin/export.csv', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).send('unauth');
  const where = [];
  const params = [];
  const q = (req.query.q || '').trim();
  const area = (req.query.area || '').trim();
  const desde = (req.query.desde || '').trim();
  const hasta = (req.query.hasta || '').trim();
  if (q) {
    where.push('(nombre LIKE ? OR dni LIKE ? OR email LIKE ? OR telefono LIKE ? OR consulta LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like, like);
  }
  if (area) { where.push('LOWER(area) LIKE ?'); params.push('%' + area.toLowerCase() + '%'); }
  if (desde) { where.push("date(created_at) >= date(?)"); params.push(desde); }
  if (hasta) { where.push("date(created_at) <= date(?)"); params.push(hasta); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT id, created_at, telefono, area, nombre, dni, email, consulta FROM consultas ${whereSql} ORDER BY created_at DESC`).all(...params);
  // CSV escape: " → "" y wrap si contiene , " \n \r ;
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const fname = 'columen-consultas-' + new Date().toISOString().slice(0,10) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  // BOM para que Excel detecte UTF-8 correctamente
  res.write('﻿');
  res.write(['id','fecha','telefono','area','nombre','dni','email','consulta'].join(',') + '\r\n');
  for (const r of rows) {
    res.write([r.id, r.created_at, r.telefono, r.area, r.nombre, r.dni, r.email, r.consulta].map(csvCell).join(',') + '\r\n');
  }
  res.end();
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

  const rows = consultas.map(c => {
    const isJ = c.area?.toLowerCase().includes('juridic');
    return `
    <tr>
      <td class="muted" data-label="#">#${c.id}</td>
      <td class="nowrap muted" data-label="Fecha">${escapeHtml(c.created_at || '')}</td>
      <td class="nowrap" data-label="Teléfono"><a class="tel" href="/admin/inbox?tel=${encodeURIComponent(c.telefono)}" title="Abrir chat">${escapeHtml(c.telefono)}</a></td>
      <td data-label="Área"><span class="badge ${isJ ? 'badge-j' : 'badge-n'}"><span class="dot"></span>${escapeHtml(c.area)}</span></td>
      <td class="strong" data-label="Nombre">${escapeHtml(c.nombre)}</td>
      <td class="muted" data-label="DNI">${escapeHtml(c.dni)}</td>
      <td class="muted" data-label="Email">${escapeHtml(c.email)}</td>
      <td class="consulta-cell" data-label="Consulta" title="${escapeHtml(c.consulta)}">${escapeHtml(c.consulta)}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Consultas · COLUMEN Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--navy:#1a2744;--navy-2:#233050;--cream:#f4f0e4;--cream-2:#ece6d5;--cream-border:#d8d0bc;--gold:#8a6d2b;--gold-soft:#b8974a;--ink:#1c1c1c;--ink-55:rgba(28,28,28,.58);--ink-25:rgba(28,28,28,.25);--accent:#6aacd6;--card-border:#e8e2cf;--surface:#fffdf6}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scrollbar-gutter:stable}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--cream);color:var(--ink);min-height:100dvh;font-size:14px}
  .topbar{background:var(--navy);color:var(--cream);padding:14px 28px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:30;box-shadow:0 1px 0 rgba(255,255,255,.04),0 2px 14px -6px rgba(0,0,0,.4);font-family:'Inter',system-ui,sans-serif}
  .brand{display:flex;align-items:center;gap:12px;text-decoration:none}
  .brand svg{height:60px;width:auto;display:block;max-width:100%}
  .nav{display:flex;align-items:center;gap:6px}
  .nav a{color:rgba(244,240,228,.62);font-size:13px;text-decoration:none;padding:8px 14px;border-radius:8px;transition:background .15s,color .15s;letter-spacing:.02em;white-space:nowrap}
  .nav a:hover{color:var(--cream);background:rgba(255,255,255,.06)}
  .nav a.active{color:var(--cream);background:rgba(184,151,74,.18);box-shadow:inset 0 -2px 0 var(--gold-soft)}
  .nav .sep{width:1px;height:18px;background:rgba(255,255,255,.1);margin:0 6px}
  .nav .logout{color:rgba(244,240,228,.5)}
  .nav .logout:hover{color:#f4d6d6;background:rgba(195,80,80,.12)}
  main{max-width:1400px;margin:0 auto;padding:28px 28px 60px}
  .page-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:24px;flex-wrap:wrap;gap:16px}
  .page-head h1{font-family:'Lora',Georgia,serif;font-size:32px;font-weight:600;color:var(--navy);letter-spacing:-.01em;line-height:1.1}
  .page-head .lead{color:var(--ink-55);font-size:14px;margin-top:6px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px}
  .stat{background:var(--surface);border:1px solid var(--card-border);border-radius:14px;padding:22px 24px;position:relative;overflow:hidden;transition:transform .35s cubic-bezier(.2,.8,.2,1),box-shadow .3s,border-color .25s}
  .stat::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--gold-soft);opacity:.55;border-radius:14px 14px 0 0}
  .stat.s-j::after{background:var(--accent)}
  .stat.s-n::after{background:var(--gold)}
  .stat:hover{transform:translateY(-2px);box-shadow:0 14px 30px -10px rgba(26,39,68,.16);border-color:#dcd5c0}
  .stat .num{font-family:'Lora',serif;font-size:36px;font-weight:700;color:var(--navy);letter-spacing:-.02em;line-height:1}
  .stat .label{font-size:11.5px;color:var(--gold);text-transform:uppercase;letter-spacing:.12em;margin-top:8px;font-weight:600}
  .stat .ico{position:absolute;top:18px;right:18px;width:30px;height:30px;color:var(--gold-soft);opacity:.45}
  .stat .ico svg{width:100%;height:100%}
  .panel{background:var(--surface);border:1px solid var(--card-border);border-radius:14px;overflow:hidden;box-shadow:0 6px 24px -10px rgba(26,39,68,.1)}
  .filters{padding:18px 22px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;border-bottom:1px solid var(--card-border);background:linear-gradient(180deg,#fffefa,var(--surface))}
  .f{display:flex;flex-direction:column;gap:6px;flex:0 0 auto}
  .f.grow{flex:1 1 240px;min-width:200px}
  .f label{font-size:11px;color:var(--gold);text-transform:uppercase;letter-spacing:.1em;font-weight:600}
  .f input,.f select{padding:10px 12px;border:1.5px solid var(--cream-border);border-radius:9px;font-size:13.5px;font-family:inherit;background:#fff;outline:none;color:var(--ink);transition:border-color .15s,box-shadow .15s}
  .f input::placeholder{color:rgba(28,28,28,.35)}
  .f input:focus,.f select:focus{border-color:var(--gold-soft);box-shadow:0 0 0 4px rgba(184,151,74,.13)}
  .f-actions{display:flex;gap:8px;align-items:center;align-self:flex-end}
  .btn{padding:10px 18px;background:var(--navy);color:var(--cream);border:none;border-radius:9px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:7px;font-family:inherit;transition:background .2s,box-shadow .2s,transform .1s}
  .btn:hover{background:var(--navy-2);box-shadow:0 6px 16px -6px rgba(26,39,68,.4)}
  .btn:active{transform:scale(.97)}
  .btn.ghost{background:transparent;color:var(--ink);border:1.5px solid var(--cream-border)}
  .btn.ghost:hover{background:var(--cream-2);border-color:var(--cream-border);box-shadow:none}
  .filter-info{padding:10px 22px;font-size:12.5px;color:var(--gold);background:rgba(184,151,74,.06);border-bottom:1px solid var(--card-border);display:flex;align-items:center;gap:8px}
  .filter-info::before{content:'•';color:var(--gold-soft);font-size:18px;line-height:1}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse}
  thead th{background:var(--navy);color:rgba(244,240,228,.92);padding:11px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.1em;text-align:left;font-weight:600;white-space:nowrap}
  thead th:first-child{padding-left:22px}
  thead th:last-child{padding-right:22px}
  tbody td{padding:13px 14px;border-bottom:1px solid #eee8d9;font-size:13.5px;vertical-align:top}
  tbody td:first-child{padding-left:22px}
  tbody td:last-child{padding-right:22px}
  tbody tr{transition:background .15s}
  tbody tr:hover td{background:#faf6ea}
  tbody tr:last-child td{border-bottom:none}
  td.muted{color:var(--ink-55);font-size:13px}
  td.nowrap{white-space:nowrap}
  td.strong{font-weight:600;color:var(--navy)}
  td .tel{color:var(--navy);text-decoration:none;font-weight:500;border-bottom:1px dashed rgba(26,39,68,.25);transition:color .15s,border-color .15s}
  td .tel:hover{color:var(--gold);border-bottom-color:var(--gold-soft)}
  .badge{padding:4px 10px 4px 8px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:.02em;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
  .badge .dot{width:6px;height:6px;border-radius:50%;display:inline-block}
  .badge-j{background:rgba(106,172,214,.16);color:#1a5384}
  .badge-j .dot{background:#3892ce}
  .badge-n{background:rgba(184,151,74,.16);color:var(--gold)}
  .badge-n .dot{background:var(--gold-soft)}
  .consulta-cell{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);font-size:13px}
  .empty{text-align:center;padding:80px 24px;color:var(--ink-55);font-size:15px;background:var(--surface)}
  .empty .ico{width:48px;height:48px;color:var(--gold-soft);opacity:.4;margin:0 auto 14px}
  .empty .ico svg{width:100%;height:100%}
  .empty strong{display:block;color:var(--ink);font-size:16px;margin-bottom:4px;font-weight:600}
  @media(max-width:880px){
    .stats{grid-template-columns:1fr 1fr;gap:10px}
    main{padding:18px 14px 40px}
    .topbar{padding:10px 14px;gap:8px}
    .brand svg{height:50px}
    .nav a{padding:7px 10px;font-size:12.5px}
    .page-head h1{font-size:24px}
    .filters{padding:14px}
    .f.grow{flex-basis:100%}
    .stat{padding:18px 18px}
    .stat .num{font-size:30px}
    .stat .ico{width:24px;height:24px;top:14px;right:14px}
  }
  @media(max-width:560px){
    .stats{grid-template-columns:1fr 1fr;gap:8px}
    .brand svg{height:42px}
    .topbar{padding:8px 10px;gap:6px;flex-wrap:wrap}
    .nav{gap:2px;flex-wrap:wrap;justify-content:flex-end}
    .nav a{padding:6px 9px;font-size:12px;letter-spacing:0}
    .nav .sep{display:none}
    .page-head h1{font-size:22px}
    .stat{padding:14px 16px}
    .stat .num{font-size:24px}
    .stat .label{font-size:10.5px;letter-spacing:.1em;margin-top:4px}
    .stat .ico{display:none}
    .filters{padding:12px;gap:8px}
    .f input,.f select{font-size:16px;padding:11px 12px}
    .f-actions{width:100%}
    .f-actions .btn{flex:1;justify-content:center}
    .panel{border-radius:10px}
    /* Tabla → stack de cards en mobile */
    table,thead,tbody,tr,td{display:block;width:100%}
    thead{display:none}
    tbody tr{padding:14px 16px;border-bottom:1px solid #eee8d9;position:relative}
    tbody tr:last-child{border-bottom:none}
    tbody td{padding:3px 0;border:none;font-size:13.5px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    tbody td:first-child,tbody td:last-child{padding-left:0;padding-right:0}
    tbody td::before{content:attr(data-label);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--gold);font-weight:600;flex-shrink:0;margin-top:2px;min-width:64px}
    tbody td.consulta-cell{flex-direction:column;align-items:flex-start;max-width:none;white-space:normal;padding-top:8px;border-top:1px dashed #e6dfca;margin-top:6px}
    tbody td.consulta-cell::before{margin-bottom:4px}
    tbody tr:hover td{background:transparent}
  }
</style></head><body>
<div class="topbar">
  <a href="/admin" class="brand" aria-label="Columen Admin">
    <svg viewBox="0 0 690 170" xmlns="http://www.w3.org/2000/svg">
      <circle cx="62" cy="84" r="43" fill="none" stroke="#ffffff" stroke-width="2.2"/>
      <path d="M 92.3 68.6 A 34 34 0 1 0 92.3 99.4" fill="none" stroke="#6aacd6" stroke-width="6" stroke-linecap="round"/>
      <circle cx="92.3" cy="68.6" r="5" fill="#6aacd6"/>
      <circle cx="92.3" cy="99.4" r="5" fill="#6aacd6"/>
      <line x1="124" y1="42" x2="124" y2="128" stroke="#ffffff" stroke-width="1.4" opacity="0.5"/>
      <text x="140" y="98" font-family="'Lora',Georgia,serif" font-size="56" font-weight="700" letter-spacing="5" fill="#ffffff">COLUMEN</text>
      <text x="142" y="126" font-family="'Inter',sans-serif" font-size="14.5" font-weight="600" letter-spacing="5" fill="#ffffff">LEGAL &amp; NOTARIAL</text>
    </svg>
  </a>
  <nav class="nav">
    <a href="/admin" class="active">Consultas</a>
    <a href="/admin/inbox">WhatsApp</a>
    <a href="/admin/backup">Backup</a>
    <span class="sep"></span>
    <a href="/admin/logout" class="logout">Salir</a>
  </nav>
</div>
<main>
  <div class="page-head">
    <div>
      <h1>Consultas</h1>
      <div class="lead">Lead capturados por el bot de WhatsApp y el formulario web.</div>
    </div>
  </div>
  <div class="stats">
    <div class="stat">
      <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg></div>
      <div class="num">${totalAll}</div>
      <div class="label">Total consultas</div>
    </div>
    <div class="stat s-j">
      <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 7l7-4 7 4"/><path d="M5 7l-2 8h4l-2-8zM19 7l-2 8h4l-2-8z"/><line x1="2" y1="21" x2="22" y2="21"/></svg></div>
      <div class="num">${totalJuridico}</div>
      <div class="label">Jurídico</div>
    </div>
    <div class="stat s-n">
      <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21h14M7 21v-2a2 2 0 012-2h6a2 2 0 012 2v2M12 13V7M8 13h8a2 2 0 012 2H6a2 2 0 012-2z"/><circle cx="12" cy="5" r="2"/></svg></div>
      <div class="num">${totalNotarial}</div>
      <div class="label">Notarial</div>
    </div>
  </div>
  <div class="panel">
    <form class="filters" method="get" action="/admin">
      <div class="f grow"><label>Buscar</label><input type="text" name="q" value="${escapeHtml(f.q)}" placeholder="Nombre, DNI, email, teléfono o texto…"></div>
      <div class="f"><label>Área</label>
        <select name="area">
          <option value="">Todas</option>
          <option value="juridico" ${f.area === 'juridico' ? 'selected' : ''}>Jurídico</option>
          <option value="notarial" ${f.area === 'notarial' ? 'selected' : ''}>Notarial</option>
        </select>
      </div>
      <div class="f"><label>Desde</label><input type="date" name="desde" value="${escapeHtml(f.desde)}"></div>
      <div class="f"><label>Hasta</label><input type="date" name="hasta" value="${escapeHtml(f.hasta)}"></div>
      <div class="f-actions">
        <button type="submit" class="btn">Filtrar</button>
        ${filtered ? '<a href="/admin" class="btn ghost">Limpiar</a>' : ''}
        <a href="/admin/export.csv?${new URLSearchParams({q:f.q,area:f.area,desde:f.desde,hasta:f.hasta}).toString()}" class="btn ghost" title="Descargar CSV de las consultas filtradas">⬇ CSV</a>
      </div>
    </form>
    ${filtered ? `<div class="filter-info">Mostrando ${total} de ${totalAll} consultas</div>` : ''}
    <div class="table-wrap">
      ${total === 0 ? `<div class="empty"><div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg></div><strong>${filtered ? 'Sin resultados' : 'Aún no hay consultas'}</strong>${filtered ? 'Probá con otros filtros o limpiá la búsqueda' : 'Cuando lleguen, las verás aquí en tiempo real'}</div>` : `
      <table>
        <thead><tr><th>#</th><th>Fecha</th><th>Teléfono</th><th>Área</th><th>Nombre</th><th>DNI</th><th>Email</th><th>Consulta</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    </div>
  </div>
</main>
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
    const m = f.match(/columen-(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-?(.*)\.db/);
    const pretty = m ? `${m[1]} ${m[2].replace(/-/g,':')}${m[3] ? ` · <span class="reason">${escapeHtml(m[3])}</span>` : ''}` : escapeHtml(f);
    return `<tr><td><div class="when">${pretty}</div><code class="fn">${escapeHtml(f)}</code></td><td class="muted nowrap">${size} KB</td><td class="nowrap"><a class="dl" href="/admin/backup/download?file=${encodeURIComponent(f)}">Descargar</a></td></tr>`;
  }).join('');

  // Snapshot textual de consultas (solo lectura, no modifica nada)
  const allConsultas = db.prepare(
    'SELECT id, created_at, telefono, area, nombre, dni, email, consulta FROM consultas ORDER BY created_at DESC'
  ).all();
  const totalConsultas = allConsultas.length;
  const todayStr = db.prepare("SELECT date('now','localtime') AS d").get().d; // YYYY-MM-DD en TZ Argentina
  const byDay = new Map();
  for (const c of allConsultas) {
    const day = (c.created_at || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const consultasHoy = byDay.get(todayStr) || [];
  const dayLabels = { 0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado' };
  function prettyDay(d) {
    if (!d) return '';
    const [y, m, da] = d.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, da));
    return `${dayLabels[date.getUTCDay()]} ${String(da).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
  }
  function consultaRow(c) {
    const isJ = (c.area || '').toLowerCase().includes('juridic');
    const hora = (c.created_at || '').slice(11, 16);
    return `<tr>
      <td class="muted nowrap" data-label="#">#${c.id}</td>
      <td class="nowrap muted" data-label="Hora">${escapeHtml(hora)}</td>
      <td class="nowrap" data-label="Teléfono"><a class="tel" href="/admin/inbox?tel=${encodeURIComponent(c.telefono || '')}" title="Abrir chat">${escapeHtml(c.telefono || '')}</a></td>
      <td data-label="Área"><span class="badge ${isJ ? 'badge-j' : 'badge-n'}"><span class="dot"></span>${escapeHtml(c.area || '')}</span></td>
      <td class="strong" data-label="Nombre">${escapeHtml(c.nombre || '')}</td>
      <td class="muted" data-label="DNI">${escapeHtml(c.dni || '')}</td>
      <td class="muted" data-label="Email">${escapeHtml(c.email || '')}</td>
      <td class="consulta-cell" data-label="Consulta" title="${escapeHtml(c.consulta || '')}">${escapeHtml(c.consulta || '')}</td>
    </tr>`;
  }
  function consultasTable(rows) {
    return `<table class="cs-tbl"><thead><tr><th>#</th><th>Hora</th><th>Tel</th><th>Área</th><th>Nombre</th><th>DNI</th><th>Email</th><th>Consulta</th></tr></thead><tbody>${rows.map(consultaRow).join('')}</tbody></table>`;
  }
  const hoyHtml = consultasHoy.length
    ? consultasTable(consultasHoy)
    : '<div class="empty">Sin consultas hoy.</div>';
  const sortedDays = [...byDay.keys()].sort().reverse();
  const historialHtml = sortedDays.length
    ? sortedDays.map(d => {
        const rows = byDay.get(d);
        const isToday = d === todayStr;
        return `<details class="day"${isToday ? ' open' : ''}>
          <summary><span class="day-name">${escapeHtml(prettyDay(d))}</span><span class="day-count">${rows.length} ${rows.length === 1 ? 'consulta' : 'consultas'}</span></summary>
          <div class="day-body">${consultasTable(rows)}</div>
        </details>`;
      }).join('')
    : '<div class="empty">Aún no hay consultas registradas.</div>';
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backup · COLUMEN Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--navy:#1a2744;--navy-2:#233050;--cream:#f4f0e4;--cream-2:#ece6d5;--cream-border:#d8d0bc;--gold:#8a6d2b;--gold-soft:#b8974a;--ink:#1c1c1c;--ink-55:rgba(28,28,28,.58);--accent:#6aacd6;--card-border:#e8e2cf;--surface:#fffdf6}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scrollbar-gutter:stable}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--cream);color:var(--ink);min-height:100dvh;font-size:14px}
  .topbar{background:var(--navy);color:var(--cream);padding:14px 28px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:30;box-shadow:0 1px 0 rgba(255,255,255,.04),0 2px 14px -6px rgba(0,0,0,.4);font-family:'Inter',system-ui,sans-serif}
  .brand{display:flex;align-items:center;gap:12px;text-decoration:none}
  .brand svg{height:60px;width:auto;display:block;max-width:100%}
  .nav{display:flex;align-items:center;gap:6px}
  .nav a{color:rgba(244,240,228,.62);font-size:13px;text-decoration:none;padding:8px 14px;border-radius:8px;transition:background .15s,color .15s;letter-spacing:.02em;white-space:nowrap}
  .nav a:hover{color:var(--cream);background:rgba(255,255,255,.06)}
  .nav a.active{color:var(--cream);background:rgba(184,151,74,.18);box-shadow:inset 0 -2px 0 var(--gold-soft)}
  .nav .sep{width:1px;height:18px;background:rgba(255,255,255,.1);margin:0 6px}
  .nav .logout{color:rgba(244,240,228,.5)}
  .nav .logout:hover{color:#f4d6d6;background:rgba(195,80,80,.12)}
  main{max-width:1400px;margin:0 auto;padding:28px 28px 60px}
  .page-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:24px;flex-wrap:wrap;gap:16px}
  .page-head h1{font-family:'Lora',Georgia,serif;font-size:32px;font-weight:600;color:var(--navy);letter-spacing:-.01em;line-height:1.1}
  .page-head .lead{color:var(--ink-55);font-size:14px;margin-top:6px}
  .warn{display:grid;grid-template-columns:auto 1fr;gap:14px;background:var(--surface);border:1px solid var(--card-border);border-left:3px solid var(--gold);color:var(--ink);padding:16px 20px;border-radius:12px;margin-bottom:22px;font-size:13.5px;line-height:1.6;align-items:flex-start;box-shadow:0 4px 14px -8px rgba(26,39,68,.15)}
  .warn .warn-ico{width:24px;height:24px;color:var(--gold);flex-shrink:0;margin-top:2px}
  .warn .warn-ico svg{width:100%;height:100%}
  .warn b{color:var(--navy);display:block;margin-bottom:3px;font-weight:600;font-size:14px}
  .warn code{background:rgba(184,151,74,.1);padding:1px 6px;border-radius:4px;font-size:12.5px;color:var(--gold)}
  .card{background:var(--surface);border:1px solid var(--card-border);border-radius:14px;padding:26px 28px;margin-bottom:18px;box-shadow:0 6px 24px -10px rgba(26,39,68,.08);transition:box-shadow .25s,transform .35s cubic-bezier(.2,.8,.2,1)}
  .card:hover{box-shadow:0 14px 36px -14px rgba(26,39,68,.18)}
  .card h2{font-family:'Lora',Georgia,serif;font-size:22px;font-weight:600;color:var(--navy);margin-bottom:6px;letter-spacing:-.01em}
  .card .meta{color:var(--gold);font-size:11.5px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:18px;font-weight:600}
  .card .meta code{background:rgba(184,151,74,.08);padding:1px 6px;border-radius:4px;font-size:11px;text-transform:none;letter-spacing:0;color:var(--ink-55)}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;background:var(--navy);color:var(--cream);border-radius:10px;text-decoration:none;font-weight:500;font-size:13.5px;font-family:inherit;border:none;cursor:pointer;transition:background .2s,box-shadow .2s,transform .1s}
  .btn:hover{background:var(--navy-2);box-shadow:0 8px 18px -6px rgba(26,39,68,.4)}
  .btn:active{transform:scale(.97)}
  .btn svg{width:16px;height:16px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  thead th{background:var(--navy);color:rgba(244,240,228,.92);padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
  thead th:first-child{padding-left:18px;border-radius:8px 0 0 0}
  thead th:last-child{padding-right:18px;border-radius:0 8px 0 0}
  tbody td{padding:12px 14px;border-bottom:1px solid #eee8d9;font-size:13px;vertical-align:middle}
  tbody td:first-child{padding-left:18px}
  tbody td:last-child{padding-right:18px}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:#faf6ea}
  td.muted{color:var(--ink-55)}
  td.nowrap{white-space:nowrap}
  .when{font-weight:500;color:var(--navy);margin-bottom:2px}
  .reason{display:inline-block;background:rgba(184,151,74,.12);color:var(--gold);padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-left:4px}
  .fn{font-size:11px;color:rgba(28,28,28,.4);font-family:ui-monospace,SFMono-Regular,monospace}
  .dl{color:var(--gold);text-decoration:none;font-weight:600;font-size:12.5px;padding:6px 12px;border:1.5px solid var(--cream-border);border-radius:8px;display:inline-flex;align-items:center;gap:6px;transition:background .2s,border-color .2s,color .2s}
  .dl:hover{background:var(--gold);color:var(--cream);border-color:var(--gold)}
  .dl::before{content:'↓';font-size:14px;line-height:1}
  .empty{color:var(--ink-55);font-size:14px;text-align:center;padding:32px 0;font-style:italic}
  /* Snapshot textual de consultas */
  .cs-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .cs-actions .btn-sec{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:transparent;color:var(--gold);border:1.5px solid var(--cream-border);border-radius:8px;text-decoration:none;font-weight:600;font-size:12.5px;transition:background .2s,border-color .2s,color .2s}
  .cs-actions .btn-sec:hover{background:var(--gold);color:var(--cream);border-color:var(--gold)}
  .cs-tbl{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:auto}
  .cs-tbl thead th{background:var(--cream-2);color:var(--navy);padding:8px 10px;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid var(--cream-border)}
  .cs-tbl tbody td{padding:9px 10px;border-bottom:1px solid #f0ead8;vertical-align:top;font-size:12.5px}
  .cs-tbl tbody tr:last-child td{border-bottom:none}
  .cs-tbl tbody tr:hover td{background:#faf6ea}
  .cs-tbl .tel{color:var(--gold);text-decoration:none;font-weight:600}
  .cs-tbl .tel:hover{text-decoration:underline}
  .cs-tbl .strong{font-weight:600;color:var(--navy)}
  .cs-tbl .badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .cs-tbl .badge .dot{width:6px;height:6px;border-radius:50%}
  .cs-tbl .badge-j{background:rgba(106,172,214,.14);color:#365a7a}
  .cs-tbl .badge-j .dot{background:#6aacd6}
  .cs-tbl .badge-n{background:rgba(184,151,74,.14);color:var(--gold)}
  .cs-tbl .badge-n .dot{background:var(--gold-soft)}
  .cs-tbl .consulta-cell{max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-55)}
  .cs-tbl td.muted{color:var(--ink-55)}
  .cs-tbl td.nowrap{white-space:nowrap}
  details.day{border:1px solid var(--card-border);border-radius:10px;margin-bottom:10px;background:#fffdf6;overflow:hidden}
  details.day[open]{box-shadow:0 4px 14px -10px rgba(26,39,68,.18)}
  details.day summary{cursor:pointer;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;list-style:none;font-weight:500;color:var(--navy);user-select:none;transition:background .15s}
  details.day summary::-webkit-details-marker{display:none}
  details.day summary:hover{background:var(--cream-2)}
  details.day summary::before{content:'▸';margin-right:10px;color:var(--gold);font-size:11px;transition:transform .2s}
  details.day[open] summary::before{transform:rotate(90deg)}
  details.day .day-name{flex:1;font-family:'Lora',Georgia,serif;font-size:15px;letter-spacing:.01em}
  details.day .day-count{color:var(--gold);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;background:rgba(184,151,74,.1);padding:3px 9px;border-radius:999px}
  details.day .day-body{padding:0 4px 4px;overflow-x:auto}
  .scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}
  @media(max-width:880px){main{padding:18px 14px 40px}.topbar{padding:10px 14px;gap:8px}.brand svg{height:50px}.nav a{padding:7px 10px;font-size:12.5px}.page-head h1{font-size:24px}.card{padding:22px 20px}}
  @media(max-width:560px){
    .topbar{padding:8px 10px;gap:6px;flex-wrap:wrap}
    .brand svg{height:42px}
    .nav{gap:2px;flex-wrap:wrap;justify-content:flex-end}
    .nav a{padding:6px 9px;font-size:12px;letter-spacing:0}
    .nav .sep{display:none}
    .page-head h1{font-size:22px}
    .card{padding:18px}
    .card h2{font-size:18px}
    .warn{padding:14px 16px;font-size:13px;grid-template-columns:1fr;gap:8px}
    .warn .warn-ico{width:22px;height:22px}
    table{font-size:12.5px}
    table,thead,tbody,tr,td{display:block;width:100%}
    thead{display:none}
    tbody tr{padding:12px 4px;border-bottom:1px solid #eee8d9}
    tbody tr:last-child{border-bottom:none}
    tbody td{padding:3px 0;border:none;display:flex;justify-content:space-between;gap:10px;align-items:center}
    tbody td:first-child{padding-left:0}
    tbody td:last-child{padding-right:0;justify-content:flex-end;margin-top:4px}
    .when{margin-bottom:0}
    .fn{font-size:10.5px}
    .btn{width:100%;justify-content:center}
    .cs-tbl{font-size:11.5px}
    .cs-tbl,.cs-tbl thead,.cs-tbl tbody,.cs-tbl tr,.cs-tbl td{display:block;width:100%}
    .cs-tbl thead{display:none}
    .cs-tbl tbody tr{padding:10px 0;border-bottom:1px solid #eee8d9;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}
    .cs-tbl tbody tr:last-child{border-bottom:none}
    .cs-tbl tbody td{padding:2px 0;border:none;font-size:12px}
    .cs-tbl tbody td:before{content:attr(data-label);font-weight:600;color:var(--navy);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-right:6px}
    .cs-tbl .consulta-cell{grid-column:1/-1;white-space:normal;color:var(--ink-55)}
    details.day .day-body{padding:0 8px 8px}
  }
</style></head><body>
<div class="topbar">
  <a href="/admin" class="brand" aria-label="Columen Admin">
    <svg viewBox="0 0 690 170" xmlns="http://www.w3.org/2000/svg">
      <circle cx="62" cy="84" r="43" fill="none" stroke="#ffffff" stroke-width="2.2"/>
      <path d="M 92.3 68.6 A 34 34 0 1 0 92.3 99.4" fill="none" stroke="#6aacd6" stroke-width="6" stroke-linecap="round"/>
      <circle cx="92.3" cy="68.6" r="5" fill="#6aacd6"/>
      <circle cx="92.3" cy="99.4" r="5" fill="#6aacd6"/>
      <line x1="124" y1="42" x2="124" y2="128" stroke="#ffffff" stroke-width="1.4" opacity="0.5"/>
      <text x="140" y="98" font-family="'Lora',Georgia,serif" font-size="56" font-weight="700" letter-spacing="5" fill="#ffffff">COLUMEN</text>
      <text x="142" y="126" font-family="'Inter',sans-serif" font-size="14.5" font-weight="600" letter-spacing="5" fill="#ffffff">LEGAL &amp; NOTARIAL</text>
    </svg>
  </a>
  <nav class="nav">
    <a href="/admin">Consultas</a>
    <a href="/admin/inbox">WhatsApp</a>
    <a href="/admin/backup" class="active">Backup</a>
    <span class="sep"></span>
    <a href="/admin/logout" class="logout">Salir</a>
  </nav>
</div>
<main>
  <div class="page-head">
    <div>
      <h1>Backup</h1>
      <div class="lead">Snapshots automáticos y descarga manual de la base de datos.</div>
    </div>
  </div>
  <div class="warn">
    <div class="warn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
    <div><b>Persistencia crítica</b>Los backups viven en <code>/data/backups/</code>. Si <code>/data</code> no tiene volumen montado en EasyPanel, se pierden en cada rebuild junto con la DB principal. Descargá la DB actual periódicamente para guardar una copia off-site.</div>
  </div>
  <div class="card">
    <h2>DB actual</h2>
    <div class="meta">${liveSize} KB · <code>${DB_PATH}</code></div>
    <a class="btn" href="/admin/backup/download"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Descargar DB actual</a>
  </div>
  <div class="card">
    <h2>Snapshots</h2>
    <div class="meta">${files.length} backups · se conservan los últimos ${BACKUP_KEEP}</div>
    ${files.length ? `<table><thead><tr><th>Snapshot</th><th>Tamaño</th><th></th></tr></thead><tbody>${list}</tbody></table>` : '<div class="empty">No hay snapshots aún. Se generan al startup, cada hora y al recibir nuevas consultas.</div>'}
  </div>
  <div class="card">
    <h2>Consultas de hoy</h2>
    <div class="meta">${consultasHoy.length} ${consultasHoy.length === 1 ? 'consulta' : 'consultas'} · ${escapeHtml(prettyDay(todayStr))}</div>
    <div class="cs-actions">
      <a class="btn-sec" href="/admin/export.csv?desde=${encodeURIComponent(todayStr)}&hasta=${encodeURIComponent(todayStr)}" title="Descargar CSV de hoy">⬇ CSV de hoy</a>
    </div>
    <div class="scroll-x">${hoyHtml}</div>
  </div>
  <div class="card">
    <h2>Historial de consultas</h2>
    <div class="meta">${totalConsultas} ${totalConsultas === 1 ? 'consulta' : 'consultas'} en total · agrupadas por día</div>
    <div class="cs-actions">
      <a class="btn-sec" href="/admin/export.csv" title="Descargar CSV con todas las consultas">⬇ CSV completo</a>
    </div>
    ${historialHtml}
  </div>
</main>
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

function labelsForTel(tel) {
  return db.prepare(`SELECT l.id, l.name, l.color FROM labels l
    INNER JOIN conversation_labels cl ON cl.label_id = l.id
    WHERE cl.telefono = ? ORDER BY l.name`).all(tel);
}

app.get('/admin/inbox/data', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const convs = db.prepare(`
    SELECT telefono, last_body, last_at, last_direction, unread, bot_paused
    FROM conversations
    ORDER BY last_at DESC
  `).all();
  const withNames = convs.map(c => ({ ...c, nombre: resolveName(c.telefono), labels: labelsForTel(c.telefono) }));
  const totalUnread = withNames.reduce((a, c) => a + (c.unread || 0), 0);
  const allLabels = db.prepare('SELECT id, name, color FROM labels ORDER BY name').all();
  res.json({ conversations: withNames, totalUnread, labels: allLabels });
});

app.get('/admin/inbox/:tel/info', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const nombre = resolveName(tel);
  const count = db.prepare('SELECT COUNT(*) c FROM messages WHERE telefono = ?').get(tel).c;
  const consulta = db.prepare('SELECT area, dni, email, consulta, created_at FROM consultas WHERE telefono = ? ORDER BY id DESC LIMIT 1').get(tel);
  const labels = labelsForTel(tel);
  res.json({ telefono: tel, nombre, count, consulta, labels });
});

app.get('/admin/labels', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  res.json({ labels: db.prepare('SELECT id, name, color FROM labels ORDER BY name').all() });
});

app.post('/admin/labels', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const name = (req.body?.name || '').trim();
  const color = (req.body?.color || '#8a6d2b').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const r = db.prepare('INSERT INTO labels (name, color) VALUES (?,?)').run(name, color);
    res.json({ id: r.lastInsertRowid, name, color });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'duplicate' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/admin/labels/:id', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM conversation_labels WHERE label_id = ?').run(id);
  db.prepare('DELETE FROM labels WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Plantillas de respuesta ---
app.get('/admin/templates', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  res.json({ templates: db.prepare('SELECT id, name, body FROM templates ORDER BY name').all() });
});
app.post('/admin/templates', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const name = (req.body?.name || '').trim();
  const body = (req.body?.body || '').trim();
  if (!name || !body) return res.status(400).json({ error: 'name_and_body_required' });
  if (name.length > 80) return res.status(400).json({ error: 'name_too_long' });
  if (body.length > 4000) return res.status(400).json({ error: 'body_too_long' });
  const r = db.prepare('INSERT INTO templates (name, body) VALUES (?,?)').run(name, body);
  res.json({ id: r.lastInsertRowid, name, body });
});
app.put('/admin/templates/:id', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const id = parseInt(req.params.id, 10);
  const name = (req.body?.name || '').trim();
  const body = (req.body?.body || '').trim();
  if (!name || !body) return res.status(400).json({ error: 'name_and_body_required' });
  db.prepare('UPDATE templates SET name=?, body=? WHERE id=?').run(name, body, id);
  res.json({ ok: true });
});
app.delete('/admin/templates/:id', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  db.prepare('DELETE FROM templates WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post('/admin/inbox/:tel/labels/:labelId', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const labelId = parseInt(req.params.labelId, 10);
  db.prepare('INSERT OR IGNORE INTO conversation_labels (telefono, label_id) VALUES (?,?)').run(tel, labelId);
  res.json({ ok: true, labels: labelsForTel(tel) });
});

app.delete('/admin/inbox/:tel/labels/:labelId', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const labelId = parseInt(req.params.labelId, 10);
  db.prepare('DELETE FROM conversation_labels WHERE telefono = ? AND label_id = ?').run(tel, labelId);
  res.json({ ok: true, labels: labelsForTel(tel) });
});

app.get('/admin/inbox/:tel/messages', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const messages = db.prepare('SELECT id, direction, type, body, created_at, media_id, media_mime, status FROM messages WHERE telefono = ? ORDER BY id ASC LIMIT 500').all(tel);
  let conv = db.prepare('SELECT * FROM conversations WHERE telefono = ?').get(tel);
  if (!conv) conv = { telefono: tel, bot_paused: 0, unread: 0 };
  const nombre = resolveName(tel);
  const labels = labelsForTel(tel);
  const lastIn = db.prepare("SELECT created_at FROM messages WHERE telefono = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(tel);
  let canSend = true;
  if (lastIn?.created_at) {
    const hoursAgo = (Date.now() - new Date(lastIn.created_at.replace(' ', 'T')).getTime()) / 3600000;
    canSend = hoursAgo < 24;
  } else {
    canSend = false;
  }
  res.json({
    messages,
    conversation: { ...conv, nombre, labels },
    canSend,
    recontactTemplate: { name: RECONTACT_TEMPLATE_NAME, lang: RECONTACT_TEMPLATE_LANG, preview: RECONTACT_TEMPLATE_PREVIEW },
  });
});

// Búsqueda dentro de un chat
app.get('/admin/inbox/:tel/search', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ matches: [] });
  const like = '%' + q.replace(/[%_]/g, '\\$&') + '%';
  const matches = db.prepare(
    `SELECT id, direction, type, body, created_at, media_id, media_mime, status
     FROM messages
     WHERE telefono = ? AND body LIKE ? ESCAPE '\\'
     ORDER BY id DESC LIMIT 80`
  ).all(tel, like);
  res.json({ matches, query: q });
});

// Send image (base64 JSON body)
app.post('/admin/inbox/:tel/send-image', requireCsrf, express.json({ limit: '16mb' }), async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const { filename, mime, data, caption } = req.body || {};
  if (!data || !mime) return res.status(400).json({ error: 'missing file' });
  if (!WA_TOKEN || !WA_PHONE_ID) return res.status(500).json({ error: 'wa not configured' });
  try {
    const buf = Buffer.from(data, 'base64');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buf], { type: mime }), filename || 'upload.bin');
    const up = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      body: form,
    });
    const upJson = await up.json();
    if (!up.ok || !upJson.id) {
      console.error('[WA] media upload error', JSON.stringify(upJson));
      return res.status(400).json({ error: 'upload failed', detail: upJson.error?.message || 'unknown' });
    }
    const mediaId = upJson.id;
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const isAudio = mime.startsWith('audio/');
    const type = isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'document';
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: tel,
      type,
      [type]: type === 'document' ? { id: mediaId, filename: filename || 'archivo', caption: caption || undefined } : { id: mediaId, caption: caption || undefined },
    };
    const exists = db.prepare('SELECT telefono FROM conversations WHERE telefono = ?').get(tel);
    if (exists) db.prepare('UPDATE conversations SET bot_paused = 1 WHERE telefono = ?').run(tel);
    else db.prepare("INSERT INTO conversations (telefono, last_at, bot_paused) VALUES (?, datetime('now','localtime'), 1)").run(tel);
    const result = await waSend(payload);
    if (result?.error) return res.status(400).json({ error: result.error.message || 'send failed' });
    // Update last stored message to include mime (waSend records with null mime)
    db.prepare("UPDATE messages SET media_mime = ? WHERE telefono = ? AND direction = 'out' AND media_id = ?").run(mime, tel, mediaId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[WA] send-image error', e);
    res.status(500).json({ error: e.message });
  }
});

// Media proxy: fetch from Meta CDN with auth
const mediaUrlCache = new Map();
app.get('/admin/media/:id', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).send('unauth');
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).send('invalid id');
  try {
    let meta = mediaUrlCache.get(id);
    const now = Date.now();
    if (!meta || (now - meta.ts) > 4 * 60 * 1000) {
      const r = await fetch(`https://graph.facebook.com/v21.0/${id}`, {
        headers: { Authorization: `Bearer ${WA_TOKEN}` },
      });
      const j = await r.json();
      if (!r.ok || !j.url) return res.status(400).send('meta meta error');
      meta = { url: j.url, mime: j.mime_type, ts: now };
      mediaUrlCache.set(id, meta);
    }
    const r2 = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    if (!r2.ok) return res.status(400).send('meta cdn error');
    res.setHeader('Content-Type', meta.mime || r2.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const buf = Buffer.from(await r2.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error('[media proxy]', e);
    res.status(500).send('error');
  }
});

app.post('/admin/inbox/:tel/read', requireCsrf, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  db.prepare('UPDATE conversations SET unread = 0 WHERE telefono = ?').run(req.params.tel);
  res.json({ ok: true });
});

app.post('/admin/inbox/:tel/bot', requireCsrf, (req, res) => {
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

app.post('/admin/inbox/:tel/send', requireCsrf, async (req, res) => {
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
  if (result?.error) return res.status(400).json({ error: 'wa_error', detail: result.error.message || 'Error de WhatsApp', raw: result.error });
  res.json({ ok: true });
});

// Envía la plantilla de re-contacto para reabrir la ventana 24hs cuando expiró.
// Auto-pausa el bot. Body opcional: {} (usa defaults de env vars).
app.post('/admin/inbox/:tel/send-template', requireCsrf, async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
  const tel = req.params.tel;
  const exists = db.prepare('SELECT telefono FROM conversations WHERE telefono = ?').get(tel);
  if (exists) {
    db.prepare('UPDATE conversations SET bot_paused = 1 WHERE telefono = ?').run(tel);
  } else {
    db.prepare("INSERT INTO conversations (telefono, last_at, bot_paused) VALUES (?, datetime('now','localtime'), 1)").run(tel);
  }
  const result = await sendTemplate(tel);
  if (result?.error) {
    const detail = result.error.message || 'Error de WhatsApp';
    const lower = detail.toLowerCase();
    let hint = 'Verificá la plantilla en business.facebook.com.';
    if (lower.includes('does not exist') || lower.includes('not found')) {
      hint = 'La plantilla "' + RECONTACT_TEMPLATE_NAME + '" no existe en este WABA. Revisá el nombre en Meta Business.';
    } else if (lower.includes('not approved') || lower.includes('pending') || lower.includes('rejected')) {
      hint = 'La plantilla "' + RECONTACT_TEMPLATE_NAME + '" no está APROBADA todavía. Esperá a que Meta la apruebe (PENDING -> APPROVED).';
    } else if (lower.includes('rate') || lower.includes('limit')) {
      hint = 'Límite de mensajes alcanzado. Esperá unos minutos.';
    } else if (lower.includes('#100') || lower.includes('invalid parameter')) {
      hint = 'Parámetro inválido. Probable causa: nombre de plantilla incorrecto, idioma incorrecto, o plantilla todavía PENDING en Meta.';
    }
    return res.status(400).json({
      error: 'wa_error',
      detail,
      hint,
      raw: result.error,
    });
  }
  res.json({ ok: true, name: RECONTACT_TEMPLATE_NAME, lang: RECONTACT_TEMPLATE_LANG, preview: RECONTACT_TEMPLATE_PREVIEW });
});

app.get('/admin/inbox', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/admin/login');
  res.send(`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp - COLUMEN</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  html{scrollbar-gutter:stable}
  body{font-family:"Segoe UI","Helvetica Neue",Roboto,system-ui,sans-serif;background:#F0F2F5;color:#111B21;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  a{color:inherit;text-decoration:none}
  button{font-family:inherit}

  /* Columen topbar */
  .topbar{background:#1a2744;color:#f4f0e4;padding:14px 28px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;box-shadow:0 1px 0 rgba(255,255,255,.04),0 2px 14px -6px rgba(0,0,0,.4);z-index:5;font-family:'Inter',system-ui,sans-serif}
  .topbar .brand{display:flex;align-items:center;gap:12px;text-decoration:none}
  .topbar .brand svg{height:60px;width:auto;display:block;max-width:100%}
  .topbar .r{display:flex;align-items:center;gap:6px}
  .topbar .r a{color:rgba(244,240,228,.62);font-size:13px;padding:8px 14px;border-radius:8px;transition:background .15s,color .15s;letter-spacing:.02em;white-space:nowrap}
  .topbar .r a:hover{color:#f4f0e4;background:rgba(255,255,255,.06)}
  .topbar .r a.active{color:#f4f0e4;background:rgba(184,151,74,.18);box-shadow:inset 0 -2px 0 #b8974a}
  .topbar .r .sep{width:1px;height:18px;background:rgba(255,255,255,.1);margin:0 6px}
  .topbar .r a.logout{color:rgba(244,240,228,.5)}
  .topbar .r a.logout:hover{color:#f4d6d6;background:rgba(195,80,80,.12)}
  @media(max-width:880px){
    .topbar{padding:10px 14px;gap:8px}
    .topbar .brand svg{height:50px}
    .topbar .r a{padding:7px 10px;font-size:12.5px}
  }
  @media(max-width:560px){
    .topbar{padding:8px 10px;gap:6px;flex-wrap:wrap}
    .topbar .brand svg{height:42px}
    .topbar .r{gap:2px;flex-wrap:wrap;justify-content:flex-end}
    .topbar .r a{padding:6px 9px;font-size:12px;letter-spacing:0}
    .topbar .r .sep{display:none}
  }

  /* WhatsApp layout */
  .layout{flex:1;display:flex;overflow:hidden;background:#EFEAE2}
  .sidebar{width:400px;background:#fff;display:flex;flex-direction:column;flex-shrink:0;border-right:1px solid #E9EDEF}
  .side-header{background:#F0F2F5;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0}
  .side-header .avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#1a2744 0%,#2a3960 100%);color:#f4f0e4;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;font-family:'Lora',Georgia,serif;letter-spacing:.5px;box-shadow:0 2px 6px -1px rgba(26,39,68,.35),inset 0 0 0 1.5px rgba(184,151,74,.5)}
  .side-header .actions{display:flex;gap:4px}
  .side-header .ico{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#54656F;background:transparent;border:none;font-size:18px}
  .side-header .ico:hover{background:#E9EDEF}

  .search-wrap{padding:8px 12px;background:#fff;flex-shrink:0}
  .search-box{background:#F0F2F5;border-radius:8px;padding:6px 14px;display:flex;align-items:center;gap:10px}
  .search-box input{border:none;background:transparent;outline:none;flex:1;font-size:14px;color:#111B21}
  .search-box .ico-search{color:#54656F;font-size:14px}

  .label-filter{padding:6px 10px 8px;display:flex;flex-wrap:wrap;gap:6px;background:#fff;flex-shrink:0}
  .label-chip{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:500;color:#fff;cursor:pointer;opacity:.55;border:none}
  .label-chip.active{opacity:1}
  .label-chip-manage{background:#E9EDEF;color:#54656F;padding:4px 10px;border-radius:999px;font-size:11px;cursor:pointer;border:none;font-weight:500}
  .label-chip-manage:hover{background:#DFE5E7}

  .conv-list{flex:1;overflow-y:auto;background:#fff}
  .conv{padding:10px 16px;cursor:pointer;display:flex;gap:12px;align-items:center;position:relative;border-bottom:1px solid #F0F2F5}
  .conv:hover{background:#F5F6F6}
  .conv.active{background:#F0F2F5}
  .conv .avatar{width:49px;height:49px;border-radius:50%;background:#54656F;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:18px;flex-shrink:0;letter-spacing:.5px;text-transform:uppercase;box-shadow:0 1px 2px rgba(0,0,0,.08);overflow:hidden}
  .conv .avatar svg{width:60%;height:60%}
  .conv .body{flex:1;min-width:0;padding:4px 0}
  .conv .row1{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .conv .name{font-weight:400;font-size:17px;color:#111B21;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .conv .time{font-size:12px;color:#667781;flex-shrink:0}
  .conv.unread .time{color:#00A884;font-weight:500}
  .conv .row2{display:flex;justify-content:space-between;align-items:center;margin-top:3px;gap:8px}
  .conv .preview{font-size:14px;color:#667781;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;display:flex;align-items:center;gap:3px}
  .conv .preview .tick{color:#667781;font-size:15px}
  .conv .preview .tick.read{color:#53BDEB}
  .conv .badge{background:#25D366;color:#fff;font-size:12px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;font-weight:500;display:flex;align-items:center;justify-content:center}
  .conv .bot-tag{font-size:10px;padding:1px 6px;border-radius:4px;background:#E7F3FF;color:#0084FF;margin-left:6px;font-weight:500}
  .conv .bot-tag.off{background:#FEE;color:#C23B1E}
  .conv .mini-labels{display:flex;gap:3px;margin-top:3px;flex-wrap:wrap}
  .conv .mini-labels .mini{font-size:10px;padding:1px 7px;border-radius:999px;color:#fff;font-weight:500}

  /* Chat panel */
  .chat{flex:1;display:flex;flex-direction:column;background:#EFEAE2;min-width:0;position:relative;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='320' viewBox='0 0 320 320'%3E%3Cg fill='%23D9D4CC' fill-opacity='0.35'%3E%3Ccircle cx='40' cy='40' r='1.5'/%3E%3Ccircle cx='120' cy='80' r='1'/%3E%3Ccircle cx='200' cy='30' r='1.2'/%3E%3Ccircle cx='280' cy='110' r='1'/%3E%3Ccircle cx='60' cy='180' r='1.1'/%3E%3Ccircle cx='160' cy='220' r='1.3'/%3E%3Ccircle cx='240' cy='260' r='1'/%3E%3Ccircle cx='90' cy='280' r='1.2'/%3E%3C/g%3E%3C/svg%3E")}
  .chat-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px;color:#667781;background:#F0F2F5;background-image:none;border-left:1px solid #E9EDEF}
  .chat-empty .icon-circle{width:80px;height:80px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;margin-bottom:18px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
  .chat-empty .icon-circle svg{width:42px;height:42px;color:#00A884}
  .chat-empty .big{font-family:serif;font-size:28px;color:#41525D;margin-bottom:10px;font-weight:300}
  .chat-empty .sub{font-size:14px;max-width:500px;line-height:1.6}

  .chat-header{background:#F0F2F5;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;border-left:1px solid #E9EDEF;gap:8px}
  .chat-header .info{display:flex;align-items:center;gap:12px;cursor:pointer;flex:1;min-width:0}
  .chat-header .info-text{flex:1;min-width:0}
  .chat-header .avatar{width:40px;height:40px;border-radius:50%;background:#54656F;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15.5px;flex-shrink:0;letter-spacing:.5px;text-transform:uppercase;box-shadow:0 1px 2px rgba(0,0,0,.08);overflow:hidden}
  .chat-header .avatar svg{width:60%;height:60%}
  .chat-header .name{font-weight:500;font-size:16px;color:#111B21;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chat-header .sub{font-size:13px;color:#667781;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chat-header .back{width:36px;height:36px;border-radius:50%;display:none;align-items:center;justify-content:center;background:transparent;border:none;color:#54656F;cursor:pointer;font-size:22px;flex-shrink:0;padding:0}
  .chat-header .back:hover{background:#E9EDEF}
  .chat-header .actions{display:flex;gap:4px;flex-shrink:0}
  .chat-header .ico{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#54656F;background:transparent;border:none;font-size:18px;flex-shrink:0}
  .chat-header .ico:hover{background:#E9EDEF}

  .chat-sub{background:#FFF8DC;border-bottom:1px solid #F0E6B6;padding:8px 16px;font-size:13px;color:#8A6D00;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
  .chat-sub.err{background:#FEEAEA;border-color:#F5C6CB;color:#721C24}
  .btn-recontact{background:#00A884;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s,transform .1s;flex-shrink:0;font-family:inherit}
  .btn-recontact:hover{background:#06876B}
  .btn-recontact:active{transform:scale(.97)}
  .btn-recontact:disabled{background:#9DAEB7;cursor:not-allowed}
  .chat-labels-bar{background:#F0F2F5;padding:6px 16px;border-top:1px solid #E9EDEF;border-left:1px solid #E9EDEF;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:#54656F;flex-shrink:0}
  .chat-labels-bar .chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;color:#fff;font-size:11px;font-weight:500}
  .chat-labels-bar .chip .x{cursor:pointer;opacity:.75;font-size:13px;line-height:1}
  .chat-labels-bar .chip .x:hover{opacity:1}
  .chat-labels-bar .add-btn{border:1px dashed #B0B7BC;padding:2px 10px;border-radius:999px;color:#54656F;font-size:11px;cursor:pointer;background:#fff;font-weight:500}
  .chat-labels-bar .add-btn:hover{border-color:#00A884;color:#00A884}

  .messages{flex:1;overflow-y:auto;padding:14px 8% 14px;display:flex;flex-direction:column;gap:2px;position:relative}
  .date-sep{align-self:center;background:#E1F2FB;color:#54656F;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:8px;margin:10px 0;box-shadow:0 1px 1px rgba(0,0,0,.05)}
  .msg{max-width:65%;padding:6px 8px 8px;border-radius:8px;font-size:14.2px;line-height:1.4;word-wrap:break-word;overflow-wrap:break-word;white-space:pre-wrap;color:#111B21;box-shadow:0 1px 0.5px rgba(0,0,0,.13);position:relative;margin-bottom:1px;cursor:pointer}
  .msg .bubble-meta{display:inline-flex;align-items:center;gap:3px;float:right;margin-left:8px;margin-top:6px;font-size:11px;color:#667781;line-height:1}
  .msg .tick{font-size:14px;letter-spacing:-4px;color:#667781}
  .msg .tick.read{color:#53BDEB}
  .msg.in{background:#fff;align-self:flex-start;border-top-left-radius:0}
  .msg.out{background:#D9FDD3;align-self:flex-end;border-top-right-radius:0}
  /* Bubble tails (cola del bocadillo, igual a WA) */
  .msg.in:not(.cont)::before{content:'';position:absolute;top:0;left:-8px;width:8px;height:13px;background:#fff;clip-path:polygon(0 0,100% 0,100% 100%);box-shadow:0 1px 0.5px rgba(0,0,0,.06)}
  .msg.out:not(.cont)::before{content:'';position:absolute;top:0;right:-8px;width:8px;height:13px;background:#D9FDD3;clip-path:polygon(0 0,100% 0,0 100%);box-shadow:0 1px 0.5px rgba(0,0,0,.06)}
  .msg.cont{border-top-left-radius:8px;border-top-right-radius:8px}
  .msg img{max-width:320px;max-height:320px;border-radius:6px;display:block;cursor:zoom-in;margin:-2px -2px 2px}
  .msg audio{max-width:300px;display:block;height:42px}
  .msg video{max-width:320px;max-height:320px;border-radius:6px;display:block}
  .msg .doc{display:flex;align-items:center;gap:10px;padding:12px;border-radius:8px;background:rgba(0,0,0,.04);color:inherit;text-decoration:none;margin:-2px -2px 4px;border:1px solid rgba(0,0,0,.06)}
  .msg .doc:hover{background:rgba(0,0,0,.08)}
  .msg .doc .ico{font-size:24px;flex-shrink:0;width:34px;height:34px;background:#fff;border-radius:6px;display:flex;align-items:center;justify-content:center}
  .msg .doc .doc-name{flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#111B21;font-weight:500}
  .msg .doc .doc-sub{font-size:11.5px;color:#667781;margin-top:2px}
  .msg .caption{margin-top:4px}
  /* Reply preview within bubble */
  .msg .reply-snip{border-left:3px solid #06A98E;background:rgba(6,169,142,.08);padding:5px 8px;border-radius:4px;margin:-2px -2px 6px;font-size:13px;color:#54656F;cursor:pointer}
  .msg.out .reply-snip{border-left-color:#06A98E;background:rgba(0,168,132,.07)}
  .msg .reply-snip .who{font-size:12.5px;color:#06A98E;font-weight:500;margin-bottom:2px}
  .msg .reply-snip .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#54656F}
  /* Hover hint */
  .msg:hover{filter:brightness(0.985)}

  .scroll-down{position:absolute;bottom:80px;right:30px;width:42px;height:42px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2);display:none;align-items:center;justify-content:center;cursor:pointer;color:#54656F;font-size:18px;border:none;z-index:10}
  .scroll-down.show{display:flex}

  /* Reply bar (above composer when replying) */
  .reply-bar{background:#F0F2F5;padding:8px 14px;display:none;gap:10px;align-items:center;border-top:1px solid #E9EDEF;border-left:1px solid #E9EDEF;flex-shrink:0}
  .reply-bar.open{display:flex}
  .reply-bar .quote{flex:1;border-left:3px solid #06A98E;padding:4px 10px;background:rgba(6,169,142,.06);border-radius:4px;min-width:0}
  .reply-bar .quote .who{font-size:12.5px;color:#06A98E;font-weight:500;margin-bottom:2px}
  .reply-bar .quote .txt{font-size:13px;color:#54656F;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .reply-bar .close-reply{background:transparent;border:none;color:#54656F;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
  .reply-bar .close-reply:hover{background:#E9EDEF}

  .composer{background:#F0F2F5;padding:8px 12px;display:flex;gap:6px;align-items:flex-end;flex-shrink:0;border-left:1px solid #E9EDEF;position:relative}
  .composer .icon-btn{background:transparent;border:none;color:#54656F;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .15s}
  .composer .icon-btn:hover{background:#E9EDEF}
  .composer .icon-btn:disabled{opacity:.4;cursor:not-allowed}
  .composer .text-wrap{flex:1;background:#fff;border-radius:8px;padding:9px 12px;display:flex;align-items:center;min-height:42px}
  .composer textarea{flex:1;border:none;outline:none;font-size:15px;font-family:inherit;resize:none;min-height:24px;max-height:140px;background:transparent;color:#111B21;padding:0;line-height:1.4}
  .composer textarea::placeholder{color:#667781}
  .composer .send-or-mic{background:transparent;border:none;color:#54656F;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,transform .15s}
  .composer .send-or-mic.has-text{color:#00A884;font-size:24px;transform:rotate(0deg)}
  .composer .send-or-mic:hover{background:#E9EDEF}
  .composer:has(textarea:disabled){opacity:.7}

  /* Emoji picker */
  .emoji-picker{position:absolute;bottom:60px;left:8px;background:#fff;border:1px solid #E9EDEF;border-radius:10px;padding:10px;box-shadow:0 4px 14px rgba(0,0,0,.12);display:none;z-index:50;width:300px}
  .emoji-picker.open{display:block}
  .emoji-picker h4{font-size:11px;text-transform:uppercase;color:#667781;margin-bottom:6px;font-weight:500;letter-spacing:.05em}
  .emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px}
  .emoji-grid button{border:none;background:transparent;font-size:20px;padding:4px;border-radius:4px;cursor:pointer;line-height:1}
  .emoji-grid button:hover{background:#F0F2F5}

  /* Attach menu */
  .attach-menu{position:absolute;bottom:60px;left:8px;background:#fff;border-radius:30px;padding:10px 8px;box-shadow:0 4px 14px rgba(0,0,0,.14);display:none;z-index:50;flex-direction:column;gap:6px}
  .attach-menu.open{display:flex}
  .attach-menu button{border:none;background:transparent;width:44px;height:44px;border-radius:50%;cursor:pointer;font-size:22px;color:#fff;display:flex;align-items:center;justify-content:center}
  .attach-menu .img{background:#BF59CF}
  .attach-menu .doc{background:#5F66CD}
  .attach-menu .video{background:#D3396D}

  /* Image viewer */
  .img-viewer{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;z-index:200;cursor:zoom-out}
  .img-viewer.open{display:flex}
  .img-viewer img{max-width:92vw;max-height:92vh;border-radius:6px}

  /* Label menu */
  .label-menu{position:absolute;background:#fff;border:1px solid #E9EDEF;border-radius:10px;padding:6px;min-width:220px;box-shadow:0 6px 20px rgba(0,0,0,.14);z-index:100;display:none}
  .label-menu.open{display:block}
  .label-menu .item{padding:8px 12px;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:14px;color:#111B21}
  .label-menu .item:hover{background:#F0F2F5}
  .label-menu .dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
  .label-menu .divider{height:1px;background:#E9EDEF;margin:4px 0}
  .label-menu .new{color:#00A884;font-weight:500;font-size:14px;padding:8px 12px;cursor:pointer;border-radius:6px}
  .label-menu .new:hover{background:#F0F2F5}

  /* Contact info panel */
  .info-panel{width:400px;background:#fff;border-left:1px solid #E9EDEF;display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto}
  .info-panel.hidden{display:none}
  .info-header{background:#F0F2F5;padding:15px 20px;display:flex;align-items:center;gap:16px;border-bottom:1px solid #E9EDEF}
  .info-header .close{cursor:pointer;color:#54656F;font-size:22px;background:transparent;border:none}
  .info-header h3{font-size:16px;font-weight:500}
  .info-avatar{text-align:center;padding:32px 20px;background:#fff}
  .info-avatar .big-avatar{width:150px;height:150px;border-radius:50%;background:#54656F;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:60px;margin:0 auto 16px;letter-spacing:1px;text-transform:uppercase;box-shadow:0 6px 18px -8px rgba(0,0,0,.25);overflow:hidden}
  .info-avatar .big-avatar svg{width:55%;height:55%}
  .info-avatar .name{font-size:24px;color:#111B21;margin-bottom:4px}
  .info-avatar .tel{font-size:16px;color:#667781}
  .info-section{background:#fff;padding:16px 24px;margin-top:10px;border-top:1px solid #E9EDEF;border-bottom:1px solid #E9EDEF}
  .info-section h4{font-size:14px;color:#00A884;margin-bottom:8px;font-weight:500}
  .info-section .val{font-size:14px;color:#111B21;line-height:1.5;white-space:pre-wrap}
  .info-section .sub{font-size:12px;color:#667781;margin-top:4px}
  .info-section .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0}
  .info-stat{font-size:14px;color:#54656F}
  .info-stat b{color:#111B21;font-weight:500}

  /* Modal genérico (reemplaza prompt() del navegador) */
  .modal-bg{position:fixed;inset:0;background:rgba(11,20,26,.55);display:none;align-items:center;justify-content:center;z-index:300;padding:20px}
  .modal-bg.open{display:flex}
  .modal{background:#fff;border-radius:8px;padding:24px;width:100%;max-width:420px;box-shadow:0 6px 28px rgba(0,0,0,.2)}
  .modal h3{font-size:18px;margin-bottom:6px;color:#111B21;font-weight:500}
  .modal p{font-size:13.5px;color:#667781;margin-bottom:14px;line-height:1.4}
  .modal input,.modal select{width:100%;padding:10px 12px;border:1px solid #DFE5E7;border-radius:6px;font-size:15px;font-family:inherit;outline:none;margin-bottom:10px;color:#111B21;background:#fff}
  .modal input:focus,.modal select:focus{border-color:#00A884;box-shadow:0 0 0 3px rgba(0,168,132,.12)}
  .modal .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
  .modal .btn{padding:9px 18px;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-family:inherit;font-weight:500;letter-spacing:.02em}
  .modal .btn.secondary{background:transparent;color:#54656F}
  .modal .btn.secondary:hover{background:#F0F2F5}
  .modal .btn.primary{background:#00A884;color:#fff}
  .modal .btn.primary:hover{background:#06916F}
  .modal .err{color:#C23B1E;font-size:12.5px;margin-top:-4px;margin-bottom:10px;display:none}
  .modal .err.show{display:block}

  /* Toast */
  .toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#41525D;color:#fff;padding:10px 20px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.18);font-size:14px;z-index:400;opacity:0;transition:opacity .2s,bottom .2s;pointer-events:none}
  .toast.show{opacity:1;bottom:40px}
  .toast.error{background:#C23B1E}

  /* Search-in-chat bar */
  .search-bar{background:#F0F2F5;padding:8px 12px;border-bottom:1px solid #E9EDEF;border-left:1px solid #E9EDEF;display:none;gap:8px;align-items:center;flex-shrink:0}
  .search-bar.open{display:flex}
  .search-bar input{flex:1;border:1px solid #DFE5E7;border-radius:18px;padding:7px 14px;font-size:14px;font-family:inherit;outline:none;background:#fff}
  .search-bar input:focus{border-color:#00A884}
  .search-bar .close-search{background:transparent;border:none;color:#54656F;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
  .search-bar .close-search:hover{background:#E9EDEF}
  .search-bar .count{font-size:12.5px;color:#54656F;flex-shrink:0;padding:0 6px}
  /* Highlight search match en bubble */
  .msg mark{background:#FFE066;color:#111B21;padding:0 2px;border-radius:2px;font-weight:500}
  .msg.search-hit{outline:2px solid #FFB700;outline-offset:1px}

  /* Templates list */
  .modal #tplList{padding:0}
  .tpl-item{border:1px solid #E9EDEF;border-radius:8px;padding:10px 12px;background:#fff}
  .tpl-item:hover{background:#F5F6F6}
  .tpl-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  .tpl-name{flex:1;font-weight:500;color:#111B21;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tpl-actions{display:flex;gap:4px;flex-shrink:0}
  .tpl-btn{border:none;background:transparent;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:12px;font-family:inherit;color:#54656F}
  .tpl-btn.use{background:#00A884;color:#fff;font-weight:500;padding:4px 12px}
  .tpl-btn.use:hover{background:#06916F}
  .tpl-btn.edit:hover{background:#E9EDEF;color:#111B21}
  .tpl-btn.del{color:#C23B1E}
  .tpl-btn.del:hover{background:#FEEAEA}
  .tpl-body{font-size:12.5px;color:#54656F;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;max-height:80px;overflow-y:auto}
  .modal{max-width:520px}

  @media (max-width: 900px){
    .sidebar{width:100%}
    .chat{display:none}
    .info-panel{display:none}
    .layout.has-chat .sidebar{display:none}
    .layout.has-chat .chat{display:flex}
    .layout.has-chat .topbar{display:none} /* WhatsApp-like fullscreen */
    .chat-header .back{display:flex}
    .chat-header{position:sticky;top:0;z-index:10}
    .messages{padding:10px 8px 14px}
    .msg{max-width:80%}
    .composer{padding:6px 8px}
    .info-panel{position:fixed;inset:0;width:100%;height:100%;z-index:50}
    .info-panel.hidden{display:none !important}
    .info-panel:not(.hidden){display:flex !important;flex-direction:column}
    .scroll-down{right:14px;bottom:80px}
    .emoji-picker{width:calc(100vw - 16px);max-width:340px}
    .attach-menu{flex-direction:row}
  }
  @media (max-width: 480px){
    .messages{padding:8px 6px 12px}
    .msg{max-width:85%;font-size:14px}
    .conv .name{font-size:16px}
    .conv .preview{font-size:13.5px}
  }
</style></head><body>
<div class="topbar">
  <a href="/admin" class="brand" aria-label="Columen Admin">
    <svg viewBox="0 0 690 170" xmlns="http://www.w3.org/2000/svg">
      <circle cx="62" cy="84" r="43" fill="none" stroke="#ffffff" stroke-width="2.2"/>
      <path d="M 92.3 68.6 A 34 34 0 1 0 92.3 99.4" fill="none" stroke="#6aacd6" stroke-width="6" stroke-linecap="round"/>
      <circle cx="92.3" cy="68.6" r="5" fill="#6aacd6"/>
      <circle cx="92.3" cy="99.4" r="5" fill="#6aacd6"/>
      <line x1="124" y1="42" x2="124" y2="128" stroke="#ffffff" stroke-width="1.4" opacity="0.5"/>
      <text x="140" y="98" font-family="'Lora',Georgia,serif" font-size="56" font-weight="700" letter-spacing="5" fill="#ffffff">COLUMEN</text>
      <text x="142" y="126" font-family="'Inter',sans-serif" font-size="14.5" font-weight="600" letter-spacing="5" fill="#ffffff">LEGAL &amp; NOTARIAL</text>
    </svg>
  </a>
  <div class="r">
    <a href="/admin">Consultas</a>
    <a href="/admin/inbox" class="active">WhatsApp</a>
    <a href="/admin/backup">Backup</a>
    <span class="sep"></span>
    <a href="/admin/logout" class="logout">Salir</a>
  </div>
</div>
<div class="layout" id="layout">
  <div class="sidebar">
    <div class="side-header">
      <div class="avatar" title="COLUMEN">C</div>
      <div class="actions">
        <button class="ico" id="manageLabels" title="Gestionar etiquetas">🏷️</button>
        <button class="ico" title="Nuevo chat (manual)" id="btnNewChat">✏️</button>
      </div>
    </div>
    <div class="search-wrap">
      <div class="search-box">
        <span class="ico-search">🔍</span>
        <input id="searchInp" type="text" placeholder="Buscar o empezar un chat nuevo">
      </div>
    </div>
    <div class="label-filter" id="labelFilter"></div>
    <div class="conv-list" id="convList"><div style="padding:40px;text-align:center;color:#667781">Cargando…</div></div>
  </div>
  <div class="chat" id="chat">
    <div class="chat-empty" id="chatEmpty">
      <div class="icon-circle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
      </div>
      <div class="big">WhatsApp Web · COLUMEN</div>
      <div class="sub">Seleccioná un contacto de la izquierda para empezar a chatear. Los mensajes se registran, respondés cuando quieras y el bot se pausa automáticamente al escribir.</div>
    </div>
  </div>
  <div class="info-panel hidden" id="infoPanel"></div>
</div>
<div class="img-viewer" id="imgViewer"><img id="imgViewerImg" alt=""></div>
<div class="modal-bg" id="modalBg"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>

<script>
(function(){
  const state = {
    activeTel: null,
    convs: [],
    labels: [],
    filterLabels: new Set(),
    search: '',
    conv: null,
    canSend: true,
    lastId: 0,
    shellTel: null,
    messagesCache: [],
    infoOpen: false,
    replyTo: null
  };

  // --- Modal & toast helpers (WhatsApp-like, no native prompt) ---
  function showModal(html, onMount){
    const bg = document.getElementById('modalBg');
    const m = document.getElementById('modal');
    m.innerHTML = html;
    bg.classList.add('open');
    if (onMount) onMount(m);
    return new Promise(resolve => {
      bg._resolve = resolve;
      bg.onclick = e => { if (e.target === bg) closeModal(null); };
    });
  }
  function closeModal(value){
    const bg = document.getElementById('modalBg');
    bg.classList.remove('open');
    if (bg._resolve){ const r = bg._resolve; bg._resolve = null; r(value); }
  }
  window._closeModal = closeModal;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.getElementById('modalBg').classList.contains('open')) closeModal(null);
      else if (state.replyTo) cancelReply();
    }
  });

  function toast(msg, isError){
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.className = 'toast' + (isError?' error':''), 2400);
  }

  async function promptModal(title, opts){
    opts = opts || {};
    const html =
      '<h3>'+escapeHtml(title)+'</h3>'+
      (opts.desc ? '<p>'+escapeHtml(opts.desc)+'</p>' : '')+
      '<input id="modalInp" type="'+(opts.type||'text')+'" placeholder="'+escapeHtml(opts.placeholder||'')+'" value="'+escapeHtml(opts.value||'')+'">'+
      '<div class="err" id="modalErr"></div>'+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(null)">Cancelar</button><button class="btn primary" id="modalOk">'+escapeHtml(opts.okLabel||'Aceptar')+'</button></div>';
    return showModal(html, m => {
      const inp = m.querySelector('#modalInp');
      inp.focus();
      const submit = () => {
        const v = inp.value.trim();
        if (opts.required && !v) { m.querySelector('#modalErr').textContent='Requerido'; m.querySelector('#modalErr').classList.add('show'); return; }
        if (opts.validate) { const err = opts.validate(v); if (err){ m.querySelector('#modalErr').textContent=err; m.querySelector('#modalErr').classList.add('show'); return; } }
        closeModal(v);
      };
      m.querySelector('#modalOk').onclick = submit;
      inp.addEventListener('keydown', e => { if (e.key==='Enter'){ e.preventDefault(); submit(); }});
    });
  }
  async function confirmModal(title, desc){
    const html =
      '<h3>'+escapeHtml(title)+'</h3>'+
      (desc ? '<p>'+escapeHtml(desc)+'</p>' : '')+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(false)">Cancelar</button><button class="btn primary" id="modalOk">Confirmar</button></div>';
    return showModal(html, m => { m.querySelector('#modalOk').onclick = () => closeModal(true); });
  }

  const $ = sel => document.querySelector(sel);
  function initials(s){ if(!s) return ''; const p=s.trim().split(/\\s+/); return ((p[0]?.[0]||'')+(p[1]?.[0]||'')).toUpperCase(); }
  const AVATAR_PALETTE = ['#5B7FB1','#E07B5B','#7FA88A','#A07AAD','#B58A4A','#5FA5A5','#C78586','#7B9F5C','#BC6F8E','#5E7B91','#D5946F','#8B7AA7','#6B8E5C','#A37BB1','#C28A55'];
  function avatarColor(seed){
    const s = String(seed || '');
    if (!s) return '#54656F';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
    return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
  }
  const PERSON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"/></svg>';
  function avatarHtml(name, tel){
    const ini = initials(name && !/^\\+?\\d+$/.test(String(name).trim()) ? name : '');
    const bg = avatarColor(tel || name);
    const inner = ini || PERSON_SVG;
    return '<div class="avatar" style="background:'+bg+'">'+inner+'</div>';
  }
  function bigAvatarHtml(name, tel){
    const ini = initials(name && !/^\\+?\\d+$/.test(String(name).trim()) ? name : '');
    const bg = avatarColor(tel || name);
    const inner = ini || PERSON_SVG;
    return '<div class="big-avatar" style="background:'+bg+'">'+inner+'</div>';
  }
  function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function csrfHeader(){
    const m = document.cookie.match(/(?:^|; )csrf=([^;]+)/);
    return m ? { 'X-CSRF-Token': decodeURIComponent(m[1]) } : {};
  }
  function pad(n){ return String(n).padStart(2,'0'); }
  function parseDate(iso){ return iso ? new Date(iso.replace(' ','T')) : null; }
  function sameDay(a,b){ return a && b && a.toDateString()===b.toDateString(); }
  function formatTime(iso){
    const d = parseDate(iso); if (!d) return '';
    return pad(d.getHours())+':'+pad(d.getMinutes());
  }
  function formatListTime(iso){
    const d = parseDate(iso); if (!d) return '';
    const now = new Date();
    if (sameDay(d,now)) return formatTime(iso);
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
    if (sameDay(d,yesterday)) return 'ayer';
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate()-6);
    if (d > weekAgo) return ['dom','lun','mar','mié','jue','vie','sáb'][d.getDay()];
    return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+String(d.getFullYear()).slice(2);
  }
  function formatDayLabel(d){
    const now = new Date();
    if (sameDay(d,now)) return 'HOY';
    const y = new Date(now); y.setDate(y.getDate()-1);
    if (sameDay(d,y)) return 'AYER';
    const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate()-6);
    if (d > weekAgo) return days[d.getDay()];
    return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear();
  }

  function tickFor(status){
    if (status === 'read') return '<span class="tick read">✓✓</span>';
    if (status === 'delivered') return '<span class="tick">✓✓</span>';
    return '<span class="tick">✓</span>';
  }

  async function loadConvs(){
    try {
      const r = await fetch('/admin/inbox/data', { credentials:'same-origin' });
      if (!r.ok) return;
      const { conversations, totalUnread, labels } = await r.json();
      state.convs = conversations;
      state.labels = labels;
      renderLabelFilter();
      renderSidebar();
      if (state.activeTel) {
        const cur = conversations.find(c => c.telefono === state.activeTel);
        if (cur) {
          state.conv = { ...(state.conv || {}), ...cur };
          updateChatHeader();
        }
      }
    } catch {}
  }

  function renderLabelFilter(){
    const el = $('#labelFilter');
    const chips = state.labels.map(l => {
      const active = state.filterLabels.has(l.id) ? 'active' : '';
      return '<button class="label-chip '+active+'" data-id="'+l.id+'" style="background:'+l.color+'">'+escapeHtml(l.name)+'</button>';
    }).join('');
    el.innerHTML = chips + '<button class="label-chip-manage" id="openManageLabels">Gestionar</button>';
    el.querySelectorAll('.label-chip').forEach(n => n.addEventListener('click', () => {
      const id = parseInt(n.dataset.id,10);
      if (state.filterLabels.has(id)) state.filterLabels.delete(id);
      else state.filterLabels.add(id);
      renderLabelFilter();
      renderSidebar();
    }));
    $('#openManageLabels')?.addEventListener('click', manageLabels);
  }

  function renderSidebar(){
    const el = $('#convList');
    let filtered = state.convs;
    if (state.filterLabels.size) {
      filtered = filtered.filter(c => (c.labels||[]).some(l => state.filterLabels.has(l.id)));
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      filtered = filtered.filter(c =>
        (c.nombre||'').toLowerCase().includes(q) ||
        (c.telefono||'').includes(q) ||
        (c.last_body||'').toLowerCase().includes(q)
      );
    }
    if (!filtered.length) {
      el.innerHTML = '<div style="padding:40px;text-align:center;color:#667781;font-size:14px">'+(state.convs.length?'Sin resultados':'Sin conversaciones aún')+'</div>';
      return;
    }
    el.innerHTML = filtered.map(c => {
      const name = c.nombre || c.telefono;
      const unread = c.unread ? '<span class="badge">'+c.unread+'</span>' : '';
      const botTag = c.bot_paused ? '<span class="bot-tag off">Humano</span>' : '<span class="bot-tag">Bot</span>';
      const labels = (c.labels||[]).map(l => '<span class="mini" style="background:'+l.color+'">'+escapeHtml(l.name)+'</span>').join('');
      let preview = '';
      if (c.last_direction === 'out') preview += tickFor(c.last_status) + ' ';
      preview += escapeHtml((c.last_body||'').slice(0,80));
      return '<div class="conv '+(c.telefono===state.activeTel?'active ':'')+(c.unread?'unread ':'')+'" data-tel="'+c.telefono+'">'+
        avatarHtml(name, c.telefono)+
        '<div class="body">'+
          '<div class="row1"><div class="name">'+escapeHtml(name)+botTag+'</div><div class="time">'+formatListTime(c.last_at)+'</div></div>'+
          '<div class="row2"><div class="preview">'+preview+'</div>'+unread+'</div>'+
          (labels ? '<div class="mini-labels">'+labels+'</div>' : '')+
        '</div></div>';
    }).join('');
    el.querySelectorAll('.conv').forEach(n => n.addEventListener('click', () => openConv(n.dataset.tel)));
  }

  async function openConv(tel){
    state.activeTel = tel;
    state.lastId = 0;
    state.infoOpen = false;
    $('#infoPanel').classList.add('hidden');
    $('#layout').classList.add('has-chat');
    document.querySelectorAll('.conv').forEach(n => n.classList.toggle('active', n.dataset.tel===tel));
    await fetchMessages(true);
    try { await fetch('/admin/inbox/'+encodeURIComponent(tel)+'/read', { method:'POST', credentials:'same-origin', headers: csrfHeader() }); } catch {}
    loadConvs();
  }

  async function fetchMessages(scroll){
    if (!state.activeTel) return;
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/messages', { credentials:'same-origin' });
      if (!r.ok) return;
      const { messages, conversation, canSend, recontactTemplate } = await r.json();
      state.conv = conversation;
      state.canSend = canSend;
      state.recontactTemplate = recontactTemplate || null;
      state.messagesCache = messages;
      if (state.shellTel !== state.activeTel) {
        renderShell();
        state.shellTel = state.activeTel;
        state.lastId = 0;
      }
      updateChatHeader();
      applyMessages(messages, scroll);
    } catch {}
  }

  function applyMessages(messages, forceScroll){
    const container = $('#msgs');
    if (!container) return;
    const newOnes = messages.filter(m => m.id > state.lastId);
    if (!state.lastId && messages.length) {
      container.innerHTML = renderMessagesWithDates(messages);
      state.lastId = messages[messages.length-1].id;
      forceScroll = true;
    } else if (newOnes.length) {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      // Re-render entire messages area so date sep + status update consistently
      container.innerHTML = renderMessagesWithDates(messages);
      state.lastId = messages[messages.length-1].id;
      if (nearBottom) forceScroll = true;
    } else {
      // Update ticks (status may have changed)
      for (const m of messages) {
        if (m.direction !== 'out') continue;
        const el = container.querySelector('[data-mid="'+m.id+'"] .tick');
        if (el) {
          el.className = 'tick' + (m.status==='read' ? ' read' : '');
          el.textContent = m.status === 'sent' || !m.status ? '✓' : '✓✓';
        }
      }
    }
    if (forceScroll) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; updateScrollDown(); });
    updateScrollDown();
  }

  function renderMessagesWithDates(messages){
    let out = '';
    let lastDay = null;
    let lastDir = null;
    for (const m of messages) {
      const d = parseDate(m.created_at);
      let isCont = false;
      if (d && (!lastDay || !sameDay(d,lastDay))) {
        out += '<div class="date-sep">'+formatDayLabel(d)+'</div>';
        lastDay = d;
        lastDir = null;
      } else if (lastDir === m.direction) {
        isCont = true;
      }
      out += msgHtml(m, isCont);
      lastDir = m.direction;
    }
    return out;
  }

  function msgHtml(m, isCont){
    const cls = (m.direction==='out' ? 'out' : 'in') + (isCont ? ' cont' : '');
    let inner = '';
    if (m.type === 'image' && m.media_id) {
      inner = '<img src="/admin/media/'+m.media_id+'" alt="imagen" loading="lazy" onclick="event.stopPropagation();window.__showImg(this.src)">';
      const caption = m.body && !m.body.startsWith('📷') ? m.body : '';
      if (caption) inner += '<div class="caption">'+escapeHtml(caption)+'</div>';
    } else if (m.type === 'audio' && m.media_id) {
      inner = '<audio controls src="/admin/media/'+m.media_id+'" onclick="event.stopPropagation()"></audio>';
    } else if (m.type === 'video' && m.media_id) {
      inner = '<video controls src="/admin/media/'+m.media_id+'" onclick="event.stopPropagation()"></video>';
    } else if (m.type === 'document' && m.media_id) {
      const name = (m.body||'').replace(/^📄\\s*/,'') || 'Documento';
      const ext = (name.split('.').pop()||'').toUpperCase().slice(0,5);
      inner = '<a class="doc" href="/admin/media/'+m.media_id+'" target="_blank" download onclick="event.stopPropagation()"><span class="ico">📄</span><div style="flex:1;min-width:0"><div class="doc-name">'+escapeHtml(name)+'</div><div class="doc-sub">'+escapeHtml(ext||'Archivo')+' · descargar</div></div></a>';
    } else {
      inner = escapeHtml(m.body);
    }
    const meta = m.direction === 'out'
      ? '<span class="bubble-meta">'+formatTime(m.created_at)+tickFor(m.status)+'</span>'
      : '<span class="bubble-meta">'+formatTime(m.created_at)+'</span>';
    const preview = (m.body || '').slice(0, 80);
    return '<div class="msg '+cls+'" data-mid="'+m.id+'" data-dir="'+m.direction+'" data-preview="'+escapeHtml(preview)+'">'+inner+meta+'</div>';
  }

  window.__showImg = src => {
    $('#imgViewerImg').src = src;
    $('#imgViewer').classList.add('open');
  };
  $('#imgViewer').addEventListener('click', () => $('#imgViewer').classList.remove('open'));

  function renderShell(){
    $('#chat').innerHTML =
      '<div class="chat-header" id="chatHeader"></div>'+
      '<div class="chat-labels-bar" id="chatLabels"></div>'+
      '<div id="chatBanner"></div>'+
      '<div class="search-bar" id="searchBar">'+
        '<input id="searchInChat" type="text" placeholder="Buscar en este chat…" autocomplete="off">'+
        '<span class="count" id="searchCount"></span>'+
        '<button class="close-search" id="closeSearch" title="Cerrar búsqueda">✕</button>'+
      '</div>'+
      '<div class="messages" id="msgs"></div>'+
      '<button class="scroll-down" id="scrollDown">⌄</button>'+
      '<div class="emoji-picker" id="emojiPicker"></div>'+
      '<div class="attach-menu" id="attachMenu">'+
        '<input type="file" id="fileInpImg" accept="image/*" style="display:none">'+
        '<input type="file" id="fileInpVid" accept="video/*" style="display:none">'+
        '<input type="file" id="fileInpDoc" accept="application/pdf,application/*" style="display:none">'+
        '<button class="img" id="attImg" title="Imagen">🖼️</button>'+
        '<button class="video" id="attVid" title="Video">🎬</button>'+
        '<button class="doc" id="attDoc" title="Documento">📄</button>'+
      '</div>'+
      '<div class="reply-bar" id="replyBar"></div>'+
      '<div class="composer" id="composer">'+
        '<button class="icon-btn" id="btnEmoji" title="Emoji">😊</button>'+
        '<button class="icon-btn" id="btnTpl" title="Plantillas de respuesta">⚡</button>'+
        '<button class="icon-btn" id="btnAttach" title="Adjuntar">📎</button>'+
        '<div class="text-wrap"><textarea id="inp" rows="1" placeholder="Escribí un mensaje"></textarea></div>'+
        '<button class="send-or-mic" id="btnSend" title="Mensaje de voz" aria-label="Enviar">🎤</button>'+
      '</div>';
    const inp = $('#inp');
    const btn = $('#btnSend');
    btn.addEventListener('click', sendMsg);
    inp.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMsg(); } });
    inp.addEventListener('input', () => {
      inp.style.height='auto';
      inp.style.height=Math.min(140, inp.scrollHeight)+'px';
      const has = inp.value.trim().length > 0;
      btn.classList.toggle('has-text', has);
      btn.textContent = has ? '➤' : '🎤';
      btn.title = has ? 'Enviar' : 'Mensaje de voz (no disponible)';
    });
    $('#btnAttach').addEventListener('click', toggleAttach);
    $('#btnEmoji').addEventListener('click', toggleEmoji);
    $('#btnTpl').addEventListener('click', openTemplatesModal);
    $('#attImg').addEventListener('click', () => { $('#fileInpImg').click(); closeMenus(); });
    $('#attVid').addEventListener('click', () => { $('#fileInpVid').click(); closeMenus(); });
    $('#attDoc').addEventListener('click', () => { $('#fileInpDoc').click(); closeMenus(); });
    ['fileInpImg','fileInpVid','fileInpDoc'].forEach(id => $('#'+id).addEventListener('change', () => handleFile($('#'+id).files[0], id)));
    $('#scrollDown').addEventListener('click', () => { $('#msgs').scrollTop = $('#msgs').scrollHeight; });
    $('#msgs').addEventListener('scroll', updateScrollDown);
    // Reply on bubble click (texts only) — long press on mobile, click on desktop
    $('#msgs').addEventListener('click', e => {
      const bubble = e.target.closest('.msg');
      if (!bubble) return;
      // Skip if clicked on media/links/audio (let them work)
      if (e.target.closest('img,audio,video,a,button')) return;
      const text = bubble.dataset.preview || '';
      if (!text) return;
      // Toggle copy/reply menu inline (simple: just trigger reply)
      startReply(bubble.dataset.dir === 'out' ? 'Tú' : (state.conv?.nombre || 'Cliente'), text);
    });
    inp.focus();
  }

  function startReply(who, text){
    state.replyTo = { who, text };
    const bar = $('#replyBar');
    if (!bar) return;
    bar.innerHTML =
      '<div class="quote"><div class="who">'+escapeHtml(who)+'</div><div class="txt">'+escapeHtml(text)+'</div></div>'+
      '<button class="close-reply" id="closeReply" title="Cancelar">✕</button>';
    bar.classList.add('open');
    $('#closeReply').onclick = cancelReply;
    $('#inp')?.focus();
  }
  function cancelReply(){
    state.replyTo = null;
    const bar = $('#replyBar');
    if (bar){ bar.classList.remove('open'); bar.innerHTML=''; }
  }

  // --- Búsqueda dentro del chat ---
  let _searchTimer = null;
  function toggleSearchBar(){
    const bar = $('#searchBar');
    if (!bar) return;
    bar.classList.toggle('open');
    if (bar.classList.contains('open')) {
      const inp = $('#searchInChat');
      inp.value = '';
      inp.focus();
      $('#searchCount').textContent = '';
      inp.addEventListener('input', onSearchInput);
      inp.addEventListener('keydown', e => { if (e.key==='Escape') closeSearchBar(); });
      $('#closeSearch').onclick = closeSearchBar;
    } else {
      closeSearchBar();
    }
  }
  function closeSearchBar(){
    const bar = $('#searchBar');
    if (bar) bar.classList.remove('open');
    clearSearchHighlights();
    $('#searchCount').textContent = '';
  }
  function clearSearchHighlights(){
    document.querySelectorAll('.msg.search-hit').forEach(el => el.classList.remove('search-hit'));
    document.querySelectorAll('.msg mark').forEach(m => {
      const text = m.textContent;
      m.replaceWith(document.createTextNode(text));
    });
  }
  function onSearchInput(e){
    const q = e.target.value.trim();
    clearTimeout(_searchTimer);
    if (q.length < 2) {
      clearSearchHighlights();
      $('#searchCount').textContent = q.length === 1 ? 'Mín. 2 letras' : '';
      return;
    }
    _searchTimer = setTimeout(() => doSearch(q), 220);
  }
  async function doSearch(q){
    if (!state.activeTel) return;
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/search?q='+encodeURIComponent(q), { credentials:'same-origin' });
      const { matches } = await r.json();
      clearSearchHighlights();
      $('#searchCount').textContent = matches.length + ' resultado' + (matches.length===1?'':'s');
      if (!matches.length) return;
      const ids = new Set(matches.map(m => m.id));
      const re = new RegExp('('+q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\\$&')+')', 'gi');
      // Highlight + scroll to first match
      let firstEl = null;
      document.querySelectorAll('.msg').forEach(bub => {
        if (!ids.has(parseInt(bub.dataset.mid, 10))) return;
        bub.classList.add('search-hit');
        if (!firstEl) firstEl = bub;
        // Reemplazar text nodes con highlight
        const walker = document.createTreeWalker(bub, NodeFilter.SHOW_TEXT, null);
        const textNodes = [];
        let n;
        while (n = walker.nextNode()) {
          if (n.parentElement.closest('.bubble-meta, audio, video, a.doc')) continue;
          textNodes.push(n);
        }
        textNodes.forEach(tn => {
          const text = tn.nodeValue;
          if (!re.test(text)) return;
          re.lastIndex = 0;
          const frag = document.createDocumentFragment();
          let last = 0;
          let m;
          while ((m = re.exec(text))) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const mark = document.createElement('mark');
            mark.textContent = m[0];
            frag.appendChild(mark);
            last = re.lastIndex;
          }
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          tn.replaceWith(frag);
        });
      });
      if (firstEl) firstEl.scrollIntoView({ behavior:'smooth', block:'center' });
    } catch (e) {
      $('#searchCount').textContent = 'Error';
    }
  }

  function updateScrollDown(){
    const c = $('#msgs');
    const s = $('#scrollDown');
    if (!c || !s) return;
    const dist = c.scrollHeight - c.scrollTop - c.clientHeight;
    s.classList.toggle('show', dist > 200);
  }

  function updateChatHeader(){
    const header = $('#chatHeader');
    const banner = $('#chatBanner');
    const labelsBar = $('#chatLabels');
    if (!header || !state.conv) return;
    const c = state.conv;
    const name = c.nombre || c.telefono;
    const paused = !!c.bot_paused;
    // "Última vez" — usamos last_at de la conversación si vino del cliente
    const lastSeen = c.last_direction === 'in' && c.last_at
      ? 'visto ' + formatListTime(c.last_at)
      : (paused ? 'Modo humano' : 'Bot activo');
    header.innerHTML =
      '<button class="back" id="btnBack" title="Volver" aria-label="Volver">←</button>'+
      '<div class="info" id="openInfo">'+
        avatarHtml(name, c.telefono)+
        '<div class="info-text"><div class="name">'+escapeHtml(name)+'</div><div class="sub">+'+escapeHtml(c.telefono)+' · '+escapeHtml(lastSeen)+'</div></div>'+
      '</div>'+
      '<div class="actions">'+
        '<button class="ico" id="btnSearch" title="Buscar en este chat">🔍</button>'+
        '<button class="ico" id="btnToggleBot" title="'+(paused?'Reactivar bot':'Pausar bot y tomar control')+'">'+(paused?'🤖':'👤')+'</button>'+
        '<button class="ico" id="btnInfoToggle" title="Datos del contacto">ℹ️</button>'+
      '</div>';
    $('#btnBack').addEventListener('click', closeChat);
    $('#openInfo').addEventListener('click', openInfo);
    $('#btnToggleBot').addEventListener('click', () => toggleBot(!paused));
    $('#btnInfoToggle').addEventListener('click', openInfo);
    $('#btnSearch').addEventListener('click', toggleSearchBar);

    if (labelsBar) {
      const labelChips = (c.labels||[]).map(l =>
        '<span class="chip" style="background:'+l.color+'">'+escapeHtml(l.name)+' <span class="x" data-remove="'+l.id+'">×</span></span>'
      ).join('');
      labelsBar.innerHTML = (labelChips || '<span style="color:#667781">Sin etiquetas</span>') + '<button class="add-btn" id="btnAddLabel">+ Etiqueta</button>';
      labelsBar.querySelectorAll('.x[data-remove]').forEach(n => n.addEventListener('click', e => { e.stopPropagation(); removeLabel(parseInt(n.dataset.remove,10)); }));
      $('#btnAddLabel').addEventListener('click', openLabelMenu);
    }

    if (banner) {
      if (!state.canSend) {
        const tpl = state.recontactTemplate;
        const hasTpl = !!(tpl && tpl.name);
        banner.innerHTML =
          '<div class="chat-sub">' +
            '<span style="flex:1">⏰ Fuera de la ventana de 24 hs de WhatsApp. ' +
            (hasTpl ? 'Reactivá la conversación enviando la plantilla aprobada.' : 'Esperá a que el cliente escriba primero.') +
            '</span>' +
            (hasTpl ? '<button class="btn-recontact" id="btnRecontact">Reactivar con plantilla</button>' : '') +
          '</div>';
        if (hasTpl) {
          const btnR = document.getElementById('btnRecontact');
          if (btnR) btnR.addEventListener('click', sendRecontactTemplate);
        }
      } else {
        banner.innerHTML = '';
      }
    }
    const inp = $('#inp'); const btn = $('#btnSend'); const att = $('#btnAttach'); const emo = $('#btnEmoji');
    if (inp && btn && att && emo) {
      inp.disabled = !state.canSend;
      btn.disabled = !state.canSend;
      att.disabled = !state.canSend;
      emo.disabled = !state.canSend;
      inp.placeholder = state.canSend ? 'Escribí un mensaje' : 'Ventana cerrada (solo lectura)';
    }
  }

  async function openInfo(){
    if (!state.activeTel) return;
    state.infoOpen = true;
    const panel = $('#infoPanel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<div style="padding:40px;text-align:center;color:#667781">Cargando…</div>';
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/info', { credentials:'same-origin' });
      const info = await r.json();
      renderInfoPanel(info);
    } catch { panel.innerHTML = '<div style="padding:40px">Error cargando info</div>'; }
  }

  function renderInfoPanel(info){
    const panel = $('#infoPanel');
    const name = info.nombre || info.telefono;
    const consulta = info.consulta;
    const labelsHtml = (info.labels||[]).map(l => '<span style="display:inline-block;padding:4px 12px;border-radius:999px;color:#fff;background:'+l.color+';font-size:12px;margin:2px">'+escapeHtml(l.name)+'</span>').join('') || '<span style="color:#667781;font-size:13px">Sin etiquetas</span>';
    panel.innerHTML =
      '<div class="info-header">'+
        '<button class="close" id="closeInfo">✕</button>'+
        '<h3>Datos del contacto</h3>'+
      '</div>'+
      '<div class="info-avatar">'+
        bigAvatarHtml(name, info.telefono)+
        '<div class="name">'+escapeHtml(name)+'</div>'+
        '<div class="tel">+'+escapeHtml(info.telefono)+'</div>'+
      '</div>'+
      '<div class="info-section">'+
        '<h4>Etiquetas</h4>'+
        '<div style="padding:6px 0">'+labelsHtml+'</div>'+
      '</div>'+
      (consulta ? ('<div class="info-section">'+
        '<h4>Última consulta</h4>'+
        '<div class="val"><b>Área:</b> '+escapeHtml(consulta.area||'—')+'</div>'+
        '<div class="val"><b>DNI:</b> '+escapeHtml(consulta.dni||'—')+'</div>'+
        '<div class="val"><b>Email:</b> '+escapeHtml(consulta.email||'—')+'</div>'+
        '<div class="val" style="margin-top:6px"><b>Texto:</b>\\n'+escapeHtml(consulta.consulta||'—')+'</div>'+
        '<div class="sub" style="margin-top:10px">Registrada: '+escapeHtml(consulta.created_at||'')+'</div>'+
      '</div>') : '<div class="info-section"><h4>Consultas</h4><div class="val" style="color:#667781">No hay consulta formal registrada todavía.</div></div>') +
      '<div class="info-section">'+
        '<h4>Estadísticas</h4>'+
        '<div class="info-stat">Mensajes totales: <b>'+info.count+'</b></div>'+
      '</div>';
    $('#closeInfo').addEventListener('click', () => {
      state.infoOpen = false;
      $('#infoPanel').classList.add('hidden');
    });
  }

  async function toggleBot(paused){
    if (!state.activeTel) return;
    await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/bot', {
      method:'POST', credentials:'same-origin',
      headers:{...csrfHeader(),'Content-Type':'application/json'}, body: JSON.stringify({paused})
    });
    fetchMessages(false);
    loadConvs();
  }

  function openLabelMenu(e){
    e?.stopPropagation();
    closeLabelMenu();
    const assigned = new Set((state.conv?.labels||[]).map(l => l.id));
    const items = state.labels.map(l => {
      if (assigned.has(l.id)) return '';
      return '<div class="item" data-add="'+l.id+'"><span class="dot" style="background:'+l.color+'"></span>'+escapeHtml(l.name)+'</div>';
    }).filter(Boolean).join('');
    const menu = document.createElement('div');
    menu.className = 'label-menu open';
    menu.id = 'labelMenu';
    menu.innerHTML = (items || '<div style="padding:8px 12px;color:#667781;font-size:13px">Todas asignadas</div>') +
      '<div class="divider"></div><div class="new" id="newLabel">+ Nueva etiqueta…</div>';
    const rect = $('#btnAddLabel').getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    document.body.appendChild(menu);
    menu.querySelectorAll('.item[data-add]').forEach(n => n.addEventListener('click', () => addLabel(parseInt(n.dataset.add,10))));
    menu.querySelector('#newLabel').addEventListener('click', createLabelPrompt);
    setTimeout(() => document.addEventListener('click', closeLabelMenu, { once: true }), 0);
  }
  function closeLabelMenu(){ const m = document.getElementById('labelMenu'); if (m) m.remove(); }

  async function addLabel(id){
    closeLabelMenu();
    const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/labels/'+id, { method:'POST', credentials:'same-origin', headers: csrfHeader() });
    const j = await r.json();
    if (state.conv) state.conv.labels = j.labels;
    updateChatHeader();
    loadConvs();
  }

  async function removeLabel(id){
    const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/labels/'+id, { method:'DELETE', credentials:'same-origin', headers: csrfHeader() });
    const j = await r.json();
    if (state.conv) state.conv.labels = j.labels;
    updateChatHeader();
    loadConvs();
  }

  async function createLabelPrompt(){
    closeLabelMenu();
    const name = await promptModal('Nueva etiqueta', { placeholder:'Ej: VIP', required:true, okLabel:'Continuar' });
    if (!name) return;
    const color = await promptModal('Color (hex)', { placeholder:'#00A884', value:'#00A884', okLabel:'Crear', validate: v => /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'Formato hex inválido' });
    if (!color) return;
    const r = await fetch('/admin/labels', {
      method:'POST', credentials:'same-origin',
      headers:{...csrfHeader(),'Content-Type':'application/json'}, body: JSON.stringify({name:name.trim(), color})
    });
    if (!r.ok) { toast('Error creando etiqueta', true); return; }
    const j = await r.json();
    state.labels.push({ id:j.id, name:j.name, color:j.color });
    if (state.activeTel) await addLabel(j.id);
    else loadConvs();
    toast('Etiqueta "'+j.name+'" creada');
  }

  async function manageLabels(){
    // Construir un modal con la lista actual y opciones
    const items = state.labels.map(l =>
      '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F0F2F5">'+
        '<span style="width:14px;height:14px;border-radius:50%;background:'+l.color+';flex-shrink:0"></span>'+
        '<span style="flex:1;color:#111B21">'+escapeHtml(l.name)+'</span>'+
        '<button class="btn secondary" data-del="'+l.id+'" data-name="'+escapeHtml(l.name)+'" style="padding:4px 10px;font-size:12px;color:#C23B1E">Eliminar</button>'+
      '</div>'
    ).join('') || '<p style="color:#667781">Sin etiquetas creadas todavía.</p>';
    showModal(
      '<h3>Gestionar etiquetas</h3>'+
      '<div style="max-height:300px;overflow-y:auto;margin-bottom:14px">'+items+'</div>'+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(null)">Cerrar</button><button class="btn primary" id="newLab">+ Nueva</button></div>',
      m => {
        m.querySelector('#newLab').onclick = () => { closeModal(null); createLabelPrompt(); };
        m.querySelectorAll('button[data-del]').forEach(b => b.onclick = async () => {
          const id = b.dataset.del;
          const nm = b.dataset.name;
          closeModal(null);
          if (!await confirmModal('Eliminar etiqueta', '"'+nm+'" se quitará de todas las conversaciones.')) return;
          await fetch('/admin/labels/'+id, { method:'DELETE', credentials:'same-origin', headers: csrfHeader() });
          toast('Etiqueta "'+nm+'" eliminada');
          loadConvs();
        });
      }
    );
  }
  $('#manageLabels').addEventListener('click', manageLabels);

  // --- Plantillas de respuesta ---
  async function openTemplatesModal(){
    closeMenus();
    let tpls = [];
    try {
      const r = await fetch('/admin/templates', { credentials:'same-origin' });
      tpls = (await r.json()).templates || [];
    } catch { toast('Error cargando plantillas', true); return; }
    const items = tpls.map(t =>
      '<div class="tpl-item" data-id="'+t.id+'">'+
        '<div class="tpl-row">'+
          '<div class="tpl-name">'+escapeHtml(t.name)+'</div>'+
          '<div class="tpl-actions">'+
            '<button class="tpl-btn use" data-use="'+t.id+'" title="Usar esta plantilla">Usar</button>'+
            '<button class="tpl-btn edit" data-edit="'+t.id+'" title="Editar">✎</button>'+
            '<button class="tpl-btn del" data-del="'+t.id+'" data-name="'+escapeHtml(t.name)+'" title="Eliminar">×</button>'+
          '</div>'+
        '</div>'+
        '<div class="tpl-body">'+escapeHtml(t.body)+'</div>'+
      '</div>'
    ).join('') || '<p style="color:#667781">Aún no hay plantillas. Creá la primera ↓</p>';
    showModal(
      '<h3>Plantillas de respuesta</h3>'+
      '<p>Hacé clic en "Usar" para insertar el texto en el composer.</p>'+
      '<div id="tplList" style="max-height:380px;overflow-y:auto;margin-bottom:14px;display:flex;flex-direction:column;gap:6px">'+items+'</div>'+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(null)">Cerrar</button><button class="btn primary" id="newTpl">+ Nueva plantilla</button></div>',
      m => {
        m.querySelector('#newTpl').onclick = () => { closeModal(null); createTemplatePrompt(); };
        m.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
          const t = tpls.find(x => x.id == b.dataset.use);
          if (!t) return;
          insertTextAtCursor(t.body);
          closeModal(null);
          toast('Plantilla "'+t.name+'" insertada');
        });
        m.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
          const t = tpls.find(x => x.id == b.dataset.edit);
          if (!t) return;
          closeModal(null);
          editTemplatePrompt(t);
        });
        m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
          const id = b.dataset.del;
          const nm = b.dataset.name;
          closeModal(null);
          if (!await confirmModal('Eliminar plantilla', '¿Eliminar "'+nm+'"?')) return;
          await fetch('/admin/templates/'+id, { method:'DELETE', credentials:'same-origin', headers: csrfHeader() });
          toast('Plantilla eliminada');
        });
      }
    );
  }

  function insertTextAtCursor(text){
    const inp = $('#inp');
    if (!inp) return;
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    inp.value = inp.value.slice(0, start) + text + inp.value.slice(end);
    inp.focus();
    const pos = start + text.length;
    inp.selectionStart = inp.selectionEnd = pos;
    inp.style.height = 'auto';
    inp.style.height = Math.min(140, inp.scrollHeight) + 'px';
    // Trigger input event para actualizar el botón send/mic
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function createTemplatePrompt(){
    const html =
      '<h3>Nueva plantilla</h3>'+
      '<input id="tplName" type="text" placeholder="Nombre (ej: Saludo inicial)" maxlength="80">'+
      '<textarea id="tplBody" placeholder="Texto de la plantilla…" rows="6" style="width:100%;padding:10px 12px;border:1px solid #DFE5E7;border-radius:6px;font-size:14px;font-family:inherit;outline:none;resize:vertical;margin-bottom:10px;color:#111B21"></textarea>'+
      '<div class="err" id="tplErr"></div>'+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(null)">Cancelar</button><button class="btn primary" id="saveTpl">Guardar</button></div>';
    showModal(html, m => {
      m.querySelector('#tplName').focus();
      m.querySelector('#saveTpl').onclick = async () => {
        const name = m.querySelector('#tplName').value.trim();
        const body = m.querySelector('#tplBody').value.trim();
        const err = m.querySelector('#tplErr');
        if (!name || !body) { err.textContent='Nombre y texto requeridos'; err.classList.add('show'); return; }
        const r = await fetch('/admin/templates', {
          method:'POST', credentials:'same-origin',
          headers:{...csrfHeader(),'Content-Type':'application/json'},
          body: JSON.stringify({ name, body })
        });
        if (!r.ok) { err.textContent='Error guardando'; err.classList.add('show'); return; }
        closeModal(null);
        toast('Plantilla "'+name+'" creada');
        openTemplatesModal();
      };
    });
  }

  function editTemplatePrompt(tpl){
    const html =
      '<h3>Editar plantilla</h3>'+
      '<input id="tplName" type="text" maxlength="80" value="'+escapeHtml(tpl.name)+'">'+
      '<textarea id="tplBody" rows="6" style="width:100%;padding:10px 12px;border:1px solid #DFE5E7;border-radius:6px;font-size:14px;font-family:inherit;outline:none;resize:vertical;margin-bottom:10px;color:#111B21">'+escapeHtml(tpl.body)+'</textarea>'+
      '<div class="err" id="tplErr"></div>'+
      '<div class="btns"><button class="btn secondary" onclick="_closeModal(null)">Cancelar</button><button class="btn primary" id="saveTpl">Guardar</button></div>';
    showModal(html, m => {
      m.querySelector('#saveTpl').onclick = async () => {
        const name = m.querySelector('#tplName').value.trim();
        const body = m.querySelector('#tplBody').value.trim();
        const err = m.querySelector('#tplErr');
        if (!name || !body) { err.textContent='Nombre y texto requeridos'; err.classList.add('show'); return; }
        const r = await fetch('/admin/templates/'+tpl.id, {
          method:'PUT', credentials:'same-origin',
          headers:{...csrfHeader(),'Content-Type':'application/json'},
          body: JSON.stringify({ name, body })
        });
        if (!r.ok) { err.textContent='Error guardando'; err.classList.add('show'); return; }
        closeModal(null);
        toast('Plantilla actualizada');
        openTemplatesModal();
      };
    });
  }

  async function sendMsg(){
    const inp = $('#inp');
    const btn = $('#btnSend');
    let body = inp.value.trim();
    if (!body || !state.activeTel || !state.canSend) return;
    // If replying, prepend a quote (text-only client-side; WA doesn't render real reply via API but it's clear)
    if (state.replyTo){
      const q = (state.replyTo.text || '').slice(0, 120);
      body = '> ' + state.replyTo.who + ': ' + q + '\\n\\n' + body;
    }
    btn.disabled = true;
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/send', {
        method:'POST', credentials:'same-origin',
        headers:{...csrfHeader(),'Content-Type':'application/json'}, body: JSON.stringify({ body })
      });
      if (!r.ok) {
        const j = await r.json().catch(()=>({}));
        toast('Error enviando: '+(j.detail||j.error||'desconocido'), true);
      } else {
        inp.value = '';
        inp.style.height='auto';
        cancelReply();
        btn.classList.remove('has-text');
        btn.textContent = '🎤';
        await fetchMessages(true);
        loadConvs();
      }
    } finally {
      btn.disabled = false;
      inp.focus();
    }
  }
  async function sendRecontactTemplate(){
    if (!state.activeTel || !state.recontactTemplate) return;
    const tpl = state.recontactTemplate;
    const ok = await confirmModal(
      'Reactivar conversación',
      'Se enviará la plantilla "'+tpl.name+'" ('+tpl.lang+') al cliente:\\n\\n"'+tpl.preview+'"\\n\\nEsto reabre la ventana de 24 hs cuando el cliente responda.'
    );
    if (!ok) return;
    const btnR = document.getElementById('btnRecontact');
    if (btnR) { btnR.disabled = true; btnR.textContent = 'Enviando…'; }
    try {
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/send-template', {
        method:'POST', credentials:'same-origin',
        headers:{...csrfHeader(),'Content-Type':'application/json'},
        body: '{}'
      });
      const j = await r.json().catch(()=>({}));
      if (!r.ok) {
        toast((j.detail || 'Error de WhatsApp') + (j.hint ? ' — '+j.hint : ''), true);
      } else {
        toast('Plantilla enviada');
        await fetchMessages(true);
        loadConvs();
      }
    } catch (e) {
      toast('Error de red', true);
    } finally {
      if (btnR) { btnR.disabled = false; btnR.textContent = 'Reactivar con plantilla'; }
    }
  }
  function closeChat(){
    state.activeTel = null;
    state.shellTel = null;
    state.conv = null;
    state.lastId = 0;
    cancelReply();
    $('#layout').classList.remove('has-chat');
    $('#chat').innerHTML = '<div class="chat-empty"><div class="icon-circle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div><div class="big">WhatsApp Web · COLUMEN</div><div class="sub">Seleccioná un contacto.</div></div>';
    document.querySelectorAll('.conv').forEach(n => n.classList.remove('active'));
  }

  async function handleFile(file, inputId){
    if (!file || !state.activeTel) return;
    if (file.size > 14 * 1024 * 1024) { toast('Archivo muy grande (máx 14 MB)', true); if (inputId) $('#'+inputId).value=''; return; }
    const caption = await promptModal('Enviar archivo', {
      desc: file.name + ' (' + (file.size/1024).toFixed(0) + ' KB)',
      placeholder: 'Caption opcional…',
      okLabel: 'Enviar'
    });
    if (caption === null) { if (inputId) $('#'+inputId).value=''; return; }
    const btn = $('#btnSend');
    const att = $('#btnAttach');
    btn.disabled = true; att.disabled = true;
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch('/admin/inbox/'+encodeURIComponent(state.activeTel)+'/send-image', {
        method:'POST', credentials:'same-origin',
        headers:{...csrfHeader(),'Content-Type':'application/json'},
        body: JSON.stringify({ filename: file.name, mime: file.type, data: base64, caption })
      });
      if (!r.ok) {
        const j = await r.json().catch(()=>({}));
        toast('Error: '+(j.detail||j.error||'desconocido'), true);
      } else {
        await fetchMessages(true);
        loadConvs();
        toast('Archivo enviado');
      }
    } catch (e) {
      toast('Error: '+e.message, true);
    } finally {
      if (inputId) $('#'+inputId).value = '';
      btn.disabled = false; att.disabled = false;
    }
  }

  function toggleAttach(e){
    e?.stopPropagation();
    const m = $('#attachMenu');
    $('#emojiPicker').classList.remove('open');
    m.classList.toggle('open');
    if (m.classList.contains('open')) setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
  }
  function toggleEmoji(e){
    e?.stopPropagation();
    const p = $('#emojiPicker');
    if (!p.dataset.built) {
      const emojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','👍','👎','👌','👏','🙏','💪','🤝','👊','✌️','🤞','🤟','🤘','🫶','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕','💖','💗','💘','🔥','⭐','✨','⚡','💯','✅','❌','⚠️','📞','📱','💬','📧','📄','📷','🎉','🎁'];
      p.innerHTML = '<div class="emoji-grid">'+emojis.map(e=>'<button data-e="'+e+'">'+e+'</button>').join('')+'</div>';
      p.querySelectorAll('button[data-e]').forEach(b => b.addEventListener('click', () => insertEmoji(b.dataset.e)));
      p.dataset.built = '1';
    }
    $('#attachMenu').classList.remove('open');
    p.classList.toggle('open');
    if (p.classList.contains('open')) setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
  }
  function insertEmoji(e){
    const inp = $('#inp');
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    inp.value = inp.value.slice(0,start) + e + inp.value.slice(end);
    inp.focus();
    inp.selectionStart = inp.selectionEnd = start + e.length;
  }
  function closeMenus(){
    $('#attachMenu')?.classList.remove('open');
    $('#emojiPicker')?.classList.remove('open');
  }

  $('#searchInp').addEventListener('input', e => { state.search = e.target.value; renderSidebar(); });
  $('#btnNewChat').addEventListener('click', async () => {
    const tel = await promptModal('Nuevo chat', {
      desc: 'Ingresá el número con código país (ej: 5492617571910).',
      placeholder: '5492617XXXXXXX',
      required: true,
      okLabel: 'Abrir chat',
      validate: v => /^\\d{10,15}$/.test(v.trim()) ? null : 'Solo dígitos, 10-15 caracteres'
    });
    if (!tel) return;
    openConv(tel.trim());
  });

  loadConvs();
  setInterval(() => { loadConvs(); if (state.activeTel) fetchMessages(false); }, 4000);
})();
</script>
</body></html>`);
});

// --- Formulario de consulta (abierto desde WhatsApp) ---
app.get('/consulta', (req, res) => {
  const area = req.query.area || '';
  const tel = req.query.tel || '';
  const sent = req.query.sent === '1';
  const errMsg = req.query.err === 'consent' ? '<div class="err">Para continuar tenés que aceptar la política de privacidad.</div>' : '';
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
  .consent-row{display:flex;align-items:flex-start;gap:10px;margin:6px 0 16px;padding:10px 12px;background:#fbf7e8;border-radius:10px;font-size:12.5px;color:#5a4a1a;line-height:1.45}
  .consent-row input[type=checkbox]{width:auto;margin:3px 0 0;flex-shrink:0}
  .consent-row label{margin:0;font-weight:400;color:#5a4a1a;font-size:12.5px}
  .consent-row a{color:#8a6d2b;text-decoration:underline}
  button{width:100%;padding:14px;background:#1c1c1c;color:#f4f0e4;border:none;border-radius:999px;font-size:15px;font-weight:500;cursor:pointer;margin-top:4px}
  button:hover{background:#2a2a2a}
  button:disabled{opacity:.5;cursor:not-allowed}
  .success{text-align:center;padding:40px 20px}
  .success .check{font-size:48px;margin-bottom:16px}
  .success h2{margin-bottom:12px}
  .success p{color:#666;font-size:15px;line-height:1.5}
  .err{background:#fee;border:1px solid #fcc;color:#900;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}
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
  ${errMsg}
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
    <div class="consent-row">
      <input type="checkbox" name="consent" id="consent" value="1" required>
      <label for="consent">He leído y acepto la <a href="/legales/privacidad" target="_blank" rel="noopener">política de privacidad</a> y el <a href="/legales/aviso-legal" target="_blank" rel="noopener">aviso legal</a> del estudio.</label>
    </div>
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
  const { telefono, area, nombre, dni, email, consulta, consent } = req.body || {};
  if (!consent) {
    const qs = new URLSearchParams({ area: area || '', tel: telefono || '', err: 'consent' });
    return res.redirect(`/consulta?${qs.toString()}`);
  }
  db.prepare('INSERT INTO consultas (telefono, area, nombre, dni, email, consulta) VALUES (?, ?, ?, ?, ?, ?)').run(
    telefono || '', area || '', nombre || '', dni || '', email || '', consulta || ''
  );
  snapshotDB('consulta');
  res.redirect(`/consulta?sent=1`);
});

// --- WhatsApp bot (Cloud API directo, sin Kapso) ---
// Dedup persistente: usa tabla processed_messages (sobrevive restarts y multi-instancia)
const _checkProcessed = db.prepare('SELECT 1 FROM processed_messages WHERE wa_id = ?');
const _markProcessed = db.prepare('INSERT OR IGNORE INTO processed_messages (wa_id) VALUES (?)');
function isProcessed(waId) { return !!_checkProcessed.get(waId); }
function markProcessed(waId) { try { _markProcessed.run(waId); } catch {} }
const debugLog = [];
function logDebug(event) {
  debugLog.push({ ts: new Date().toISOString(), ...event });
  if (debugLog.length > 100) debugLog.shift();
}

function recordMessage(tel, direction, type, body, waId, mediaId, mediaMime) {
  try {
    db.prepare('INSERT INTO messages (wa_id, telefono, direction, type, body, media_id, media_mime) VALUES (?,?,?,?,?,?,?)').run(waId || null, tel, direction, type || 'text', body || '', mediaId || null, mediaMime || null);
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
  if (payload.type === 'image') return payload.image?.caption || '📷 Foto';
  if (payload.type === 'document') return payload.document?.caption || payload.document?.filename || '📄 Documento';
  if (payload.type === 'video') return payload.video?.caption || '🎥 Video';
  if (payload.type === 'audio') return '🎤 Audio';
  if (payload.type === 'interactive') {
    const main = payload.interactive?.body?.text || '';
    const btns = (payload.interactive?.action?.buttons || []).map(b => `[${b.reply?.title}]`).join(' ');
    return btns ? `${main}\n${btns}` : main;
  }
  if (payload.type === 'template') {
    return RECONTACT_TEMPLATE_PREVIEW;
  }
  return `[${payload.type}]`;
}

function outboundMediaFor(payload) {
  const mediaTypes = ['image','audio','video','document','sticker'];
  if (mediaTypes.includes(payload.type)) {
    const m = payload[payload.type] || {};
    return { mediaId: m.id || null, mediaMime: null };
  }
  return { mediaId: null, mediaMime: null };
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
      const media = outboundMediaFor(payload);
      recordMessage(payload.to, 'out', payload.type, outboundBodyFor(payload), waId, media.mediaId, media.mediaMime);
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
      body: { text: 'Hola! Bienvenido a *COLUMEN* - Estudio Legal & Notarial.\n\nPara orientarte mejor, seleccioná el área de tu consulta:\n\n_Al continuar aceptás nuestra política de privacidad: columen.ar/legales/privacidad_' },
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

// Envía la plantilla aprobada de re-contacto (UTILITY, sin variables).
// Reabre la ventana de 24hs cuando el cliente responde.
function sendTemplate(to, name = RECONTACT_TEMPLATE_NAME, language = RECONTACT_TEMPLATE_LANG) {
  return waSend({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
    },
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

// Debug endpoint - muestra ultimos eventos del bot (admin only)
app.get('/bot-debug', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauth' });
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
// HMAC signature verification (X-Hub-Signature-256) is enforced before parsing
app.post('/webhook', verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    const statuses = value?.statuses || [];
    if (statuses.length) {
      const upd = db.prepare('UPDATE messages SET status = ? WHERE wa_id = ?');
      for (const s of statuses) {
        if (['sent','delivered','read','failed'].includes(s.status) && s.id) {
          upd.run(s.status, s.id);
        }
      }
    }
    logDebug({ kind: 'webhook_in', hasMsg: !!msg, msgType: msg?.type, from: msg?.from });
    if (!msg) return;

    if (isProcessed(msg.id)) { logDebug({ kind: 'dedup_skip', id: msg.id }); return; }
    markProcessed(msg.id);

    const from = msg.from;
    console.log('[WA] msg from', maskTel(from), 'type', msg.type);

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

    if (['image','audio','video','document','sticker'].includes(msg.type)) {
      const media = msg[msg.type] || {};
      const caption = media.caption || '';
      const label = msg.type==='image' ? '📷 Foto' : msg.type==='audio' ? '🎤 Audio' : msg.type==='video' ? '🎥 Video' : msg.type==='document' ? `📄 ${media.filename || 'Documento'}` : '⭐ Sticker';
      const body = caption ? `${label}\n${caption}` : label;
      recordMessage(from, 'in', msg.type, body, msg.id, media.id, media.mime_type);
      const conv = db.prepare('SELECT bot_paused FROM conversations WHERE telefono = ?').get(from);
      if (conv?.bot_paused) return;
      return sendText(from, 'Gracias por tu mensaje. Para atenderte mejor, escribinos en texto así podemos tomar tus datos y un profesional te contacta a la brevedad.');
    }

    recordMessage(from, 'in', msg.type, `[${msg.type}]`, msg.id);
  } catch (err) {
    console.error('[WA] webhook handler error', err);
  }
});

// --- Páginas legales con URLs limpias (sin .html) ---
app.get('/legales/privacidad', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legales', 'privacidad.html'));
});
app.get('/legales/aviso-legal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legales', 'aviso-legal.html'));
});

// --- SEO files ---
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(__dirname, 'public', 'robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

// --- Health check (público, para EasyPanel/Cloudflare) ---
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, db: 'ok', uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'error', error: e.message });
  }
});

// --- Serve landing page ---
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Columen running on port ${PORT}`);
});

// Graceful shutdown — drena conexiones, cierra DB, exit limpio
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} recibido, cerrando…`);
  const force = setTimeout(() => { console.error('[shutdown] timeout, forzando exit'); process.exit(1); }, 10000);
  server.close(() => {
    try { db.close(); } catch {}
    clearTimeout(force);
    console.log('[shutdown] cerrado limpio');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
