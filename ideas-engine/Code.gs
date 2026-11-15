/* ============================================================
   The Learning Toolshed — The Ideas Engine backend.
   A Google Apps Script web app: each submission lands as a row
   in the "Ideas" sheet of the spreadsheet this script is bound
   to. Deploy steps: ideas-engine/SETUP.md (site repo).

   Two surfaces, both behind the same /exec URL:

   PUBLIC  doPost               — ideas.html posts here, no key
   ADMIN   doGet / doPost       — the Toolshed Admin app, needs
           key=<ADMIN_KEY>; see ADMIN_KEY below and
           ideas-engine/ADMIN.md.

   Admin actions (need the key):
     GET  ?key=…&action=state        -> { ok, admin: true, api }
     GET  ?key=…&action=ideas        -> { ok, ideas: [ … ] }
     GET  ?key=…&action=replies&id=  -> { ok, replies: [ … ] }
     GET  ?key=…&action=pageviews    -> { ok, rows: [ … ] }
     POST ?key=…&action=read         -> { ok }   ids: 1,2,3
     POST ?key=…&action=status       -> { ok }   id, status, note
     POST ?key=…&action=reply        -> { ok }   id, body

   Public (no key):
     POST action=track               -> { ok }   path, seconds, referrer
     — the site's anonymous usage ping; see ADMIN.md.
   ============================================================ */

const SHEET_NAME = 'Ideas';
const REPLIES_SHEET = 'Replies';
const VIEWS_SHEET = 'PageViews';
const MIN_MILLISECONDS = 3000;   // faster than this is a bot, not a teacher
const API_VERSION = 3;

/* Anonymous usage pings — one row per report.
   Columns: Path | When | Seconds | Referrer. One path on one day goes
   quiet after this many reports or this much reported time, so a
   stuck bot tab can't grow the sheet forever. */
const VIEWS_HEADER = ['Path', 'When', 'Seconds', 'Referrer'];
const VIEWS_MAX_REPORTS = 200;
const VIEWS_MAX_SECONDS = 2 * 60 * 60;
const VIEWS_KEEP_DAYS = 90;
const SECONDS_CAP = 3600;        // an idle tab isn't a reader

/* Column order: whether it's a tool or feature idea, when it arrived,
   the idea itself, who sent it, which tool it's for, then the admin
   columns (read state, status, admin note) added by v1.1. */
const HEADER = ['Type', 'When', 'Idea', 'Name or email', 'Which tool',
  'Read', 'Status', 'Note'];

/* Read/admin columns — kept together so older code paths stay readable. */
const COL = {
  type: 0, when: 1, idea: 2, name: 3, tool: 4,
  read: 5, status: 6, note: 7
};

const STATUS_VALUES = ['new', 'reading', 'planned', 'done', 'shelved'];

/* The admin shared secret. Set this to a long random string and keep it
   out of the site repo — it only ever travels between the app and this
   script. Empty = admin API refuses every call (safe default). */
const ADMIN_KEY = '';

/* One public POST door. A key means it's an admin call (the Toolshed
   Admin app); anything else is ideas.html submitting an idea. */
function doPost(e) {
  const data = (e && e.parameter) || {};
  try {
    if (data.key) return doPostAdmin_(data);
    if (data.action === 'track') return trackPageView_(data);
    return submitIdea_(data);
  } catch (err) {
    return fail();
  }
}

function submitIdea_(data) {
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
    tool,
    'no',      // Read
    'new',     // Status
    ''         // Note
  ]);
  return ok();
}

/* ---------------- Admin: read the inbox ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};

  /* A plain visit answers with this — our smoke test that the
     endpoint is live (no key, no data). */
  if (!p.action) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, service: 'The Ideas Engine', api: API_VERSION })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  if (!isAdmin_(p.key)) return deny();

  const action = p.action;
  if (action === 'state') return json_({ ok: true, admin: true, api: API_VERSION });
  if (action === 'ideas') return json_({ ok: true, ideas: listIdeas_() });
  if (action === 'replies') {
    const id = parseInt(p.id, 10);
    if (!(id >= 2)) return json_({ ok: false, error: 'bad id' });
    return json_({ ok: true, replies: listReplies_(id) });
  }
  if (action === 'pageviews') return json_({ ok: true, rows: pageViews_() });

  return json_({ ok: false, error: 'unknown action' });
}

function listIdeas_() {
  const sheet = ensureSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const rows = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const when = toDate_(r[COL.when]);
    out.push({
      id: i + 2,                                    // sheet row number
      type: String(r[COL.type] || ''),
      when: when ? when.toISOString() : String(r[COL.when] || ''),
      idea: String(r[COL.idea] || ''),
      name: String(r[COL.name] || ''),
      tool: String(r[COL.tool] || ''),
      read: String(r[COL.read] || '') === 'yes',
      status: normaliseStatus_(r[COL.status]),
      note: String(r[COL.note] || '')
    });
  }
  /* Newest first — the order the inbox shows by default. */
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : b.id - a.id));
  return out;
}

/* ---------------- Admin: mark read / set status ---------------- */

function markRead_(ids) {
  const sheet = ensureSheet_();
  const last = sheet.getLastRow();
  let changed = 0;
  ids.forEach((raw) => {
    const id = parseInt(raw, 10);
    if (!(id >= 2 && id <= last)) return;
    sheet.getRange(id, COL.read + 1).setValue('yes');
    changed++;
  });
  return changed;
}

function setStatus_(id, status, note) {
  const sheet = ensureSheet_();
  const row = parseInt(id, 10);
  if (!(row >= 2 && row <= sheet.getLastRow())) return false;
  sheet.getRange(row, COL.status + 1).setValue(normaliseStatus_(status));
  if (note !== undefined && note !== null) {
    sheet.getRange(row, COL.note + 1).setValue(String(note).slice(0, 2000));
  }
  return true;
}

/* ---------------- Replies (threaded, one row per reply) ---------------- */

/* Replies live in their own sheet so a single idea can have a
   back-and-forth without touching the Ideas sheet's shape.
   Columns: Idea ID | When | Author | Body.
   "Author" is always "Admin" for v1 — the admin is the only one
   who replies. If submitters ever reply back, the column is ready. */

const REPLIES_HEADER = ['Idea ID', 'When', 'Author', 'Body'];

function ensureRepliesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REPLIES_SHEET);
  if (!sheet) sheet = ss.insertSheet(REPLIES_SHEET);
  if (String(sheet.getRange('A1').getValue()) !== REPLIES_HEADER[0]) {
    sheet.getRange(1, 1, 1, REPLIES_HEADER.length).setValues([REPLIES_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function listReplies_(ideaId) {
  const sheet = ensureRepliesSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const rows = sheet.getRange(2, 1, last - 1, REPLIES_HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (parseInt(r[0], 10) !== ideaId) continue;
    const when = toDate_(r[1]);
    out.push({
      id: i + 2,
      ideaId: ideaId,
      when: when ? when.toISOString() : String(r[1] || ''),
      author: String(r[2] || ''),
      body: String(r[3] || '')
    });
  }
  return out;
}

function addReply_(ideaId, body) {
  const sheet = ensureRepliesSheet_();
  sheet.appendRow([ideaId, new Date(), 'Admin', String(body).slice(0, 4000)]);
  return true;
}

/* ---------------- Public: anonymous page views ---------------- */

/* site.js pings here — no key, because the payload is nothing but a
   page path and a duration. One row per report. Rate-limited per
   path per day: past VIEWS_MAX_REPORTS reports or VIEWS_MAX_SECONDS
   total seconds, the rest of that path's day is dropped with a fake
   ok — a stuck bot tab learns nothing and grows nothing. */
function trackPageView_(data) {
  const path = String(data.path || '').trim().slice(0, 300);
  if (path.charAt(0) !== '/') return ok();

  let seconds = parseInt(data.seconds, 10);
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  if (seconds > SECONDS_CAP) seconds = SECONDS_CAP;
  const referrer = String(data.referrer || '').trim().slice(0, 500);

  const sheet = ensureViewsSheet_();
  const today = dayKey_(new Date());
  const last = sheet.getLastRow();
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, VIEWS_HEADER.length).getValues();
    let reports = 0;
    let reportedSeconds = 0;
    for (let i = 0; i < rows.length; i++) {
      const when = toDate_(rows[i][1]);
      if (!when || dayKey_(when) !== today) continue;
      if (String(rows[i][0] || '') !== path) continue;
      reports++;
      reportedSeconds += Number(rows[i][2]) || 0;
      if (reports >= VIEWS_MAX_REPORTS || reportedSeconds >= VIEWS_MAX_SECONDS) {
        return ok();   // rate limited — quietly
      }
    }
  }

  sheet.appendRow([path, new Date(), seconds, referrer]);
  return ok();
}

function ensureViewsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(VIEWS_SHEET);
  if (!sheet) sheet = ss.insertSheet(VIEWS_SHEET);
  if (String(sheet.getRange('A1').getValue()) !== VIEWS_HEADER[0]) {
    sheet.getRange(1, 1, 1, VIEWS_HEADER.length).setValues([VIEWS_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* The Usage question: what happened over the last VIEWS_KEEP_DAYS,
   grouped by path and day. */
function pageViews_() {
  const sheet = ensureViewsSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const cutoff = Date.now() - VIEWS_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const rows = sheet.getRange(2, 1, last - 1, VIEWS_HEADER.length).getValues();
  const groups = {};
  for (let i = 0; i < rows.length; i++) {
    const when = toDate_(rows[i][1]);
    if (!when) continue;
    if (when.getTime() < cutoff) continue;
    const path = String(rows[i][0] || '');
    const day = dayKey_(when);
    const key = path + '\u0000' + day;
    if (!groups[key]) groups[key] = { path: path, day: day, views: 0, seconds: 0 };
    groups[key].views += 1;
    groups[key].seconds += Number(rows[i][2]) || 0;
  }

  const out = [];
  for (const key in groups) out.push(groups[key]);
  /* Newest day first, then A→Z within a day. */
  out.sort((a, b) =>
    a.day < b.day ? 1 : a.day > b.day ? -1
      : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return out;
}

function dayKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* Dates read back from the sheet don't always satisfy `instanceof
   Date` (they can arrive from another realm), which silently skipped
   every pageview row and turned idea timestamps into raw strings.
   Every read goes through here instead: accepts a real Date from any
   realm, an epoch number, or a date-ish string, and returns a clean
   JS Date — or null when the value is nothing date-like. */
function toDate_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const n = new Date(value);
    return isNaN(n.getTime()) ? null : n;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    const direct = new Date(s);
    if (!isNaN(direct.getTime())) return direct;
    /* Display form without a zone: "11/15/2026 15:34:57". */
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const local = new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));
      return isNaN(local.getTime()) ? null : local;
    }
    return null;
  }
  if (typeof value.getTime === 'function') {
    /* Date-like from another realm (or a bridged java.util.Date). */
    const t = value.getTime();
    return isNaN(t) ? null : new Date(t);
  }
  return null;
}

/* Admin posts: form-encoded (key + action + fields), same as the
   public one, so the app can use one request style for everything. */
function doPostAdmin_(data) {
  if (!isAdmin_(data.key)) return deny();

  if (data.action === 'read') {
    const ids = String(data.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return json_({ ok: false, error: 'no ids' });
    return json_({ ok: true, changed: markRead_(ids) });
  }

  if (data.action === 'status') {
    const okWrite = setStatus_(data.id, data.status, data.note);
    return json_(okWrite ? { ok: true } : { ok: false, error: 'bad id' });
  }

  if (data.action === 'reply') {
    const id = parseInt(data.id, 10);
    const body = String(data.body || '').trim();
    if (!(id >= 2) || !body) return json_({ ok: false, error: 'bad request' });
    return json_({ ok: true, reply: addReply_(id, body) });
  }

  return json_({ ok: false, error: 'unknown action' });
}

/* ---------------- Small helpers ---------------- */

function isAdmin_(key) {
  return Boolean(ADMIN_KEY) && String(key || '') === ADMIN_KEY;
}

function normaliseStatus_(value) {
  const v = String(value || '').toLowerCase();
  return STATUS_VALUES.indexOf(v) >= 0 ? v : 'new';
}

/* Create the sheet with its header, or migrate the pre-Type layout
   (When | Idea | Name | Page) to the current eight columns — old rows
   below the new header are the user's to clear. */
function ensureSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (String(sheet.getRange('A1').getValue()) !== HEADER[0]) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok() {
  return json_({ ok: true });
}

function fail() {
  return json_({ ok: false });
}

function deny() {
  return json_({ ok: false, error: 'forbidden' });
}