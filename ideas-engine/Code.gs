/* ============================================================
   The Learning Toolshed — The Ideas Engine backend.
   A Google Apps Script web app: each submission lands as a row
   in the "Ideas" sheet of the spreadsheet this script is bound
   to. Deploy steps: ideas-engine/SETUP.md (site repo).
   ============================================================ */

const SHEET_NAME = 'Ideas';
const MIN_MILLISECONDS = 3000;   // faster than this is a bot, not a teacher

function doPost(e) {
  const data = (e && e.parameter) || {};
  try {
    /* Honeypot: the hidden field people never see. Filled = bot.
       Fake success so bots don't learn and retry. */
    if (data.hp) return ok();

    const idea = String(data.idea || '').trim();
    if (!idea) return ok();

    /* Someone typed a real idea already — only a bot submits
       within three seconds of the page opening. */
    const loadedAt = parseInt(data.loadedAt, 10);
    if (loadedAt && Date.now() - loadedAt < MIN_MILLISECONDS) return ok();

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['When', 'Idea', 'Name or email', 'Page']);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date(),
      idea,
      String(data.name || '').trim(),
      String(data.page || '').trim()
    ]);
    return ok();
  } catch (err) {
    return fail();
  }
}

/* A plain visit to the deployed URL answers with this — our
   smoke test that the endpoint is live. */
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, service: 'The Ideas Engine' })
  ).setMimeType(ContentService.MimeType.JSON);
}

function ok() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail() {
  return ContentService.createTextOutput(JSON.stringify({ ok: false }))
    .setMimeType(ContentService.MimeType.JSON);
}
