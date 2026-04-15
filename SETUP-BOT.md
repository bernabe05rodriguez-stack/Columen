# Columen - Setup Bot WhatsApp (Meta Cloud API directo)

> Kapso fue eliminado. El bot ahora corre en `server.js` conectado directo a la Graph API de Meta.

## Arquitectura

```
Usuario en web → wa.me/5492617571910 → Meta Cloud API
  → webhook POST /webhook a server.js
  → server envía 2 botones (Jurídico / Notarial)
  → usuario toca botón → server envía link a /consulta?area=X&tel=Y
  → usuario llena form web → POST /consulta → SQLite → /admin
```

## Env vars necesarias en EasyPanel

| Variable | Valor |
|---|---|
| `WHATSAPP_TOKEN` | Token de Meta (ver abajo) |
| `WHATSAPP_PHONE_ID` | `1087869691071322` |
| `WHATSAPP_VERIFY_TOKEN` | string random que elegís (ej: `columen-verify-2026`) |
| `PUBLIC_URL` | `https://redhawk-columen.bm6z1s.easypanel.host` |

## Configurar webhook en Meta

1. developers.facebook.com → app "Columen" → WhatsApp → Configuración → Webhooks
2. Callback URL: `https://redhawk-columen.bm6z1s.easypanel.host/webhook`
3. Verify token: el mismo que pusiste en `WHATSAPP_VERIFY_TOKEN`
4. Verificar y suscribirse al campo **messages**

## Token permanente (para producción)

El token de API Setup dura 24h. Para que ande siempre, generar System User Token:
1. business.facebook.com/settings/system-users → crear system user "columen-api" (admin)
2. Asignarle la WABA Columen con control total
3. Generar token: app "Columen", caducidad **Nunca**, permisos `whatsapp_business_management` + `whatsapp_business_messaging`
4. Pegarlo en `WHATSAPP_TOKEN` en EasyPanel y redeployar

---

# Setup viejo con Kapso (DEPRECADO - no usar)

## Arquitectura

```
Usuario ve la web → Click "WhatsApp" → Manda mensaje pre-armado
    → Kapso recibe el mensaje → Bot con botones (Juridico/Notarial)
    → Encuesta (nombre, DNI, email, consulta)
    → Function Node hace POST al Google Apps Script
    → Datos llegan a Google Sheets
```

---

## Paso 1: Crear la Google Sheet + Apps Script

### 1.1 Crear la hoja
1. Ir a [Google Sheets](https://sheets.google.com) → Hoja nueva
2. Nombrarla **"Columen - Consultas"**
3. Copiar el **ID** de la URL: `docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit`

### 1.2 Crear el webhook
1. Ir a [Google Apps Script](https://script.google.com) → Nuevo proyecto
2. Borrar el código default y pegar el contenido de `google-apps-script.js`
3. Reemplazar `TU_SPREADSHEET_ID_AQUI` con el ID copiado
4. **Implementar** → Nueva implementación:
   - Tipo: **App web**
   - Ejecutar como: **Yo**
   - Acceso: **Cualquier persona**
5. Click "Implementar" → **Copiar la URL** (la vas a necesitar en Paso 3)
6. Testear: abrir la URL en el navegador, debe mostrar `{"status":"ok","service":"Columen Bot Webhook"}`

---

## Paso 2: Configurar Kapso + WhatsApp

### 2.1 Cuenta Kapso
1. Ir a [app.kapso.ai](https://app.kapso.ai)
2. Login / Crear cuenta

### 2.2 Conectar número de WhatsApp
1. En tu proyecto, ir a **Settings** → **WhatsApp**
2. Seguir el asistente para conectar vía **WhatsApp Cloud API** (Meta Business)
   - Necesitás una cuenta de Meta Business (business.facebook.com)
   - Crear una app en developers.facebook.com
   - Agregar el producto "WhatsApp"
   - Kapso te guía para vincular el número **261 641 4595**
3. Una vez conectado, el número aparece en el dashboard

> **Nota**: Si ya tenés WhatsApp Business API configurado con otro proveedor, Kapso permite migrar el número.

---

## Paso 3: Crear el flujo del bot en Kapso

Ir a **Workflows** → **New Workflow** → Nombre: "Consulta Columen"

### Nodo 1: START (Trigger)
- Tipo: **WhatsApp Message Trigger**
- Seleccionar el número conectado (261 641 4595)

### Nodo 2: BIENVENIDA + BOTONES (Send Interactive)
- Tipo: `send_interactive`
- Config:
  - `interactive_type`: **button**
  - `body_text`:
    ```
    Hola! Bienvenido a *COLUMEN* - Estudio Legal & Notarial.

    Para orientarte mejor, selecciona el area de tu consulta:
    ```
  - Botones:
    - Boton 1: `id: "juridico"` / `title: "Juridico"`
    - Boton 2: `id: "notarial"` / `title: "Notarial"`

### Nodo 3: WAIT (Esperar respuesta del boton)
- Tipo: **Wait for Response**
- `save_response_to`: **area**
- Timeout: 300 segundos (5 min)

### Nodo 4: PEDIR NOMBRE (Send Message)
- Tipo: `send_message`
- Texto:
  ```
  Perfecto! Vamos a tomar tus datos para la consulta.

  Por favor, escribi tu *nombre completo*:
  ```

### Nodo 5: WAIT NOMBRE
- Tipo: **Wait for Response**
- `save_response_to`: **nombre**

### Nodo 6: PEDIR DNI (Send Message)
- Texto: `Ahora tu *numero de DNI*:`

### Nodo 7: WAIT DNI
- Tipo: **Wait for Response**
- `save_response_to`: **dni**

### Nodo 8: PEDIR EMAIL (Send Message)
- Texto: `Tu *email* (Gmail preferentemente):`

### Nodo 9: WAIT EMAIL
- Tipo: **Wait for Response**
- `save_response_to`: **email**

### Nodo 10: PEDIR CONSULTA (Send Message)
- Texto: `Por ultimo, *contanos brevemente tu consulta*:`

### Nodo 11: WAIT CONSULTA
- Tipo: **Wait for Response**
- `save_response_to`: **consulta**

### Nodo 12: FUNCTION - Enviar a Google Sheets
- Tipo: **Function Node**
- Crear una nueva funcion en Kapso con este codigo:

```javascript
async function handler(request, env) {
  const body = await request.json();
  const ctx = body.execution_context || {};
  const vars = ctx.vars || {};
  const phone = ctx.phone_number || '';

  const payload = {
    telefono: phone,
    area: vars.area || '',
    nombre: vars.nombre || '',
    dni: vars.dni || '',
    email: vars.email || '',
    consulta: vars.consulta || ''
  };

  const res = await fetch(env.GOOGLE_SHEETS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const result = await res.json();

  return new Response(JSON.stringify({
    vars: { sheets_ok: result.status === 'ok' }
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

- En **Secrets/Environment**, agregar:
  - `GOOGLE_SHEETS_WEBHOOK` = la URL del Apps Script del Paso 1

### Nodo 13: CONFIRMACION (Send Message)
- Texto:
  ```
  Gracias {{nombre}}! Tu consulta de tipo *{{area}}* fue registrada correctamente.

  Un profesional de COLUMEN se va a comunicar con vos a la brevedad.

  Si necesitas algo mas, escribinos!
  ```

### Conexiones del flujo
```
START → BIENVENIDA+BOTONES → WAIT AREA → PEDIR NOMBRE → WAIT NOMBRE
→ PEDIR DNI → WAIT DNI → PEDIR EMAIL → WAIT EMAIL
→ PEDIR CONSULTA → WAIT CONSULTA → FUNCTION SHEETS → CONFIRMACION
```

---

## Paso 4: Activar y testear

1. **Guardar** el workflow
2. **Activar** el workflow (toggle ON)
3. Desde otro telefono, mandar "Hola, quiero hacer una consulta" al 261 641 4595
4. Verificar que:
   - Aparecen los 2 botones (Juridico / Notarial)
   - Pide nombre, DNI, email, consulta en orden
   - Los datos aparecen en la Google Sheet

---

## Troubleshooting

- **Bot no responde**: Verificar que el workflow esta activo y el numero correcto esta seleccionado en el trigger
- **Datos no llegan a Sheets**: Abrir la URL del Apps Script en el navegador (debe dar status ok). Verificar el SPREADSHEET_ID
- **Error en Function**: En Kapso ir a Events del workflow para ver logs de ejecucion
- **Timeout en wait nodes**: El usuario tiene 5 min para responder cada pregunta. Ajustar si es necesario
