# CLAUDE.md — Columen

Contexto y lecciones específicas de este repo. Info general del proyecto: `proyectos/Columen.md` en el vault de Obsidian.

## Qué es

Landing + bot de WhatsApp + admin (inbox estilo WhatsApp Web, backup, blog CMS) para un estudio jurídico-notarial de Mendoza. Un solo `server.js` (Express + SQLite) + `src/wa/client.js` (whatsapp-web.js). Deploy en EasyPanel (`redhawk/columen`), https://columen.ar.

## Reglas inviolables (ver README para el detalle)

1. **Cero pérdida de datos** — comparar `/admin/count` antes/después de cada deploy.
2. **Migraciones aditivas** vía `runMigration(name, fn)` — nunca DROP.
3. **Volumen `/data` sagrado** — DB + sesión de WhatsApp + media.
4. **Snapshot pre-deploy** — o botón "Hacer backup ahora" en `/admin/backup`.
5. **`zeroDowntime` debe quedar en `false`** en EasyPanel: con zero-downtime dos contenedores pisan el mismo perfil de Chromium y **se pierde la sesión de WhatsApp** (pide re-escanear QR). Con `false`, la sesión sobrevive redeploys (validado 11+ veces, reconecta en ~15-45s).

## Lecciones WhatsApp (whatsapp-web.js) — no volver a tropezar

- **Remitentes LID**: WhatsApp puede identificar remitentes como `<lid>@lid` (NO es un teléfono). Responder reconstruyendo `<digitos>@c.us` falla con `"No LID for user"`. Solución en el repo: tabla `chat_ids` (telefono→JID exacto, TODOS los envíos salen por ahí) + número real vía `senderPn` → cache → `client.getContactLidAndPhone()` + `repairLidTelefonos()` en cada ready.
- **LOGOUT instantáneo al escanear QR** = versión de WhatsApp Web vieja → está pinneada y vendored en `src/wa/webcache/<version>.html`. Si reaparece: bajar HTML nuevo de wppconnect/wa-version y actualizar la versión en `src/wa/client.js`.
- **Loop `disconnected`** tras kill del contenedor = locks de Chromium (`SingletonLock`); el supervisor los limpia al arrancar.
- **La sesión SOLO se limpia en LOGOUT/UNPAIRED real** — nunca borrar `/data/wa-session` por un corte.
- **Espejo teléfono↔web**: `message_create` (fromMe desde el teléfono → registra y pausa bot; dedup por `wa_id` con delay 1.5s porque los envíos propios también disparan el evento), `unread_count` (leídos), `syncMissedMessages()` en ready (mensajes perdidos durante deploys).
- **Bot humanizado**: TODA respuesta del bot va por `sendBotReply()` (delay variable + `sendStateTyping` + cancela si un humano tomó el chat). No usar `sendText` directo en flujos del bot.
- **Serializar entrantes por conversación** (`_inboxQueues`): `handleIncoming` encola por `msg.from` y corre `_handleIncoming` de a uno. Sin esto, dos burbujas seguidas corrían en paralelo, leían el mismo `bot_state` y **duplicaban respuestas** (agravado por los delays y por `@lid` que consulta a WA antes de tocar el estado).
- **NO confiar en `wa_id` para distinguir envíos propios**: el `message_create` de la propia respuesta del bot llega con un `wa_id` distinto (o null) al de `sendMessage`, así que `handleOutgoingCreate` la tomaba como "mensaje del teléfono" → `bot_paused=1` + borraba el estado → **el bot se auto-pausaba tras contestar**. Identificar los envíos propios (bot/panel) por **huella de contenido** (`noteOwnSend`/`isOwnSend`: destinatario+texto, ventana 60s), registrada ANTES del `await`. Los mensajes escritos DESDE el teléfono (no pasan por `sendText`) sí pausan el bot. Los envíos del PANEL pausan vía su endpoint `/admin/inbox/:tel/bot`.
- **No marcar `processed_messages` antes de responder con éxito**: `sendText` reintenta ante `WA_NOT_READY` (`withWaRetry`) para no descartar la respuesta en un blip de reconexión (el mensaje ya marcado nunca se reintenta).
- **`bot_paused` se auto-reactiva** por inactividad (`BOT_RESUME_HOURS`, env, default 12; `0`=nunca) para que un chat no quede mudo tras una intervención humana puntual.
- **Deploy cuando `deployService` da HTTP 000 (TLS)**: usar la deploy webhook URL que da `inspectService` como `deploymentUrl` (`POST http://84.46.252.202:3000/api/deploy/<token>`). Diagnóstico del bot: `GET /bot-debug` (auth) lista los últimos eventos.
- El healthz expone `wa` (starting/qr/authenticating/ready/disconnected/auth_failure); el estado completo (número conectado incluido) está en `GET /admin/conexion/status` (auth).

## Lecciones de infraestructura

- **EasyPanel API**: mutaciones tRPC devuelven `{}` aunque NO apliquen (zod no-estricto descarta campos desconocidos) — SIEMPRE verificar con `inspectService` (POST con body, no GET). `updateDeploy` lleva el objeto ANIDADO en `deploy`.
- **Deploy**: `git push` (git de Windows) + `POST services.app.deployService` — el auto-deploy por push no es confiable. El timeout del curl durante el build es normal.
- **Rollback a Meta Cloud API**: tag `meta-cloud-api` + re-registrar el número en Cloud API + env vars de Meta (valores en el vault).
- **EasyPanel intercepta TODO 5xx** con su página HTML — usar 4xx para errores de upstream.

## Dev local (WSL)

- Correr con **cwd en ext4** (`~/columen-dev`), NO en /mnt/c: SQLite WAL sobre NTFS se corrompe con 2 conexiones o kill (la DB queda en 0 bytes). `PORT=3030 NODE_ENV=development ADMIN_PASS=test ADMIN_USER=admin CHROMIUM_PATH=/nonexistent node /mnt/c/.../Columen/server.js` — el WA queda `disconnected` (esperado) y el resto anda.
- Primer arranque tarda ~5 min (hidratación OneDrive de node_modules); después es rápido.
- Screenshots de UI sin sudo: `playwright-core` + headless shell de `~/.cache/ms-playwright` + libs en `~/locallibs` (`LD_LIBRARY_PATH`), cookie de sesión vía `context.addCookies`.
- La UI del admin vive EMBEBIDA en `server.js` (template literals): ojo con backticks y `${}` al editar; `node --check server.js` siempre antes de commitear.

## Backup

- Automático: snapshot local al arrancar/cada hora/por consulta/blog; off-site (GitHub privado `columen-backups`) en startup/hourly/manual: `snapshots/latest.db` + daily + media incremental. Estado y botón manual en `/admin/backup`.
- La **sesión de WhatsApp NO se respalda a propósito** (riesgo de robo de cuenta; se recupera re-escaneando).
