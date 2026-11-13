/* ============================================================
   The Learning Toolshed — The Ideas Engine backend.
   A Google Apps Script web app: each submission lands as a row
   in the "Ideas" sheet of the spreadsheet this script is bound
   to. Deploy steps: ideas-engine/SETUP.md (site repo).
   ============================================================ */

const SHEET_NAME = 'Ideas';
const MIN_MILLISECONDS = 3000;   // faster than this is a bot, not a teacher
/* Column order: whether it's a tool or feature idea, when it arrived,
   the idea itself, who sent it, and — for feature ideas — which tool
   it is for (replaced the old "Page" column). */
const HEADER = ['Type', 'When', 'Idea', 'Name or email', 'Which tool'];

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

    /* First question: new tool or a feature for an existing one.
       Feature ideas must name their tool (the form enforces it too —
       a miss here means a broken client, so we say no). */
    const type = data.type === 'tool' ? 'Tool'
      : data.type === 'feature' ? 'Feature' : '';
    if (!type) return fail();
    const tool = type === 'Feature' ? String(data.tool || '').trim() : '';
    if (type === 'Feature' && !tool) return fail();

    const sheet = ensureSheet_();
    sheet.appendRow([
      type,
      new Date(),
      idea,
      String(data.name || '').trim(),
      tool
    ]);
    return ok();
  } catch (err) {
    return fail();
  }
}

/* Create the sheet with its header, or migrate the pre-Type layout
   (When | Idea | Name | Page) to the current five columns — old rows
   below the new header are the user's to clear. */
function ensureSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (String(sheet.getRange('A1').getValue()) !== 'Type') {
    sheet.getRange('A1:E1').setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
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
