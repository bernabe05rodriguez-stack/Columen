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

// Meta WhatsApp Cloud API
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'columen-verify-2026';
const APP_SECRET = process.env.APP_SECRET || '';

// URLs
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://redhawk-columen.bm6z1s.easypanel.host';

// Backups off-site
const BACKUP_OFFSITE_TOKEN = process.env.BACKUP_OFFSITE_TOKEN || '';
const BACKUP_OFFSITE_REPO = process.env.BACKUP_OFFSITE_REPO || '';
const BACKUP_OFFSITE_BRANCH = process.env.BACKUP_OFFSITE_BRANCH || 'main';

// Validaciones soft (warns, no fail)
function logConfigWarnings() {
  if (!APP_SECRET) console.error('[config] APP_SECRET not set — webhook signature verification will FAIL');
  if (!ADMIN_PASS_HASH && !ADMIN_PASS) console.error('[config] No ADMIN_PASS_HASH or ADMIN_PASS configured — login disabled');
  if (!ADMIN_PASS_HASH && ADMIN_PASS) console.warn('[config] Using plaintext ADMIN_PASS fallback — set ADMIN_PASS_HASH (bcrypt) and remove ADMIN_PASS ASAP');
  if (!WA_TOKEN) console.warn('[config] WHATSAPP_TOKEN not set — outbound messages will fail');
  if (!BACKUP_OFFSITE_TOKEN || !BACKUP_OFFSITE_REPO) console.warn('[config] Backup off-site disabled (missing BACKUP_OFFSITE_TOKEN or BACKUP_OFFSITE_REPO)');
}

module.exports = {
  NODE_ENV, IS_PROD, PORT,
  ADMIN_USER, ADMIN_PASS, ADMIN_PASS_HASH, SESSION_SECRET, RATE_LIMIT_LOGIN_MAX,
  WA_TOKEN, WA_PHONE_ID, WA_VERIFY_TOKEN, APP_SECRET,
  PUBLIC_URL,
  BACKUP_OFFSITE_TOKEN, BACKUP_OFFSITE_REPO, BACKUP_OFFSITE_BRANCH,
  logConfigWarnings,
};
