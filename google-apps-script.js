/**
 * Google Apps Script - Webhook para Columen Bot
 *
 * INSTRUCCIONES:
 * 1. Ir a https://script.google.com → Nuevo proyecto
 * 2. Pegar este código
 * 3. En la línea SPREADSHEET_ID, poner el ID de tu Google Sheet
 *    (el ID está en la URL: docs.google.com/spreadsheets/d/ESTE_ES_EL_ID/edit)
 * 4. Ir a Implementar → Nueva implementación → App web
 *    - Ejecutar como: Yo
 *    - Acceso: Cualquier persona
 * 5. Copiar la URL generada y usarla en Kapso como webhook
 */

const SPREADSHEET_ID = '1oeotRasRgGGx4L0gOCBolm8qE-1xnVVvr5WnBpY2Egk';
const SHEET_NAME = 'Consultas';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(SHEET_NAME);

    // Crear hoja y headers si no existe
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Fecha', 'Hora', 'Telefono', 'Area', 'Nombre', 'DNI', 'Email', 'Consulta']);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    }

    const now = new Date();
    const fecha = Utilities.formatDate(now, 'America/Argentina/Mendoza', 'dd/MM/yyyy');
    const hora = Utilities.formatDate(now, 'America/Argentina/Mendoza', 'HH:mm:ss');

    sheet.appendRow([
      fecha,
      hora,
      data.telefono || '',
      data.area || '',
      data.nombre || '',
      data.dni || '',
      data.email || '',
      data.consulta || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// GET para testear que el webhook está activo
function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', service: 'Columen Bot Webhook' }))
    .setMimeType(ContentService.MimeType.JSON);
}
