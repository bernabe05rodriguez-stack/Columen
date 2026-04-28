# Columen — Estudio Legal & Notarial

Plataforma de un estudio jurídico-notarial de Mendoza (Argentina). Una landing pública, un bot de WhatsApp Cloud API directo (sin Kapso) y un panel admin con inbox estilo WhatsApp Web.

URL: https://columen.ar
Admin: https://columen.ar/admin

## Stack

- **Node.js 20 + Express** (un único `server.js`, sirve API + HTML/CSS/JS embebido del admin)
- **better-sqlite3** (DB en `/data/columen.db`)
- **Meta WhatsApp Cloud API** (webhook directo, HMAC firmado)
- **EasyPanel** (`redhawk/columen`) sobre Docker, dominio propio con Let's Encrypt
- **Cloudflare DNS** (`columen.ar` → `84.46.252.202`, DNS only sin proxy)
- **Backups**: snapshots locales en `/data/backups/` (50 más recientes) + push off-site a un repo privado de GitHub vía Contents API

## Endpoints

### Públicos
| | |
|---|---|
| `GET /` | Landing |
| `GET /healthz` | Health check (DB ping + uptime) |
| `GET /webhook` | Verificación de Meta (`hub.challenge`) |
| `POST /webhook` | Mensajes y statuses entrantes (firma HMAC obligatoria) |
| `GET /consulta` | Form web fallback al bot |
| `POST /consulta` | Submit del form (consent obligatorio) |
| `GET /legales/privacidad` | Política de privacidad |
| `GET /legales/aviso-legal` | Aviso legal |

### Admin (auth con cookie de sesión + CSRF en POST/DELETE)
| | |
|---|---|
| `GET/POST /admin/login` · `GET /admin/logout` | Auth |
| `GET /admin` · `GET /admin/count` | Dashboard de consultas + polling |
| `GET /admin/inbox` | Panel WhatsApp Web |
| `GET /admin/inbox/data` · `:tel/messages` · `:tel/info` | JSON del inbox |
| `POST /admin/inbox/:tel/send` · `send-image` · `read` · `bot` | Envío + estado |
| `POST/DELETE /admin/inbox/:tel/labels/:id` | Etiquetas por chat |
| `GET/POST /admin/labels` · `DELETE /admin/labels/:id` | CRUD de etiquetas |
| `GET /admin/media/:id` | Proxy auth a Meta CDN |
| `GET /admin/backup` · `GET /admin/backup/download[?file=…]` | Snapshots DB |
| `GET /bot-debug` (auth) | Últimos eventos + estados del bot |

## Variables de entorno

```bash
# Auth
ADMIN_USER=admin
ADMIN_PASS_HASH=$2b$12$...          # bcrypt(password)
NODE_ENV=production                  # activa cookie Secure
RATE_LIMIT_LOGIN_MAX=5

# Meta WhatsApp
WHATSAPP_TOKEN=...                   # System User Token permanente
WHATSAPP_PHONE_ID=1087869691071322
WHATSAPP_VERIFY_TOKEN=...
APP_SECRET=...                       # App Secret (HMAC del webhook)

# Backups off-site (GitHub privado)
BACKUP_OFFSITE_TOKEN=ghp_...
BACKUP_OFFSITE_REPO=user/repo
BACKUP_OFFSITE_BRANCH=main           # default

# URLs
PUBLIC_URL=https://columen.ar
TZ=America/Argentina/Buenos_Aires
```

## Deploy

Auto-deploy GitHub→EasyPanel no es confiable. Tras `git push`:

```bash
curl -X POST 'https://panel.redhawk.digital/api/trpc/services.app.deployService' \
  -H 'Authorization: Bearer <api_key>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"projectName":"redhawk","serviceName":"columen"}}'
```

EasyPanel tarda 1-3 min. Verificar con `curl https://columen.ar/healthz`.

## Reglas inviolables

1. **Cero pérdida de datos.** Antes y después de cada deploy: `curl https://columen.ar/admin/count` (autenticado) y comparar. Si baja → rollback inmediato.
2. **Migraciones aditivas.** Solo `ALTER TABLE … ADD COLUMN`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Pasar siempre por `runMigration(name, fn)`. Nunca `DROP`/`ALTER … DROP`.
3. **Volumen `/data` sagrado.** El mount `columen-data → /data` no se toca. Antes de un cambio que afecte storage, verificar con `docker inspect`.
4. **Snapshot pre-deploy.** Hit a `/admin/backup` antes de cada deploy importante (genera `pre-deploy-…` en `/data/backups/` y push offsite).

## Runbook de incidente

### "Se perdieron consultas"
1. NO asumir. Primero verificar conteos:
   ```bash
   curl -b cookies.txt https://columen.ar/admin/count
   ```
2. Si bajó: descargar snapshot reciente desde `/admin/backup` (`?file=columen-YYYY-MM-DD-…db`).
3. El archivo descargado SÍ está consolidado (vía `db.backup()` de better-sqlite3). El archivo `columen.db` de descarga sin `?file=` baja el archivo en vivo sin aplicar WAL — puede mostrar 0 tablas aunque la DB esté llena. Para inspección, **siempre** usar los snapshots.
4. Restore: `docker cp` del snapshot al contenedor sobreescribiendo `/data/columen.db` + restart del servicio en EasyPanel.

### Webhook deja de recibir
1. `curl -i https://columen.ar/webhook` → 403 esperado (sin firma).
2. Logs en EasyPanel: buscar `[WA] webhook rejected`. Si dice `APP_SECRET not configured`, falta env var.
3. Si dice `invalid signature` constantemente: rotar `APP_SECRET` desde Meta y actualizar EasyPanel.
4. En Meta Business: panel de webhook → "test" → `messages`.

### Bot no responde
1. `/bot-debug` (logueado) → últimos 100 eventos.
2. Verificar que `bot_paused = 0` para esa conversación (admin/inbox toggle 🤖/👤).
3. Si Meta devuelve 401: el `WHATSAPP_TOKEN` (system user token) no debería expirar pero comprobar en business.facebook.com/settings/system-users.

## Development local

```bash
npm install
APP_SECRET=… ADMIN_PASS_HASH=… NODE_ENV=development PORT=3030 node server.js
# http://localhost:3030/healthz
```

DB y backups se generan en `./data/` cuando no existe `/data` (Docker volume).

## Esquema de la DB

Detalle completo del schema, migraciones y notas de implementación: `proyectos/Columen.md` en el vault de Obsidian.

## Seguridad

- **Webhook Meta**: HMAC `X-Hub-Signature-256` con `APP_SECRET`, `crypto.timingSafeEqual`.
- **Login admin**: bcrypt + rate-limit 5 intentos/15min/IP + cookie HttpOnly + Secure + SameSite=Strict.
- **CSRF**: double-submit cookie en todo POST/DELETE de `/admin/*`.
- **Headers**: helmet con CSP afinado, HSTS, X-Frame-Options DENY/SAMEORIGIN, Referrer-Policy.
- **Path traversal**: backup download valida nombre con regex `^columen-[\w\-:]+\.db$`.
- **Logs**: teléfonos enmascarados en producción (solo últimos 4 dígitos).
- **Datos personales**: cumple Ley 25.326 ARG. Páginas de privacidad y aviso legal con consentimiento explícito antes de recolectar.

## Estructura del repo

```
.
├── server.js                  # Toda la app (Express + bot + admin + backups)
├── public/
│   ├── index.html             # Landing
│   ├── favicon.svg
│   └── legales/
│       ├── privacidad.html
│       └── aviso-legal.html
├── Dockerfile                 # node:20-alpine + tzdata + VOLUME /data
├── package.json
└── README.md
```
