# Columen — Estudio Legal & Notarial

Plataforma de un estudio jurídico-notarial de Mendoza (Argentina). Una landing pública, un bot de WhatsApp con número propio (whatsapp-web.js, vinculado por QR) y un panel admin con inbox estilo WhatsApp Web.

URL: https://columen.ar
Admin: https://columen.ar/admin

## Stack

- **Node.js 20 + Express** (un único `server.js`, sirve API + HTML/CSS/JS embebido del admin)
- **better-sqlite3** (DB en `/data/columen.db`)
- **whatsapp-web.js + Chromium** (número propio vinculado por QR; sesión `LocalAuth` en `/data/wa-session`, media entrante en `/data/media`). Supervisor en `src/wa/client.js`: auto-reconexión, limpieza de locks de Chromium, versión de WhatsApp Web vendored en `src/wa/webcache/`
- **EasyPanel** (`redhawk/columen`) sobre Docker (Debian slim + Chromium del sistema), dominio propio con Let's Encrypt
- **Cloudflare DNS** (`columen.ar` → `84.46.252.202`, DNS only sin proxy)
- **Backups**: snapshots locales en `/data/backups/` (50 más recientes) + push off-site a un repo privado de GitHub vía Contents API (`snapshots/latest.db`, un daily por día, y los archivos de `/data/media` de forma incremental). Estado visible en `/admin/backup` (semáforos local/off-site/media) + botón "Hacer backup ahora" (`POST /admin/backup/run`). La sesión de WhatsApp NO se respalda a propósito (riesgo de robo de cuenta; se recupera re-escaneando el QR)

> Hasta 2026-07 el bot corría sobre Meta Cloud API. La migración completa está en el tag `meta-cloud-api` (rollback) y documentada en el vault de Obsidian.

## Endpoints

### Públicos
| | |
|---|---|
| `GET /` | Landing |
| `GET /healthz` | Health check (DB ping + uptime + estado WhatsApp `wa`) |
| `GET /consulta` | Form web fallback al bot |
| `POST /consulta` | Submit del form (consent obligatorio) |
| `GET /legales/privacidad` | Política de privacidad |
| `GET /legales/aviso-legal` | Aviso legal |

### Admin (auth con cookie de sesión + CSRF en POST/DELETE)
| | |
|---|---|
| `GET/POST /admin/login` · `GET /admin/logout` | Auth |
| `GET /admin` · `GET /admin/count` | Dashboard de consultas + polling |
| `GET /admin/conexion` | Estado de la conexión WhatsApp + QR + vinculación por número+código + Reconectar/Desvincular |
| `GET /admin/inbox` | Panel WhatsApp Web |
| `GET /admin/inbox/data` · `:tel/messages` · `:tel/info` | JSON del inbox |
| `POST /admin/inbox/:tel/send` · `send-image` · `read` · `bot` | Envío + estado |
| `POST/DELETE /admin/inbox/:tel/labels/:id` | Etiquetas por chat |
| `GET/POST /admin/labels` · `DELETE /admin/labels/:id` | CRUD de etiquetas |
| `GET /admin/media/:id` | Sirve media guardada en `/data/media` |
| `GET /admin/backup` · `GET /admin/backup/download[?file=…]` | Estado del backup + snapshots DB |
| `POST /admin/backup/run` | Backup manual (local + off-site + media), espera el resultado real |
| `GET /bot-debug` (auth) | Últimos eventos + estados del bot |

## Variables de entorno

```bash
# Auth
ADMIN_USER=admin
ADMIN_PASS_HASH=$2b$12$...          # bcrypt(password)
SESSION_SECRET=...
NODE_ENV=production                  # activa cookie Secure
RATE_LIMIT_LOGIN_MAX=5

# WhatsApp (opcionales — defaults sanos en src/config/index.js y src/wa/client.js)
WA_SESSION_DIR=/data/wa-session
WA_MEDIA_DIR=/data/media
CHROMIUM_PATH=/usr/bin/chromium

# Backups off-site (GitHub privado)
BACKUP_OFFSITE_TOKEN=github_pat_...
BACKUP_OFFSITE_REPO=user/repo
BACKUP_OFFSITE_BRANCH=main           # default

# URLs
PUBLIC_URL=https://columen.ar
TZ=America/Argentina/Buenos_Aires
```

## Deploy

Auto-deploy GitHub→EasyPanel no es confiable. Tras `git push`:

```bash
curl -X POST 'https://bm6z1s.easypanel.host/api/trpc/services.app.deployService' \
  -H 'Authorization: Bearer <api_key>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"projectName":"redhawk","serviceName":"columen"}}'
```

EasyPanel tarda 1-3 min. Verificar con `curl https://columen.ar/healthz` (`wa` debe volver a `ready`: la sesión de WhatsApp sobrevive redeploys gracias al cierre graceful en SIGTERM).

## Reglas inviolables

1. **Cero pérdida de datos.** Antes y después de cada deploy: `curl https://columen.ar/admin/count` (autenticado) y comparar. Si baja → rollback inmediato.
2. **Migraciones aditivas.** Solo `ALTER TABLE … ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Pasar siempre por `runMigration(name, fn)`. Nunca `DROP`/`ALTER … DROP`.
3. **Volumen `/data` sagrado.** El mount `columen-data → /data` no se toca (contiene la DB **y la sesión de WhatsApp**). Antes de un cambio que afecte storage, verificar con `docker inspect`.
4. **Snapshot pre-deploy.** Hit a `/admin/backup` antes de cada deploy importante (genera `pre-deploy-…` en `/data/backups/` y push offsite).
5. **La sesión de WhatsApp solo se limpia en LOGOUT/UNPAIRED real.** Nunca borrar `/data/wa-session` por un corte o reinicio — obligaría a re-escanear el QR.

## Runbook de incidente

### "Se perdieron consultas"
1. NO asumir. Primero verificar conteos:
   ```bash
   curl -b cookies.txt https://columen.ar/admin/count
   ```
2. Si bajó: descargar snapshot reciente desde `/admin/backup` (`?file=columen-YYYY-MM-DD-…db`).
3. El archivo descargado SÍ está consolidado (vía `db.backup()` de better-sqlite3). El archivo `columen.db` de descarga sin `?file=` baja el archivo en vivo sin aplicar WAL — puede mostrar 0 tablas aunque la DB esté llena. Para inspección, **siempre** usar los snapshots.
4. Restore: `docker cp` del snapshot al contenedor sobreescribiendo `/data/columen.db` + restart del servicio en EasyPanel.

### WhatsApp desconectado (`/healthz` → `wa` ≠ `ready`)
1. Estados posibles: `starting | qr | authenticating | ready | disconnected | auth_failure`.
2. Entrar a `/admin/conexion` (logueado): muestra el estado en vivo y, si hace falta, el QR para re-vincular (o el método número+código).
3. Si loopea en `disconnected`: suele ser un lock de Chromium tras un kill del contenedor — el supervisor lo limpia solo; si persiste, botón "Reconectar" en `/admin/conexion`.
4. Si al escanear el QR se desloguea al instante (LOGOUT inmediato): la versión de WhatsApp Web vendored quedó vieja → bajar un HTML más nuevo de wppconnect/wa-version a `src/wa/webcache/` y actualizar la versión pinneada en `src/wa/client.js`.
5. Si aparece `UNPAIRED`/`LOGOUT` real: alguien desvinculó el dispositivo desde el teléfono → re-escanear QR.

### Bot no responde
1. `/bot-debug` (logueado) → últimos 100 eventos.
2. Verificar que `bot_paused = 0` para esa conversación (admin/inbox toggle 🤖/👤).
3. Verificar `wa: ready` en `/healthz`; si no, ver runbook de arriba.

## Development local

```bash
npm install
ADMIN_PASS_HASH=… NODE_ENV=development PORT=3030 node server.js
# http://localhost:3030/healthz
```

DB, backups, sesión de WhatsApp y media se generan en `./data/` cuando no existe `/data` (Docker volume). Requiere un Chromium local (`CHROMIUM_PATH` si no está en el default).

## Esquema de la DB

Detalle completo del schema, migraciones y notas de implementación: `proyectos/Columen.md` en el vault de Obsidian.

## Seguridad

- **Login admin**: bcrypt + rate-limit 5 intentos/15min/IP + cookie HttpOnly + Secure + SameSite=Strict.
- **CSRF**: double-submit cookie en todo POST/DELETE de `/admin/*`.
- **Headers**: helmet con CSP afinado, HSTS, X-Frame-Options DENY/SAMEORIGIN, Referrer-Policy.
- **Path traversal**: backup download valida nombre con regex `^columen-[\w\-:]+\.db$`; `/admin/media/:id` valida el fileId contra traversal en `wa.mediaPath`.
- **Logs**: teléfonos enmascarados en producción (solo últimos 4 dígitos).
- **Datos personales**: cumple Ley 25.326 ARG. Páginas de privacidad y aviso legal con consentimiento explícito antes de recolectar.

## Estructura del repo

```
.
├── server.js                  # Toda la app (Express + bot + admin + backups)
├── src/
│   ├── config/index.js        # Único lugar que lee process.env
│   ├── db/index.js
│   └── wa/
│       ├── client.js          # whatsapp-web.js: supervisor, QR, pairing code, media
│       └── webcache/          # Versión de WhatsApp Web vendored (fix LOGOUT)
├── public/
│   ├── index.html             # Landing
│   ├── paginas/               # Landing pages SEO
│   └── legales/
├── Dockerfile                 # Debian slim + Chromium + tzdata + VOLUME /data
├── package.json
├── SETUP-BOT.md               # Cómo vincular/re-vincular el número
└── README.md
```
