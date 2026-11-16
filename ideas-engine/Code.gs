/* ============================================================
   The Learning Toolshed — The Ideas Engine backend.
   A Google Apps Script web app: each submission lands as a row
   in the "Ideas" sheet of the spreadsheet this script is bound
   to. Deploy steps: ideas-engine/SETUP.md (site repo).

    Two surfaces, both behind the same /exec URL:

    PUBLIC  doPost               — ideas.html posts here, no key
    ADMIN   doPost               — the Toolshed Admin app, signed in
             with Google: idToken=<a Google ID token>. The server
             verifies it and checks the email against an allowlist
             (see GOOGLE_AUTH below and ADMIN.md). key=<ADMIN_KEY>
             still works, for a deployment that has not moved over.

    Admin traffic is POST-only, and the credential travels in the body.
    A key in a query string is a key in browser history, in proxy logs,
    and in the Referer header of every URL it touches — so v5 refuses
    GET on admin actions outright. See doGet.

    Admin actions (POST, form-encoded: idToken or key, action, fields):
          action=state                  -> { ok, admin, api, minSupportedVersionCode }
          action=ideas                  -> { ok, ideas: [ … ] }
          action=changes   since=       -> { ok, ideas: [ … ], serverTime }
          action=replies   id=          -> { ok, replies: [ … ] }
          action=pageviews days=        -> { ok, rows: [ … ] }
          action=usage     days=        -> { ok, source, tools, resources, pages, unmapped, perDay }
          action=manifest               -> { ok, manifest }   (the site's registry)
          action=read      ids=1,2,3    -> { ok, changed }
          action=status    id, status, note -> { ok }
          action=reply     id, body     -> { ok, reply }

    Public (no credential):
      POST action=track               -> { ok }   path, seconds, referrer
      — the site's anonymous usage ping; see ADMIN.md.
      Anything else POSTed without a credential is ideas.html
      submitting an idea.
    ============================================================ */

const SHEET_NAME = 'Ideas';
const REPLIES_SHEET = 'Replies';
const VIEWS_SHEET = 'PageViews';
const ROLLUP_SHEET = 'DailyRollup';
const MIN_MILLISECONDS = 3000;   // faster than this is a bot, not a teacher
/* API level. 5 = admin traffic is POST-only (v4 was GET for reads).
   6 = admin calls may present a Google ID token instead of the key. */
const API_VERSION = 6;

/* The site's registry — every tool, page and resource page. Served to
   the admin app (action=manifest) so a new tool on the site reaches the
   app without an app release. Fetched and cached, never stored here:
   this script's copy would be a second place to keep in step. */
const MANIFEST_URL = 'https://swankymcgee.github.io/site-manifest.json';
const MANIFEST_TTL_SECONDS = 6 * 60 * 60;

/* The oldest app build that understands this API. The app compares its
   own versionCode against this on launch and says "update required"
   instead of misreading a newer shape.

   10 = v1.9, the first POST-only build. v5 refuses admin GETs, so an
   older app is not merely out of date here — it cannot read anything at
   all, and this number is how it learns that in one line instead of
   staring at an empty inbox. Lower it back to 0 once nothing older is
   in use. */
const MIN_SUPPORTED_VERSION_CODE = 10;

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
   columns (read state, status, admin note) added by v1.1, and finally
   "Updated" (v1.7) — the last time a human touched the row, which is
   what makes action=changes cheap: the app asks for rows changed since
   its last sync instead of re-reading the whole sheet. */
const HEADER = ['Type', 'When', 'Idea', 'Name or email', 'Which tool',
  'Read', 'Status', 'Note', 'Updated'];

/* Read/admin columns — kept together so older code paths stay readable. */
const COL = {
  type: 0, when: 1, idea: 2, name: 3, tool: 4,
  read: 5, status: 6, note: 7, updated: 8
};

const STATUS_VALUES = ['new', 'reading', 'planned', 'done', 'shelved'];

/* The admin shared secret, from Script Properties.

   Set it once, from the Apps Script editor:
     Project Settings → Script Properties → Add property
       ADMIN_KEY = <a long random string>

   The property wins; the constant below is only a fallback for a
   deployment that still has the key written into the file. Prefer the
   property: a key in source is a key that gets pasted into a repo, and
   this script's file already lives in one. Rotating then means editing a
   property, not code.

   Empty in both places = admin API refuses every call (safe default). */
const ADMIN_KEY = '';

function adminKey_() {
  const fromProps = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return String(fromProps || ADMIN_KEY || '').trim();
}

/* ---------------- Google sign-in (API 6) ----------------

   The point of this: nobody types or stores an admin key. The app signs
   the user in with Google, gets a short-lived ID token, and posts that
   instead. This script verifies the token against Google and then checks
   the email against an allowlist.

    Two Script Properties *can* override the constants below:

      OAUTH_CLIENT_ID  — the *Web* OAuth client's ID, from Google
        Cloud. Same string the app passes as serverClientId. A token is
        only accepted if its audience is exactly this.
        (ANDROID_OAUTH_CLIENT_ID is the old name for the same thing; it
        is still read, so an existing deployment does not break.)
      ADMIN_EMAILS     — comma-separated addresses allowed in. Spaces
        and semicolons are tolerated.

    Both have a default in this file, so a fresh deployment answers
    `google: true` with no setup at all. The properties exist for the
    cases the file cannot hold: rotating the client, or taking someone
    off the list without a redeploy. Clearing ADMIN_KEY is what finally
    shuts the old door — that part is still a property, because it is
    the one value that must never be in a repo.

    Tokens are verified by Google over HTTPS, then cached by digest for
    as long as the token is valid (minus a safety margin), so a page of
    requests from one session is one call out. */
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const TOKEN_CACHE_SAFETY_SECONDS = 120;   // re-verify this long before expiry
const TOKEN_CACHE_KEY_PREFIX = 'gauth:';

/* The web OAuth client this deployment signs in with.

   Public by design: it sits inside every APK that uses it, and Google
   treats it only as the *audience* of the token — never as a secret. The
   Script Property wins; the constant is the default, so a fresh
   deployment works without a trip to Project Settings.

   The property is read under both names. ANDROID_OAUTH_CLIENT_ID is the
   older one, kept because that is what ADMIN.md has said since v6 and
   because a deployment that already set it must not break.

   The Android client is not used here at all. Google matches that one on
   the device — against the app's package name and signing SHA-1 — before
   a token exists. Ours is registered as:

     package  com.learningtoolshed.admin
     SHA-1    8c46feb16a8bb6735592107365609dd92a84e1e1
     client   1007296555959-rhf4p4s2l3b4l97fh4bmuenap1p8t2nk…

   Getting these two the wrong way round is the one easy mistake here:
   the *web* client's ID goes in the property, and a token's `aud` is
   what it is compared against. */
const OAUTH_CLIENT_ID =
  '1007296555959-chqcshefr02pboaf1rebsnbaunmf1nbo.apps.googleusercontent.com';

/* Who may read the sheet. Not a secret either — it is a list of names —
   but it is the whole of the security, so it stays short and literal:
   no wildcards, no domains, matched case-insensitively.

   The Script Property wins, for the same reason ADMIN_KEY's does:
   removing someone is an edit to a property, not a redeploy. */
const ADMIN_EMAILS = 'tjmcclure@mpsaz.org, videogamebrain@gmail.com';

function adminClientId_() {
  const props = PropertiesService.getScriptProperties();
  const fromProps = props.getProperty('OAUTH_CLIENT_ID') ||
    props.getProperty('ANDROID_OAUTH_CLIENT_ID');
  return String(fromProps || OAUTH_CLIENT_ID || '').trim();
}

function adminEmails_() {
  const fromProps = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
  return String(fromProps || ADMIN_EMAILS || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* What the server accepts, for the app's sign-in screen: it should not
   offer Google sign-in to a backend that has not been configured for it.
   Served without a credential (action=authconfig) because the app needs
   it before it has one. */
function adminAuth_() {
  return {
    google: !!adminClientId_() && adminEmails_().length > 0,
    key: !!adminKey_(),
    clientId: adminClientId_()
  };
}

function authConfig_() {
  return json_(adminAuth_());
}

/* One public POST door. A key or an ID token means it's an admin call
   (the Toolshed Admin app); anything else is ideas.html submitting an
   idea. The token is checked first when both are present: it is the
   stronger of the two, and an app mid-migration should not be judged on
   the half it is leaving behind. */
function doPost(e) {
  const data = (e && e.parameter) || {};
  try {
    /* Public by design, and needed before sign-in: the app has to know
       which Google client to ask for, and it cannot ask for that behind
       a door it has not opened yet. A client ID is not a secret — every
       app that uses it carries it — so this answers without a credential. */
    if (data.action === 'authconfig') return authConfig_();
    if (data.idToken || data.key) return admin_(data);
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
  const stamp = new Date();
  sheet.appendRow([
    type,
    stamp,
    idea,
    String(data.name || '').trim(),
    tool,
    'no',      // Read
    'new',     // Status
    '',        // Note
    stamp      // Updated
  ]);
  return ok();
}

/* ---------------- Admin: one door, POST only ---------------- */

/* Reads moved behind POST in v5, so every admin action goes through
   here. One dispatcher means one place to check the key and one place
   to add an action — two doors (a GET path and a POST path) is how a
   key ends up in a query string by accident.

   Returns 200 + { ok: false } for everything it refuses, so a caller
   cannot tell "wrong key" from "unknown action" from "bad id" by
   status code. */
function admin_(data) {
  const identity = adminIdentity_(data);
  if (!identity.ok) return json_({ ok: false, error: identity.error });

  const action = data.action;
  if (action === 'state') {
    return json_({
      ok: true,
      admin: true,
      api: API_VERSION,
      minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE,
      auth: adminAuth_(),
      email: identity.email,
      manifestVersion: (loadManifest_() || {}).manifestVersion || 0
    });
  }
  if (action === 'ideas') return json_({ ok: true, ideas: listIdeas_() });
  if (action === 'changes') {
    const since = Number(data.since) || 0;
    return json_(changes_(since));
  }
  if (action === 'replies') {
    const id = parseInt(data.id, 10);
    if (!(id >= 2)) return json_({ ok: false, error: 'bad id' });
    return json_({ ok: true, replies: listReplies_(id) });
  }
  if (action === 'pageviews') return json_({ ok: true, rows: pageViews_(daysParam_(data.days)) });
  if (action === 'usage') return usage_(daysParam_(data.days));
  if (action === 'manifest') {
    const manifest = loadManifest_();
    /* No manifest (offline, or GitHub Pages down): say so plainly and
       let the app fall back to the registry bundled in the APK. */
    if (!manifest) return json_({ ok: false, error: 'manifest unavailable' });
    return json_({ ok: true, manifest: manifest });
  }
  if (action === 'read') {
    const ids = String(data.ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) return json_({ ok: false, error: 'no ids' });
    return json_({ ok: true, changed: markRead_(ids) });
  }
  if (action === 'status') {
    const okWrite = setStatus_(data.id, data.status, data.note);
    return json_(okWrite ? { ok: true } : { ok: false, error: 'bad id' });
  }
  if (action === 'reply') {
    const id = parseInt(data.id, 10);
    const body = String(data.body || '').trim();
    if (!(id >= 2) || !body) return json_({ ok: false, error: 'bad request' });
    return json_({ ok: true, reply: addReply_(id, body) });
  }

  return json_({ ok: false, error: 'unknown action' });
}

/* A GET answers one thing: that the service is alive. Anything else over
   GET is refused by name.

   Admin reads used to be GET in v4, which put the key in the query
   string — browser history, proxy logs, the Referer header of anything
   that URL touched. The app has been POST-only since v1.9; this is the
   other half. An old app that still GETs gets a plain answer instead of
   'forbidden', which is what makes the failure obvious during an
   upgrade. */
function doGet(e) {
  const p = (e && e.parameter) || {};

  /* A plain visit — our smoke test that the endpoint is live
     (no key, no data). */
  if (!p.action && !p.key) {
    return json_({ ok: true, service: 'The Ideas Engine', api: API_VERSION });
  }

  /* An app older than v1.9 reads `api` and `minSupportedVersionCode`
     out of this, exactly as it would out of action=state, and shows its
     own "this build is out of date" card instead of an empty inbox. So
     the refusal carries the same two fields as a successful state. */
  return json_({
    ok: false,
    error: 'admin actions must use POST',
    api: API_VERSION,
    minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE
  });
}

/* ?days=30 → 30, clamped to 1…365. Missing or nonsense means 90 —
   the length the Usage tab has always shown. */
function daysParam_(raw) {
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return 90;
  return Math.min(365, n);
}

function listIdeas_() {
  const sheet = ensureSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const rows = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(rowToIdea_(rows[i], i));
  }
  /* Newest first — the order the inbox shows by default. */
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : b.id - a.id));
  return out;
}

/* One sheet row → the idea object the app reads. Shared by the full
   read and the delta read so the two can never drift apart. */
function rowToIdea_(r, index) {
  const when = toDate_(r[COL.when]);
  const updated = toDate_(r[COL.updated]);
  return {
    id: index + 2,                                  // sheet row number
    type: String(r[COL.type] || ''),
    when: when ? when.toISOString() : String(r[COL.when] || ''),
    idea: String(r[COL.idea] || ''),
    name: String(r[COL.name] || ''),
    tool: String(r[COL.tool] || ''),
    read: String(r[COL.read] || '') === 'yes',
    status: normaliseStatus_(r[COL.status]),
    note: String(r[COL.note] || ''),
    /* Blank for rows written before v1.7 — the app treats those as
       "unknown" rather than "changed a moment ago". */
    updated: updated ? updated.toISOString() : ''
  };
}

/* The delta read. `since` is epoch milliseconds from the app's last
   successful sync; 0 means "everything" (a first sync, or a cache
   cleared).

   A row counts as changed when:
     - its Updated column is newer than `since`, or
     - it has no Updated column at all and it arrived after `since`
       (rows from before v1.7 keep working: they're picked up by their
       own timestamp once, then never again).
   A row someone edits by hand in the sheet is invisible here — the
   Updated cell only moves when the app writes. That's the trade for
   not re-reading the whole sheet on every launch. */
function changes_(sinceMs) {
  const sheet = ensureSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, ideas: [], serverTime: Date.now() };

  const rows = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const updated = toDate_(r[COL.updated]);
    let changed;
    if (!sinceMs) {
      changed = true;
    } else if (updated) {
      changed = updated.getTime() > sinceMs;
    } else {
      const when = toDate_(r[COL.when]);
      changed = Boolean(when) && when.getTime() > sinceMs;
    }
    if (!changed) continue;
    out.push(rowToIdea_(r, i));
  }
  out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : b.id - a.id));
  return { ok: true, ideas: out, serverTime: Date.now() };
}

/* ---------------- Admin: mark read / set status ---------------- */

function markRead_(ids) {
  const sheet = ensureSheet_();
  const last = sheet.getLastRow();
  const stamp = new Date();
  let changed = 0;
  ids.forEach((raw) => {
    const id = parseInt(raw, 10);
    if (!(id >= 2 && id <= last)) return;
    sheet.getRange(id, COL.read + 1).setValue('yes');
    /* Stamped so action=changes can see the edit — the app keeps its
       own copy of "read" and needs to hear about it from another
       device. */
    sheet.getRange(id, COL.updated + 1).setValue(stamp);
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
  sheet.getRange(row, COL.updated + 1).setValue(new Date());
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

/* Day | Path | Views | Seconds — one row per page per day, written by
   the nightly trigger (installDailyRollup_). Reading 90 of these is
   cheap; reading 90 days of PageViews isn't, once the site is busy. */
const ROLLUP_HEADER = ['Day', 'Path', 'Views', 'Seconds'];

function ensureRollupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ROLLUP_SHEET);
  if (!sheet) sheet = ss.insertSheet(ROLLUP_SHEET);
  if (String(sheet.getRange('A1').getValue()) !== ROLLUP_HEADER[0]) {
    sheet.getRange(1, 1, 1, ROLLUP_HEADER.length).setValues([ROLLUP_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* "/index.html" and "/" are the same page; "/math-playground" and
   "/math-playground/" are the same page. Both collapse to the
   slash-free form (except the site root, which stays "/"), which is
   the form the manifest uses. Must stay in step with
   canonicalPath() in the app (SiteRegistry.kt). */
function canonicalPath_(raw) {
  let p = String(raw || '').trim();
  if (p.indexOf('http://') === 0 || p.indexOf('https://') === 0) {
    p = '/' + p.split('://')[1].split('/').slice(1).join('/');
  }
  if (p.length > 11 && p.slice(-11) === '/index.html') {
    p = p.slice(0, -10);
  }
  if (p.length > 1 && p.charAt(p.length - 1) === '/') {
    p = p.slice(0, -1);
  }
  return p || '/';
}

/* The Usage question: what happened over the last `days` days, grouped
   by path and day. This is the raw feed — small enough to read, big
   enough to be slow once the site is busy. Prefer action=usage, which
   returns the same thing already rolled up per tool and page. */
function pageViews_(days) {
  const sheet = ensureViewsSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const span = days || VIEWS_KEEP_DAYS;
  const cutoff = Date.now() - span * 24 * 60 * 60 * 1000;
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

/* ---------------- The site manifest ---------------- */

/* The site's registry (site-manifest.json): the tools, their pages and
   the resource pages. It's the one place a new tool is declared, and
   both the site and the app read it — so a new tool reaches the app
   without an app release.

   Fetched over the network and kept in CacheService for
   MANIFEST_TTL_SECONDS. A failed fetch returns null and callers fall
   back to what they already have; nothing here is allowed to take the
   admin API down with it. */
function loadManifest_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('manifest');
  if (cached) {
    try { return JSON.parse(cached); } catch (err) { /* fall through */ }
  }
  try {
    const res = UrlFetchApp.fetch(MANIFEST_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const data = JSON.parse(res.getContentText());
    if (!data || !Array.isArray(data.tools) || !Array.isArray(data.pages)) return null;
    /* CacheService holds 100KB per key — the manifest is a few KB, but
       guard anyway so a runaway file can't start throwing. */
    const text = JSON.stringify(data);
    if (text.length < 90 * 1024) cache.put('manifest', text, MANIFEST_TTL_SECONDS);
    return data;
  } catch (err) {
    return null;
  }
}

/* ---------------- Usage, rolled up ---------------- */

/* Everything the Usage tab draws, in one small answer.

   Rows come from the DailyRollup sheet when it has them (a nightly
   trigger writes one row per path per day, so this stays fast no
   matter how many visits the site gets); otherwise it falls back to
   aggregating PageViews live, which is correct but slower.

   Paths are mapped to tools through the manifest. A path the manifest
   doesn't know lands in `unmapped` rather than vanishing — that list
   is the to-do: each row is a page waiting for a manifest entry. */
function usage_(days) {
  const span = days || 90;
  const manifest = loadManifest_();
  /* No manifest means no tool or page names to group by. Saying so
     lets the app fall back to raw rows plus the registry bundled in
     the APK, which is a better answer than everything landing in
     "unmapped". */
  if (!manifest) return json_({ ok: false, error: 'manifest unavailable' });
  const pages = manifest.pages;
  const tools = manifest.tools;

  const rows = rollupRows_(span);
  const source = rows.fromRollup ? 'rollup' : 'live';

  /* Canonicalise the path the same way the app does, so "/quick-start.html"
     and "/quick-start" are one page. */
  const byPath = {};
  rows.rows.forEach((r) => {
    const path = canonicalPath_(r.path);
    if (!byPath[path]) byPath[path] = { path: path, views: 0, seconds: 0, days: {} };
    byPath[path].views += Number(r.views) || 0;
    byPath[path].seconds += Number(r.seconds) || 0;
    if (r.day) byPath[path].days[r.day] = (byPath[path].days[r.day] || 0) + (Number(r.views) || 0);
  });

  const pageFor = (path) => pages.filter((p) => canonicalPath_(p.path) === path)[0] || null;
  const toolFor = (toolId) => tools.filter((t) => t.id === toolId)[0] || null;

  /* Per tool: every page that names it. */
  const toolRows = tools.map((tool) => {
    let views = 0;
    let seconds = 0;
    Object.keys(byPath).forEach((path) => {
      const page = pageFor(path);
      if (page && page.tool === tool.id) {
        views += byPath[path].views;
        seconds += byPath[path].seconds;
      }
    });
    return { id: tool.id, name: tool.name, views: views, seconds: seconds };
  });

  /* Per resource page, including the ones nobody has opened — a zero
     is information ("this guide is not being used"), not noise. */
  const resourceRows = [];
  pages.forEach((page) => {
    if (page.kind !== 'resource') return;
    const hit = byPath[canonicalPath_(page.path)];
    const tool = toolFor(page.tool);
    resourceRows.push({
      id: page.path,
      tool: page.tool,
      toolName: tool ? tool.name : page.tool,
      title: page.title,
      path: page.path,
      views: hit ? hit.views : 0,
      seconds: hit ? hit.seconds : 0
    });
  });
  resourceRows.sort((a, b) => b.views - a.views);

  /* Every page we know about, most-used first — the "what's actually
     being used" list. */
  const pageRows = [];
  Object.keys(byPath).forEach((path) => {
    const page = pageFor(path);
    pageRows.push({
      path: path,
      title: page ? page.title : path,
      tool: page ? page.tool : '',
      kind: page ? page.kind : 'unknown',
      views: byPath[path].views,
      seconds: byPath[path].seconds
    });
  });
  pageRows.sort((a, b) => b.views - a.views);

  /* Paths the manifest doesn't know. Anything here is a page to add. */
  const unmapped = pageRows
    .filter((p) => !p.tool && p.kind === 'unknown' && p.path !== '/')
    .map((p) => ({ path: p.path, views: p.views, seconds: p.seconds }))
    .sort((a, b) => b.views - a.views);

  /* Daily series, oldest first, `span` days including today. */
  const perDayMap = {};
  rows.rows.forEach((r) => {
    if (!r.day) return;
    perDayMap[r.day] = (perDayMap[r.day] || 0) + (Number(r.views) || 0);
  });
  const perDay = [];
  const today = new Date();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKey_(d);
    perDay.push({ day: key, views: perDayMap[key] || 0 });
  }

  /* `dayList` rather than `days`: `days` is this function's parameter,
     and a const of the same name in the same scope is a SyntaxError —
     the whole script refuses to load, not just this function. */
  const dayList = Object.keys(byPath).length
    ? rows.rows.map((r) => r.day).filter(Boolean).sort()
    : [];

  return json_({
    ok: true,
    days: span,
    source: source,
    manifestVersion: manifest.manifestVersion || 0,
    totalViews: pageRows.reduce((sum, p) => sum + p.views, 0),
    totalSeconds: pageRows.reduce((sum, p) => sum + p.seconds, 0),
    tools: toolRows,
    resources: resourceRows,
    pages: pageRows.slice(0, 30),
    unmapped: unmapped,
    perDay: perDay,
    firstDay: dayList.length ? dayList[0] : '',
    lastDay: dayList.length ? dayList[dayList.length - 1] : ''
  });
}

/* Rows for the last `days` days.

   The nightly job can only fold *finished* days, so the rollup sheet
   never has today in it. Reading the sheet alone would therefore miss
   every visit made today — worse than useless, because it would look
   like a quiet day. So: the sheet for everything up to yesterday, and
   today read live (one day of rows, which is cheap).

   Falls back to aggregating PageViews live for the whole window when
   the sheet has nothing in it at all — right after installing the
   trigger, or if a night's run failed. */
function rollupRows_(days) {
  const sheet = ensureRollupSheet_();
  const today = dayKey_(new Date());
  const cutoff = dayKey_(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
  const last = sheet.getLastRow();

  const out = [];
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, ROLLUP_HEADER.length).getValues();
    for (let i = 0; i < rows.length; i++) {
      const day = String(rows[i][0] || '');
      if (!day || day < cutoff || day >= today) continue;
      out.push({
        day: day,
        path: String(rows[i][1] || ''),
        views: Number(rows[i][2]) || 0,
        seconds: Number(rows[i][3]) || 0
      });
    }
  }

  const fromRollup = out.length > 0;

  /* Today, live. */
  pageViews_(1).forEach((r) => {
    if (r.day !== today) return;
    out.push({ day: r.day, path: r.path, views: r.views, seconds: r.seconds });
  });

  if (fromRollup) return { rows: out, fromRollup: true };

  /* No rollup yet: do the whole window live. Correct, just slower. */
  const live = pageViews_(days).map((r) => ({
    day: r.day,
    path: r.path,
    views: r.views,
    seconds: r.seconds
  }));
  return { rows: live, fromRollup: false };
}

/* The nightly job: fold yesterday's PageViews into one row per path
   per day, then drop anything older than the retention window. Install
   once from the editor (run installDailyRollup_ once) — after that it
   re-arms itself. */
function rollupNightly_() {
  const sheet = ensureViewsSheet_();
  const rollup = ensureRollupSheet_();
  const last = sheet.getLastRow();

  const today = dayKey_(new Date());
  const written = {};

  /* Which (day, path) pairs the rollup already has — so re-running the
     job can't double-count. */
  const rollupLast = rollup.getLastRow();
  if (rollupLast >= 2) {
    const have = rollup.getRange(2, 1, rollupLast - 1, ROLLUP_HEADER.length).getValues();
    for (let i = 0; i < have.length; i++) {
      written[String(have[i][0]) + '\u0000' + String(have[i][1])] = true;
    }
  }

  const groups = {};
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, VIEWS_HEADER.length).getValues();
    for (let i = 0; i < rows.length; i++) {
      const when = toDate_(rows[i][1]);
      if (!when) continue;
      const day = dayKey_(when);
      if (day >= today) continue;          // today is still being written
      const path = String(rows[i][0] || '');
      const key = day + '\u0000' + path;
      if (written[key]) continue;
      if (!groups[key]) groups[key] = { day: day, path: path, views: 0, seconds: 0 };
      groups[key].views += 1;
      groups[key].seconds += Number(rows[i][2]) || 0;
    }
  }

  const out = Object.keys(groups).map((k) => groups[k]);
  if (out.length) {
    rollup.getRange(rollupLast + 1, 1, out.length, ROLLUP_HEADER.length)
      .setValues(out.map((g) => [g.day, g.path, g.views, g.seconds]));
  }

  /* Keep two windows' worth; older rows are dead weight. */
  const keepFrom = dayKey_(new Date(Date.now() - (VIEWS_KEEP_DAYS * 2) * 24 * 60 * 60 * 1000));
  const all = rollup.getLastRow();
  if (all >= 2) {
    const values = rollup.getRange(2, 1, all - 1, ROLLUP_HEADER.length).getValues();
    const kept = values.filter((r) => String(r[0] || '') >= keepFrom);
    rollup.getRange(2, 1, all - 1, ROLLUP_HEADER.length).clearContent();
    if (kept.length) {
      rollup.getRange(2, 1, kept.length, ROLLUP_HEADER.length).setValues(kept);
    }
  }
  return out.length;
}

function installDailyRollup_() {
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'rollupNightly_') {
      /* Move it to 2am rather than adding a second one. */
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('rollupNightly_')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  return 'installed';
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

/* ---------------- Small helpers ---------------- */

/* Compared without early exit. It makes no practical difference against
   a network — an attacker cannot time an Apps Script call that precisely
   — but a secret check that returns as soon as two characters differ is
   a bad habit to leave in a file about secrets. */
function isAdmin_(key) {
  const expected = adminKey_();
  if (!expected) return false;
  const given = String(key || '');
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

/* Which credential came in, and whether it holds. The answer is
   deliberately small: an ok flag, the email when there is one, and a
   reason string that says why not. The app shows that reason verbatim,
   because "token expired" and "not allowed" are different instructions
   to the person holding the phone, and one word for both ("forbidden")
   is the thing this replaced. */
function adminIdentity_(data) {
  const token = String(data.idToken || '');
  if (token) return verifyIdToken_(token);
  if (data.key) {
    return isAdmin_(data.key)
      ? { ok: true, email: '' }
      : { ok: false, error: 'forbidden' };
  }
  return { ok: false, error: 'no credential' };
}

/* Google's tokeninfo endpoint is the whole verifier: it checks the
   signature for us and hands back the claims. What it does not do is
   check that the token was minted for *this* backend, so `aud` is
   compared here — an ID token for any other Google client would
   otherwise be a valid-looking credential. */
function verifyIdToken_(token) {
  const clientId = adminClientId_();
  if (!clientId) return { ok: false, error: 'google sign-in not configured' };
  if (!adminEmails_().length) return { ok: false, error: 'google sign-in not configured' };

  /* One call per token, not per request. The cache key is a digest of
     the token, so a token is never stored in the cache in a form that
     could be read back out of it. */
  const cacheKey = TOKEN_CACHE_KEY_PREFIX + tokenDigest_(token);
  const cached = CacheService.getScriptCache().get(cacheKey);
  if (cached) return { ok: true, email: cached };

  let claims;
  try {
    const response = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL, {
      method: 'post',
      payload: { id_token: token },
      muteHttpExceptions: true
    });
    /* A 400 here is Google saying the token is malformed, expired or
       signed by the wrong key — not a reason to fail the whole call. */
    claims = JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, error: 'token check failed' };
  }
  if (!claims || claims.error) {
    const description = String(claims && claims.error_description || '');
    return { ok: false, error: /expired/i.test(description) ? 'token expired' : 'bad token' };
  }
  if (String(claims.aud || '') !== clientId) return { ok: false, error: 'bad token' };
  if (GOOGLE_ISSUERS.indexOf(String(claims.iss || '')) < 0) return { ok: false, error: 'bad token' };
  if (String(claims.email_verified) !== 'true') return { ok: false, error: 'bad token' };
  if (Number(claims.exp || 0) * 1000 <= Date.now()) return { ok: false, error: 'token expired' };

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'bad token' };
  if (!isAllowedEmail_(email)) return { ok: false, error: 'not allowed' };

  const remaining = Math.floor(Number(claims.exp) || 0) - Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(3000, remaining - TOKEN_CACHE_SAFETY_SECONDS));
  CacheService.getScriptCache().put(cacheKey, email, ttl);

  return { ok: true, email: email };
}

function isAllowedEmail_(email) {
  return adminEmails_().indexOf(email) >= 0;
}

function tokenDigest_(token) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    token,
    Utilities.Charset.UTF_8
  );
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = (bytes[i] + 256) % 256;
    hex += (byte < 16 ? '0' : '') + byte.toString(16);
  }
  return hex;
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

  const first = String(sheet.getRange('A1').getValue());
  if (first !== HEADER[0]) {
    /* Whole header missing (or a pre-v1.1 layout) — write it. */
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  /* Header exists but is short: an older deployment predating a
     column. Append only the missing names, never overwrite a column
     that already holds data. */
  const have = sheet.getLastColumn();
  if (have < HEADER.length) {
    const add = HEADER.slice(have);
    sheet.getRange(1, have + 1, 1, add.length).setValues([add]);
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