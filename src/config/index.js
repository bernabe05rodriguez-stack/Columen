// Centralización de variables de entorno y defaults.
// Único lugar donde se leen process.env.* — todo el resto del código debe importar desde aquí.

const crypto = require('crypto');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const PORT = process.env.PORT || 80;

// Auth
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || '';
// SESSION_SECRET no se usa en el código actual (las sesiones son DB-backed con tokens random),
// se mantiene por compat futura.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const RATE_LIMIT_LOGIN_MAX = parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '5', 10);

// WhatsApp (whatsapp-web.js — sesión por QR con número propio, sin Meta Cloud API)
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || '';   // default lo resuelve src/wa/client.js
const WA_MEDIA_DIR = process.env.WA_MEDIA_DIR || '';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '';

// URLs
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://columen.ar';

// Backups off-site
const BACKUP_OFFSITE_TOKEN = process.env.BACKUP_OFFSITE_TOKEN || '';
const BACKUP_OFFSITE_REPO = process.env.BACKUP_OFFSITE_REPO || '';
const BACKUP_OFFSITE_BRANCH = process.env.BACKUP_OFFSITE_BRANCH || 'main';

// Validaciones soft (warns, no fail)
function logConfigWarnings() {
  if (!ADMIN_PASS_HASH && !ADMIN_PASS) console.error('[config] No ADMIN_PASS_HASH or ADMIN_PASS configured — login disabled');
  if (!ADMIN_PASS_HASH && ADMIN_PASS) console.warn('[config] Using plaintext ADMIN_PASS fallback — set ADMIN_PASS_HASH (bcrypt) and remove ADMIN_PASS ASAP');
  if (!BACKUP_OFFSITE_TOKEN || !BACKUP_OFFSITE_REPO) console.warn('[config] Backup off-site disabled (missing BACKUP_OFFSITE_TOKEN or BACKUP_OFFSITE_REPO)');
}

module.exports = {
  NODE_ENV, IS_PROD, PORT,
  ADMIN_USER, ADMIN_PASS, ADMIN_PASS_HASH, SESSION_SECRET, RATE_LIMIT_LOGIN_MAX,
  WA_SESSION_DIR, WA_MEDIA_DIR, CHROMIUM_PATH,
  PUBLIC_URL,
  BACKUP_OFFSITE_TOKEN, BACKUP_OFFSITE_REPO, BACKUP_OFFSITE_BRANCH,
  logConfigWarnings,
};
