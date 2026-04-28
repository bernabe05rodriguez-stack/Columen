// Inicialización de la DB SQLite y helpers básicos.
// Este módulo es el ÚNICO lugar que abre la conexión y configura pragmas.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Path estrategy: /data en Docker (volume mounted), ./data fallback en dev
const DB_DIR = fs.existsSync('/data') ? '/data' : './data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'columen.db');
const BACKUP_DIR = path.join(DB_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');

// Migration runner — idempotente, sobrevive a restarts y no toca datos
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT (datetime('now','localtime'))
)`);
function runMigration(name, fn) {
  const exists = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name);
  if (exists) return;
  try {
    fn();
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    console.log('[migration] applied:', name);
  } catch (e) {
    console.error('[migration] FAILED', name, e.message);
    throw e;
  }
}

module.exports = { db, runMigration, DB_PATH, BACKUP_DIR, DB_DIR };
