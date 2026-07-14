// src/wa/client.js
// Capa de transporte de WhatsApp usando whatsapp-web.js (sesión por QR, número propio).
// Reemplaza a la Meta Cloud API. Mantiene UNA sola sesión (un único WhatsApp vinculado).
//
// Diseño:
//   - Este módulo es "tonto" respecto de la DB: solo habla con WhatsApp y guarda/lee
//     archivos de media. La lógica del bot y el logueo en SQLite viven en server.js,
//     que se engancha vía los callbacks onMessage / onAck.
//   - El estado observable (state) lo lee el panel /admin/conexion.

const path = require('path');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// --- Paths persistentes (deben vivir en el volumen /data para sobrevivir deploys) ---
const DATA_ROOT = fs.existsSync('/data') ? '/data' : './data';
// Absolutos: res.sendFile (media) exige ruta absoluta y LocalAuth es más predecible así.
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || path.join(DATA_ROOT, 'wa-session'));
const MEDIA_DIR = path.resolve(process.env.WA_MEDIA_DIR || path.join(DATA_ROOT, 'media'));
for (const d of [SESSION_DIR, MEDIA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// --- Estado observable por el panel ---
// status: starting | qr | authenticating | ready | disconnected | auth_failure
const state = {
  status: 'starting',
  qrDataUrl: null,        // data:image/png cuando status === 'qr'
  qrVersion: 0,           // se incrementa en cada QR nuevo (el QR rota cada ~20-30s)
  pairingCode: null,      // código de 8 chars para vincular con número (método alternativo)
  info: null,             // { number, pushname, platform }
  lastReadyAt: null,
  lastDisconnectAt: null,
  lastError: null,
  startedAt: new Date().toISOString(),
};

let client = null;
let callbacks = { onMessage: null, onAck: null };
let relinking = false;
let lastQrString = null;
let everReady = false;  // ¿alguna vez llegó a estar conectado en esta corrida?
let authedOnce = false; // ¿la sesión guardada llegó a autenticarse alguna vez?

// Borra el contenido de la carpeta de sesión (fuerza un QR nuevo). Se usa cuando
// la sesión guardada quedó parcial/corrupta (mostró QR pero nunca se autenticó),
// que si no provoca un loop de 'disconnected' al reintentar restaurarla.
function wipeSession() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    for (const f of fs.readdirSync(SESSION_DIR)) {
      try { fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true }); } catch {}
    }
    console.log('[wa] sesión limpiada — se generará un QR nuevo');
  } catch (e) { console.error('[wa] wipeSession error', e.message); }
}

function getState() {
  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    qrVersion: state.qrVersion,
    pairingCode: state.pairingCode,
    info: state.info,
    lastReadyAt: state.lastReadyAt,
    lastDisconnectAt: state.lastDisconnectAt,
    lastError: state.lastError,
  };
}

// Localiza el Chromium del sistema (instalado en el Dockerfile). Si no lo encuentra,
// deja que puppeteer use el bundled (útil en dev local).
function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined;
}

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath: chromiumPath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',   // evita crashes por /dev/shm chico en contenedores
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    },
  });

  c.on('qr', async (qr) => {
    state.status = 'qr';
    state.info = null;
    lastQrString = qr; // guardado por si se pide un código de emparejamiento
    try {
      state.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      state.qrVersion++; // avisa al panel que hay un QR nuevo → refresca solo la imagen
    } catch (e) {
      state.qrDataUrl = null;
      console.error('[wa] no pude renderizar el QR', e.message);
    }
    console.log('[wa] QR nuevo (v' + state.qrVersion + ') — escaneá desde /admin/conexion');
  });

  c.on('loading_screen', (percent) => { state.status = 'authenticating'; });
  c.on('authenticated', () => {
    authedOnce = true; // la sesión guardada es válida → nunca la borres por un blip
    state.status = 'authenticating';
    state.qrDataUrl = null;
    console.log('[wa] autenticado, cargando sesión…');
  });
  c.on('auth_failure', (msg) => {
    state.status = 'auth_failure';
    state.lastError = String(msg);
    console.error('[wa] auth_failure:', msg);
  });

  c.on('ready', () => {
    state.status = 'ready';
    everReady = true;
    state.qrDataUrl = null;
    state.pairingCode = null;
    state.lastReadyAt = new Date().toISOString();
    state.lastError = null;
    try {
      state.info = {
        number: c.info?.wid?.user || null,
        pushname: c.info?.pushname || null,
        platform: c.info?.platform || null,
      };
    } catch {}
    console.log('[wa] LISTO — número vinculado:', state.info?.number);
  });

  c.on('disconnected', async (reason) => {
    state.status = 'disconnected';
    state.lastDisconnectAt = new Date().toISOString();
    state.lastError = String(reason);
    console.warn('[wa] desconectado:', reason);
    if (relinking) return; // un relink/logout maneja su propia reinicialización
    // Si nunca se autenticó (sesión parcial/podrida), limpiarla para que el rebuild
    // muestre un QR nuevo en vez de loopear en 'disconnected'. Si la sesión SÍ era
    // válida (authedOnce), se preserva y solo se reconecta.
    const wipe = !authedOnce && !everReady;
    everReady = false;
    setTimeout(() => { rebuild({ wipe }).catch(e => console.error('[wa] auto-reconnect fail', e.message)); }, 6000);
  });

  c.on('message', async (msg) => {
    try { if (callbacks.onMessage) await callbacks.onMessage(msg); }
    catch (e) { console.error('[wa] onMessage handler error', e.message); }
  });

  c.on('message_ack', (msg, ack) => {
    // ack: 1=server(sent) 2=device(delivered) 3=read 4=played
    try {
      if (!callbacks.onAck) return;
      const map = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
      const status = map[ack];
      if (status && msg?.id?._serialized) callbacks.onAck(msg.id._serialized, status);
    } catch (e) { console.error('[wa] onAck handler error', e.message); }
  });

  return c;
}

// Destruye el cliente actual (si hay) y arranca uno nuevo. Con { wipe:true }
// borra la sesión guardada antes (para forzar un QR nuevo).
async function rebuild({ wipe } = {}) {
  if (client) {
    try { await client.destroy(); } catch {}
  }
  if (wipe) { wipeSession(); authedOnce = false; }
  client = buildClient();
  await client.initialize();
}

function init({ onMessage, onAck } = {}) {
  callbacks.onMessage = onMessage || null;
  callbacks.onAck = onAck || null;
  if (client) return client;
  client = buildClient();
  client.initialize().catch(e => {
    state.status = 'disconnected';
    state.lastError = e.message;
    console.error('[wa] init error:', e.message);
    setTimeout(() => { rebuild().catch(() => {}); }, 8000);
  });
  return client;
}

function ensureReady() {
  if (!client || state.status !== 'ready') {
    const err = new Error('WhatsApp no está conectado (estado: ' + state.status + ')');
    err.code = 'WA_NOT_READY';
    throw err;
  }
}

// Convierte un teléfono/JID a chatId de whatsapp-web.js.
function toChatId(raw) {
  const s = String(raw || '').trim();
  if (s.includes('@')) return s;
  const digits = s.replace(/[^\d]/g, '');
  return digits + '@c.us';
}

// --- Envío ---
async function sendText(to, body) {
  ensureReady();
  const msg = await client.sendMessage(toChatId(to), String(body));
  return msg;
}

// media: { data(base64), mimetype, filename, caption }
async function sendMedia(to, media) {
  ensureReady();
  const mm = new MessageMedia(media.mimetype, media.data, media.filename || undefined);
  const msg = await client.sendMessage(toChatId(to), mm, { caption: media.caption || undefined });
  return msg;
}

// Resuelve un número "crudo" a su JID real en WhatsApp (para chats iniciados por el admin).
// Devuelve el JID serializado o null si el número no tiene WhatsApp.
async function resolveNumber(raw) {
  ensureReady();
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const id = await client.getNumberId(digits);
  return id ? id._serialized : null;
}

// Método alternativo al QR: vincular con número + código de 8 caracteres.
// En WhatsApp: Dispositivos vinculados → Vincular dispositivo → "Vincular con número".
async function requestPairingCode(rawNumber) {
  const digits = String(rawNumber || '').replace(/[^\d]/g, '');
  if (digits.length < 8) throw new Error('Número inválido (usá formato internacional, ej: 5492617571910)');
  if (!client) throw Object.assign(new Error('WhatsApp todavía no inició'), { code: 'WA_NOT_READY' });
  if (state.status === 'ready') throw new Error('Ya hay un WhatsApp conectado. Desvinculá primero.');
  // Reintenta unos segundos si el cliente aún no llegó al punto de emparejamiento.
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const code = await client.requestPairingCode(digits, true);
      state.pairingCode = code;
      console.log('[wa] pairing code generado para', digits.slice(-4));
      return code;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr || new Error('No se pudo generar el código');
}

// --- Media en disco (/data/media) ---
const SAFE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf' };

function extFor(mimetype, fallback) {
  if (SAFE_EXT[mimetype]) return SAFE_EXT[mimetype];
  if (fallback && /\.([a-z0-9]{1,5})$/i.test(fallback)) return fallback.split('.').pop().toLowerCase();
  const sub = String(mimetype || '').split('/')[1] || 'bin';
  return sub.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
}

// Guarda base64 en /data/media y devuelve el fileId (nombre de archivo seguro).
function saveBase64(base64, mimetype, filenameHint) {
  const ext = extFor(mimetype, filenameHint);
  const rand = require('crypto').randomBytes(8).toString('hex');
  const fileId = `${Date.now()}-${rand}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, fileId), Buffer.from(base64, 'base64'));
  return fileId;
}

// Descarga la media de un mensaje entrante y la guarda. Devuelve { fileId, mimetype } o null.
async function saveIncomingMedia(msg) {
  try {
    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;
    const fileId = saveBase64(media.data, media.mimetype, media.filename);
    return { fileId, mimetype: media.mimetype };
  } catch (e) {
    console.error('[wa] saveIncomingMedia error', e.message);
    return null;
  }
}

function mediaPath(fileId) {
  // Solo nombres de archivo seguros (evita path traversal).
  if (!/^[\w.\-]+$/.test(fileId) || fileId.includes('..')) return null;
  const p = path.join(MEDIA_DIR, fileId);
  return fs.existsSync(p) ? p : null;
}

// --- Acciones del panel ---
async function reconnect() {
  await rebuild();
}

// Cierra sesión (desvincula el número) y vuelve a mostrar QR para escanear otro.
async function relink() {
  relinking = true;
  try {
    if (client) {
      try { await client.logout(); } catch (e) { console.warn('[wa] logout warn', e.message); }
      try { await client.destroy(); } catch {}
    }
    everReady = false;
    authedOnce = false;
    wipeSession(); // garantiza QR nuevo al cambiar de número
    state.status = 'starting';
    state.info = null;
    state.qrDataUrl = null;
    state.pairingCode = null;
    client = buildClient();
    await client.initialize();
  } finally {
    relinking = false;
  }
}

module.exports = {
  init, getState,
  sendText, sendMedia, resolveNumber, requestPairingCode,
  saveIncomingMedia, saveBase64, mediaPath,
  reconnect, relink,
  MEDIA_DIR, SESSION_DIR,
};
