# Columen - Setup Bot WhatsApp (whatsapp-web.js, número propio)

> Desde 2026-07 el bot corre con **whatsapp-web.js**: un WhatsApp común (261 757 1910) vinculado como "dispositivo" del servidor. Sin Meta Cloud API, sin webhook, sin plantillas ni ventana de 24hs. Los setups viejos (Meta directo y Kapso) quedaron en el tag `meta-cloud-api` del repo.

## Arquitectura

```
Usuario → wa.me/5492617571910 → WhatsApp del número (teléfono con el SIM)
  → sesión vinculada en el server (whatsapp-web.js + Chromium, /data/wa-session)
  → state machine del bot (SQLite): menú texto "1 Jurídico / 2 Notarial"
    → nombre → DNI → email → consulta → INSERT consultas
  → visible en /admin (consultas) y /admin/inbox (chat completo)
```

## Vincular el número (primera vez o re-vinculación)

1. Tener el **SIM del 261 757 1910 en un teléfono** con WhatsApp registrado (código por SMS).
2. Entrar a **https://columen.ar/admin/conexion** (login admin).
3. En el teléfono: **Dispositivos vinculados → Vincular un dispositivo** → escanear el QR.
   - Alternativa sin cámara: en `/admin/conexion` usar "vincular con número + código" (`requestPairingCode`) y tipear el código de 8 caracteres en el teléfono.
4. Cuando el chip queda 🟢 (`ready`), el bot y el inbox funcionan.

El QR rota cada ~20-30s; la página lo refresca sola. El estado también se ve en `GET /healthz` (campo `wa`).

## Qué hay que saber (operación)

- **La sesión sobrevive redeploys**: cierre graceful en SIGTERM + sesión persistida en el volumen `/data/wa-session`. Solo se borra ante LOGOUT/UNPAIRED real (alguien desvinculó desde el teléfono) → en ese caso, re-escanear.
- **Loop `disconnected` tras un redeploy**: casi siempre son locks de Chromium (`SingletonLock`); el supervisor los limpia solo al arrancar. Si persiste: botón **Reconectar** en `/admin/conexion`.
- **LOGOUT instantáneo al escanear**: la versión de WhatsApp Web que trae whatsapp-web.js envejece. Está pinneada y vendored en `src/wa/webcache/<version>.html`. Si reaparece el problema: bajar un HTML más nuevo de [wppconnect/wa-version](https://github.com/wppconnect-team/wa-version), commitearlo ahí y actualizar la versión en `src/wa/client.js`.
- **Sin botones interactivos**: WhatsApp común no los soporta (eran de Meta). El menú es texto: responder "1" o "2".
- **Riesgo asumido**: whatsapp-web.js es no-oficial → posible baneo del número o pedidos de re-vincular. Por eso existe `/admin/conexion`.

## Troubleshooting

| Síntoma | Qué hacer |
|---|---|
| `/healthz` → `wa` ≠ `ready` | Ver estado y QR en `/admin/conexion`. Estados: `starting/qr/authenticating/ready/disconnected/auth_failure` |
| Bot no responde a un chat puntual | El chat tiene el bot pausado (toggle 🤖/👤 en el inbox) o revisar `/bot-debug` |
| QR "vencido" / no deja escanear | Recargar `/admin/conexion` (el QR se auto-refresca; si no, F5) |
| Se desloguea al escanear | Versión WhatsApp Web vieja → actualizar `src/wa/webcache/` (ver arriba) |

## Rollback a Meta Cloud API

`git checkout meta-cloud-api` tiene el código viejo completo. Además de deployarlo, habría que **re-registrar el número en Cloud API** (se dio de baja con `deregister` el 2026-07-14) y restaurar las env vars `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` / `WHATSAPP_VERIFY_TOKEN` / `APP_SECRET` (valores en el vault de Obsidian, `proyectos/Columen.md`).
