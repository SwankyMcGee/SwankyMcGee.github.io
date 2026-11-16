/* ============================================================
   The Learning Toolshed — The Ideas Engine.

   One Apps Script web app, three surfaces behind one /exec URL:

     PUBLIC  POST action=track      anonymous usage pings from site.js
     PUBLIC  POST anything else     ideas.html submitting an idea
     ADMIN   POST action=<name>     the Toolshed Admin app

   Admin calls are POST-only and carry a Google ID token. The server
   verifies it with Google, checks the address against an allowlist of
   SHA-256 digests, and answers. There is no key to type, copy, store or
   rotate — which is the whole point of v6.

     state  ideas  changes  replies  pageviews  usage
     manifest  read  status  reply

   A GET answers one thing — that the service is alive — and refuses
   admin actions by name. Setup: ideas-engine/SETUP.md, then ADMIN.md.
   ============================================================ */

/* API level. 5 = admin reads are POST-only. 6 = Google sign-in. */
const API_VERSION = 6;

/* Oldest app build that can authenticate at all: v1.13 is the first to
   speak Google. An older build has no way in, so it is told to update
   rather than shown an empty inbox. */
const MIN_SUPPORTED_VERSION_CODE = 13;

const SHEET = 'Ideas';
const REPLIES_SHEET = 'Replies';
const VIEWS_SHEET = 'PageViews';
const ROLLUP_SHEET = 'DailyRollup';

/* Column names, and the numbers to reach them by. */
const HEADER = ['Type', 'When', 'Idea', 'Name or email', 'Which tool',
  'Read', 'Status', 'Note', 'Updated'];
const REPLIES_HEADER = ['Idea ID', 'When', 'Author', 'Body'];
const VIEWS_HEADER = ['Path', 'When', 'Seconds', 'Referrer'];
const ROLLUP_HEADER = ['Day', 'Path', 'Views', 'Seconds'];

const COL = {
  type: 0, when: 1, idea: 2, name: 3, tool: 4,
  read: 5, status: 6, note: 7, updated: 8
};

const STATUS_VALUES = ['new', 'reading', 'planned', 'done', 'shelved'];

const MIN_MILLISECONDS = 3000;   // faster than this is a bot, not a teacher

/* Anonymous usage pings: one row per report. One path on one day goes
   quiet after this many reports or this much reported time, so a stuck
   browser tab cannot grow the sheet forever. */
const VIEWS_MAX_REPORTS = 200;
const VIEWS_MAX_SECONDS = 2 * 60 * 60;
const VIEWS_KEEP_DAYS = 90;
const SECONDS_CAP = 3600;        // an idle tab isn't a reader

/* The site's registry: every tool, page and resource page. Fetched and
   cached, never stored here — this script's copy would be a second
   place to keep in step. */
const MANIFEST_URL = 'https://swankymcgee.github.io/site-manifest.json';
const MANIFEST_TTL_SECONDS = 6 * 60 * 60;

/* ---------------- Google sign-in ---------------- */

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const TOKEN_CACHE_SAFETY_SECONDS = 120;   // re-verify this long before expiry
const TOKEN_CACHE_KEY_PREFIX = 'gauth:';

/* The *Web* OAuth client. Public by design — it is inside every APK
   that uses it, and Google treats it only as the audience of the token,
   never as a secret. The Script Property wins, so a client can be
   rotated without a redeploy; ANDROID_OAUTH_CLIENT_ID is the old name
   for the same value and is still read.

   The Android client is not used here at all. Google matches that one
   on the device, against the app's package name and signing SHA-1,
   before any token exists. Ours is registered as
   com.learningtoolshed.admin / 8c46feb16a8bb6735592107365609dd92a84e1e1.

   These two are the one easy mistake: the *web* client's ID goes in
   the property, because that is what a token's `aud` is compared to. */
const OAUTH_CLIENT_ID =
  '1007296555959-chqcshefr02pboaf1rebsnbaunmf1nbo.apps.googleusercontent.com';

/* Who may read the sheet, as SHA-256 digests. The addresses are not in
   this file because this file is in a public repo. A token still
   arrives with the address in the clear — Google put it there — so the
   check is: hash what the token claims and compare.

   To add someone, run this in the editor and paste the digest:

       hashEmail_('someone@school.org')

   To remove someone, delete their line. Either way it is a new version
   of the script, not a new deployment: /exec does not change.

   The ADMIN_EMAILS property (plain, comma-separated addresses) overrides
   the digests, for changing the list with no code edit at all. */
const ADMIN_EMAIL_HASHES =
  '0db3b42b2df501b85ef463a8dfcf1b03944508459f6fd11e92468bfc154eeacd, ' +
  '55601d7d73ad704c65e398ca942b28198b0c03f8d91584d88dba9288a67e7fda';

function props_() {
  return PropertiesService.getScriptProperties();
}

function adminClientId_() {
  const from = props_().getProperty('OAUTH_CLIENT_ID') ||
    props_().getProperty('ANDROID_OAUTH_CLIENT_ID');
  return String(from || OAUTH_CLIENT_ID || '').trim();
}

/* A property is a comma-, semicolon- or space-separated list, in any
   case. Lower-cased here so every comparison below is exact. */
function list_(property, fallback) {
  return String(props_().getProperty(property) || fallback || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function adminEmails_() {
  return list_('ADMIN_EMAILS', '');
}

function adminEmailHashes_() {
  return list_('ADMIN_EMAIL_HASHES', ADMIN_EMAIL_HASHES);
}

/* SHA-256 as lower-case hex. Used for the allowlist, for cache keys and
   for the token digest, so there is one hasher in the file. */
function hash_(text) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  ).map((b) => (b + 256).toString(16).slice(-2)).join('');
}

function emailDigest_(email) {
  return hash_(String(email || '').trim().toLowerCase());
}

/* Run this once in the editor to get the digest to paste into
   ADMIN_EMAIL_HASHES. */
function hashEmail_(email) {
  return emailDigest_(email);
}

/* The whole of the security, in one place: a token proves who is
   asking, this decides whether that person may read staff names and
   emails out of the sheet. Plaintext property first, digests second. */
function isAllowedEmail_(email) {
  const candidate = String(email || '').trim().toLowerCase();
  if (!candidate) return false;
  const plain = adminEmails_();
  if (plain.length) return plain.indexOf(candidate) >= 0;
  return adminEmailHashes_().indexOf(emailDigest_(candidate)) >= 0;
}

function adminConfigured_() {
  return !!adminClientId_() &&
    adminEmails_().length + adminEmailHashes_().length > 0;
}

/* What the server will accept. Public, because the app has to ask before
   it has anything to offer — see doPost. */
function adminAuth_() {
  return { google: adminConfigured_(), clientId: adminClientId_() };
}

/* Google's tokeninfo endpoint is the whole verifier: it checks the
   signature and hands back the claims. What it does not do is check
   that the token was minted for *this* backend, so `aud` is compared
   here — an ID token for any other Google client would otherwise be a
   valid-looking credential. */
function verifyIdToken_(token) {
  if (!adminConfigured_()) {
    return { ok: false, error: 'google sign-in not configured' };
  }

  /* One call to Google per token, not per request. The cache key is a
     digest, so a token is never stored in a form that can be read back
     out of the cache. */
  const cache = CacheService.getScriptCache();
  const cacheKey = TOKEN_CACHE_KEY_PREFIX + hash_(token);
  const cached = cache.get(cacheKey);
  if (cached) return { ok: true, email: cached };

  let claims;
  try {
    const response = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL, {
      method: 'post',
      payload: { id_token: token },
      muteHttpExceptions: true
    });
    claims = JSON.parse(response.getContentText());
  } catch (err) {
    return { ok: false, error: 'token check failed' };
  }

  /* A 400 here is Google saying the token is malformed, expired, or
     signed by the wrong key — not a reason to fail the whole call. */
  if (!claims || claims.error) {
    const why = String((claims && claims.error_description) || '');
    return { ok: false, error: /expired/i.test(why) ? 'token expired' : 'bad token' };
  }
  if (String(claims.aud || '') !== adminClientId_()) return { ok: false, error: 'bad token' };
  if (GOOGLE_ISSUERS.indexOf(String(claims.iss || '')) < 0) {
    return { ok: false, error: 'bad token' };
  }
  if (String(claims.email_verified) !== 'true') return { ok: false, error: 'bad token' };
  if (Number(claims.exp || 0) * 1000 <= Date.now()) {
    return { ok: false, error: 'token expired' };
  }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'bad token' };
  if (!isAllowedEmail_(email)) return { ok: false, error: 'not allowed' };

  /* Cached only until just before the token dies, so the cache can
     never outlive the thing it vouches for. */
  const remaining = Math.floor(Number(claims.exp) || 0) - Math.floor(Date.now() / 1000);
  cache.put(cacheKey, email, Math.max(60, Math.min(3000, remaining - TOKEN_CACHE_SAFETY_SECONDS)));

  return { ok: true, email: email };
}

/* Manual check, run from the editor: can this script reach Google at
   all? Sign-in fails with "token check failed" when the answer is no,
   and the reason is in the log — either the script has never been
   granted the external-request scope, or the deployment runs as the
    person visiting instead of as the owner.

    Delete this once the deployment is answering. */
function checkTokenInfo() {
  try {
    const response = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL, { muteHttpExceptions: true });
    Logger.log('reached Google: status=' + response.getResponseCode());
    Logger.log('body=' + response.getContentText());
  } catch (err) {
    Logger.log('could not reach Google: ' + err);
  }
}

/* ---------------- Routes ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};

  /* A plain visit: our smoke test that the endpoint is alive. */
  if (!p.action && !p.key && !p.idToken) {
    return json_({ ok: true, service: 'The Ideas Engine', api: API_VERSION });
  }

  /* Admin reads were GET in v4, which put the credential in the query
     string — history, proxy logs, the Referer header of anything the
     URL touched. This carries `api` and `minSupportedVersionCode` for
     the same reason action=state does: an old build reads them here and
     says "update" instead of showing an empty inbox. */
  return json_({
    ok: false,
    error: 'admin actions must use POST',
    api: API_VERSION,
    minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE
  });
}

function doPost(e) {
  const data = (e && e.parameter) || {};
  try {
    /* Public, and needed before sign-in: the app has to know which
       Google client to ask for, and it cannot ask for that behind a
       door it has not opened yet. A client ID is not a secret. */
    if (data.action === 'authconfig') return json_(adminAuth_());

    /* The token is checked before the key is even considered: it is the
       stronger of the two, and an app mid-migration should not be
       judged on the half it is leaving behind. */
    if (data.idToken) return admin_(data);

    /* A key is refused out loud rather than ignored. An app old enough
       to send one would otherwise fall through to the public form and
       get a cheerful {ok:true} for a read that never happened. */
    if (data.key) {
      return json_({
        ok: false,
        error: 'key sign-in was removed; update the app',
        api: API_VERSION,
        minSupportedVersionCode: MIN_SUPPORTED_VERSION_CODE
      });
    }

    if (data.action === 'track') return trackPageView_(data);
    return submitIdea_(data);
  } catch (err) {
    return fail();
  }
}

/* ---------------- Public: ideas.html ---------------- */

function submitIdea_(data) {
  /* Honeypot: the hidden field people never see. Filled = bot, so fake
     success and don't teach it anything. */
  if (data.hp) return ok();

  const idea = String(data.idea || '').trim();
  if (!idea) return ok();

  /* Someone typed a real idea already — only a bot submits within
     three seconds of the page opening. */
  const loadedAt = parseInt(data.loadedAt, 10);
  if (loadedAt && Date.now() - loadedAt < MIN_MILLISECONDS) return ok();

  /* New tool, or a feature for an existing one. A feature must name
     its tool (the form enforces it too; a miss here is a broken
     client, so we say no). */
  const type = data.type === 'tool' ? 'Tool'
    : data.type === 'feature' ? 'Feature' : '';
  if (!type) return fail();
  const tool = type === 'Feature' ? String(data.tool || '').trim() : '';
  if (type === 'Feature' && !tool) return fail();

  const sheet = sheet_(SHEET, HEADER);
  const stamp = new Date();
  sheet.appendRow([
    type, stamp, idea, String(data.name || '').trim(), tool,
    'no',   // Read
    'new',  // Status
    '',     // Note
    stamp   // Updated
  ]);
  return ok();
}

/* ---------------- Admin: one door, POST only ---------------- */

/* One dispatcher: one place the credential is checked, one place to add
   an action. Two doors (a GET path and a POST path) is how a credential
   ends up in a query string by accident.

   Everything it refuses is 200 + { ok: false }, so a caller cannot tell
   "bad token" from "unknown action" from "bad id" by status code. */
function admin_(data) {
  const identity = verifyIdToken_(String(data.idToken || ''));
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
  if (action === 'changes') return json_(changes_(Number(data.since) || 0));

  if (action === 'replies') {
    const id = parseInt(data.id, 10);
    if (!(id >= 2)) return json_({ ok: false, error: 'bad id' });
    return json_({ ok: true, replies: listReplies_(id) });
  }
  if (action === 'pageviews') {
    return json_({ ok: true, rows: pageViews_(daysParam_(data.days)) });
  }
  if (action === 'usage') return usage_(daysParam_(data.days));

  if (action === 'manifest') {
    const manifest = loadManifest_();
    /* No manifest (offline, or GitHub Pages down): say so plainly and
       let the app fall back to the registry bundled in the APK. */
    return manifest
      ? json_({ ok: true, manifest: manifest })
      : json_({ ok: false, error: 'manifest unavailable' });
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
    return json_(setStatus_(data.id, data.status, data.note)
      ? { ok: true }
      : { ok: false, error: 'bad id' });
  }
  if (action === 'reply') {
    const id = parseInt(data.id, 10);
    const body = String(data.body || '').trim();
    if (!(id >= 2) || !body) return json_({ ok: false, error: 'bad request' });
    return json_({ ok: true, reply: addReply_(id, body) });
  }

  return json_({ ok: false, error: 'unknown action' });
}

/* ?days=30 -> 30, clamped to 1..365. Missing or nonsense means 90 —
   the length the Usage tab has always shown. */
function daysParam_(raw) {
  const n = parseInt(raw, 10);
  return !isFinite(n) || n <= 0 ? 90 : Math.min(365, n);
}

/* ---------------- The sheet ---------------- */

/* Every sheet in one place: fetched, created if missing, and given its
   header if the header is absent or older than the columns we write.
   Appending only the missing names is what lets an existing sheet gain
   a column without losing anything underneath it. */
function sheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  if (String(sheet.getRange('A1').getValue()) !== header[0]) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const have = sheet.getLastColumn();
  if (have < header.length) {
    sheet.getRange(1, have + 1, 1, header.length - have)
      .setValues([header.slice(have)]);
  }
  return sheet;
}

function newestFirst_(a, b) {
  /* ISO-8601 sorts as text, so this is chronological without parsing. */
  return a.when < b.when ? 1 : a.when > b.when ? -1 : b.id - a.id;
}

function listIdeas_() {
  const sheet = sheet_(SHEET, HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const values = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) out.push(rowToIdea_(values[i], i));
  /* Newest first — the order the inbox shows by default. */
  return out.sort(newestFirst_);
}

/* One sheet row -> the idea object the app reads. Shared by the full
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
    /* Blank for rows written before v1.7: the app treats those as
       "unknown" rather than "changed a moment ago". */
    updated: updated ? updated.toISOString() : ''
  };
}

/* The delta read. `since` is epoch milliseconds from the app's last
   successful sync; 0 means "everything".

   A row counts as changed when its Updated cell is newer than `since`,
   or — for rows written before v1.7, which have no Updated cell — when
   it arrived after `since`. A row someone edits by hand in the sheet is
   invisible here: Updated only moves when the app writes. That is the
   trade for not re-reading the whole sheet on every launch. */
function changes_(since) {
  const sheet = sheet_(SHEET, HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, ideas: [], serverTime: Date.now() };

  const values = sheet.getRange(2, 1, last - 1, HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const updated = toDate_(r[COL.updated]);
    let changed;
    if (!since) {
      changed = true;
    } else if (updated) {
      changed = updated.getTime() > since;
    } else {
      const when = toDate_(r[COL.when]);
      changed = Boolean(when) && when.getTime() > since;
    }
    if (changed) out.push(rowToIdea_(r, i));
  }
  return { ok: true, ideas: out.sort(newestFirst_), serverTime: Date.now() };
}

function normaliseStatus_(value) {
  const v = String(value || '').toLowerCase();
  return STATUS_VALUES.indexOf(v) >= 0 ? v : 'new';
}

function markRead_(ids) {
  const sheet = sheet_(SHEET, HEADER);
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
  const sheet = sheet_(SHEET, HEADER);
  const row = parseInt(id, 10);
  if (!(row >= 2 && row <= sheet.getLastRow())) return false;
  sheet.getRange(row, COL.status + 1).setValue(normaliseStatus_(status));
  if (note !== undefined && note !== null) {
    sheet.getRange(row, COL.note + 1).setValue(String(note).slice(0, 2000));
  }
  sheet.getRange(row, COL.updated + 1).setValue(new Date());
  return true;
}

/* ---------------- Replies ---------------- */

/* Replies live in their own sheet so a thread never changes the shape of
   Ideas. "Author" is always "Admin" for now; the column is there for
   the day submitters can reply back. */
function listReplies_(ideaId) {
  const sheet = sheet_(REPLIES_SHEET, REPLIES_HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const values = sheet.getRange(2, 1, last - 1, REPLIES_HEADER.length).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
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

/* Appends the reply and hands back the row as it was stored, so the app
   can show it at once instead of waiting for the next sync. */
function addReply_(ideaId, body) {
  const sheet = sheet_(REPLIES_SHEET, REPLIES_HEADER);
  const text = String(body).slice(0, 4000);
  const stamp = new Date();
  sheet.appendRow([ideaId, stamp, 'Admin', text]);
  return {
    id: sheet.getLastRow(),
    ideaId: ideaId,
    when: stamp.toISOString(),
    author: 'Admin',
    body: text
  };
}

/* ---------------- Public: anonymous page views ---------------- */

/* site.js pings here — no credential, because the payload is nothing
   but a page path and a duration. */
function trackPageView_(data) {
  const path = String(data.path || '').trim().slice(0, 300);
  if (path.charAt(0) !== '/') return ok();

  let seconds = parseInt(data.seconds, 10);
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.min(seconds, SECONDS_CAP);
  const referrer = String(data.referrer || '').trim().slice(0, 500);

  const sheet = sheet_(VIEWS_SHEET, VIEWS_HEADER);
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
      /* Past the limit, drop the rest of that path's day quietly: a
         stuck tab learns nothing and grows nothing. */
      if (reports >= VIEWS_MAX_REPORTS || reportedSeconds >= VIEWS_MAX_SECONDS) return ok();
    }
  }

  sheet.appendRow([path, new Date(), seconds, referrer]);
  return ok();
}

/* The raw feed: the last `days` days, grouped by path and day. Small
   enough to read, slow once the site is busy — prefer action=usage,
   which returns the same thing already rolled up. */
function pageViews_(days) {
  const sheet = sheet_(VIEWS_SHEET, VIEWS_HEADER);
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const cutoff = Date.now() - (days || VIEWS_KEEP_DAYS) * 24 * 60 * 60 * 1000;
  const rows = sheet.getRange(2, 1, last - 1, VIEWS_HEADER.length).getValues();
  const groups = {};
  for (let i = 0; i < rows.length; i++) {
    const when = toDate_(rows[i][1]);
    if (!when || when.getTime() < cutoff) continue;
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
  return out.sort((a, b) =>
    a.day < b.day ? 1 : a.day > b.day ? -1
      : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function dayKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* "/index.html" and "/" are the same page; "/math-playground" and
   "/math-playground/" are the same page. Both collapse to the
   slash-free form (except the site root, which stays "/") — the form
   the manifest uses. Must stay in step with canonicalPath() in the app
   (SiteRegistry.kt). */
function canonicalPath_(raw) {
  let p = String(raw || '').trim();
  if (p.indexOf('http://') === 0 || p.indexOf('https://') === 0) {
    p = '/' + p.split('://')[1].split('/').slice(1).join('/');
  }
  if (p.length > 11 && p.slice(-11) === '/index.html') p = p.slice(0, -10);
  if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
  return p || '/';
}

/* ---------------- Usage, rolled up ---------------- */

/* Day | Path | Views | Seconds — one row per page per day, written by
   the nightly trigger. Reading 90 of these is cheap; reading 90 days of
   PageViews is not, once the site is busy. */
function rollupRows_(days) {
  const sheet = sheet_(ROLLUP_SHEET, ROLLUP_HEADER);
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

  /* Today, read live: the nightly job can only fold *finished* days, so
     the sheet never has today in it. Reading the sheet alone would miss
     every visit made today — worse than useless, because it would look
     like a quiet day. */
  pageViews_(1).forEach((r) => {
    if (r.day === today) {
      out.push({ day: r.day, path: r.path, views: r.views, seconds: r.seconds });
    }
  });

  if (fromRollup) return { rows: out, fromRollup: true };

  /* No rollup yet (just installed, or a night's run failed): do the
     whole window live. Correct, just slower. */
  const live = pageViews_(days).map((r) => ({
    day: r.day, path: r.path, views: r.views, seconds: r.seconds
  }));
  return { rows: live, fromRollup: false };
}

/* Everything the Usage tab draws, in one small answer. Paths are mapped
   to tools through the manifest. A path the manifest doesn't know lands
   in `unmapped` rather than vanishing — that list is the to-do: each
   row is a page waiting for a manifest entry. */
function usage_(days) {
  const span = days || 90;
  const manifest = loadManifest_();
  /* No manifest means no tool or page names to group by. Saying so lets
     the app fall back to raw rows plus the registry bundled in the APK,
     which is a better answer than everything landing in "unmapped". */
  if (!manifest) return json_({ ok: false, error: 'manifest unavailable' });

  const pages = manifest.pages;
  const tools = manifest.tools;
  const rows = rollupRows_(span);

  /* Canonicalise the path the same way the app does, so
     "/quick-start.html" and "/quick-start" are one page. */
  const byPath = {};
  rows.rows.forEach((r) => {
    const path = canonicalPath_(r.path);
    if (!byPath[path]) byPath[path] = { path: path, views: 0, seconds: 0 };
    byPath[path].views += Number(r.views) || 0;
    byPath[path].seconds += Number(r.seconds) || 0;
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

  /* Per resource page, including the ones nobody has opened — a zero is
     information ("this guide is not being used"), not noise. */
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

  /* Every page we know about, most-used first. */
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

  const unmapped = pageRows
    .filter((p) => !p.tool && p.kind === 'unknown' && p.path !== '/')
    .map((p) => ({ path: p.path, views: p.views, seconds: p.seconds }));

  /* Daily series, oldest first, `span` days including today. */
  const perDayMap = {};
  rows.rows.forEach((r) => {
    if (r.day) perDayMap[r.day] = (perDayMap[r.day] || 0) + (Number(r.views) || 0);
  });
  const perDay = [];
  const today = new Date();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = dayKey_(d);
    perDay.push({ day: key, views: perDayMap[key] || 0 });
  }

  /* `dayList`, not `days`: `days` is this function's parameter, and a
     const of the same name in the same scope is a SyntaxError — the
     whole script refuses to load, not just this function. */
  const dayList = rows.rows.map((r) => r.day).filter(Boolean).sort();

  return json_({
    ok: true,
    days: span,
    source: rows.fromRollup ? 'rollup' : 'live',
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

/* The nightly job: fold yesterday's PageViews into one row per path per
   day, then drop anything older than the retention window. Install once
   from the editor (run installDailyRollup_ once); after that it re-arms
   itself. */
function rollupNightly_() {
  const sheet = sheet_(VIEWS_SHEET, VIEWS_HEADER);
  const rollup = sheet_(ROLLUP_SHEET, ROLLUP_HEADER);
  const last = sheet.getLastRow();

  const today = dayKey_(new Date());
  const written = {};

  /* Which (day, path) pairs the rollup already has, so re-running the
     job cannot double-count. */
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
      if (day >= today) continue;             // today is still being written
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
  const keepFrom = dayKey_(new Date(Date.now() - VIEWS_KEEP_DAYS * 2 * 24 * 60 * 60 * 1000));
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

/* ---------------- The site manifest ---------------- */

/* Fetched over the network and kept in CacheService for
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
    const response = UrlFetchApp.fetch(MANIFEST_URL, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) return null;
    const data = JSON.parse(response.getContentText());
    if (!data || !Array.isArray(data.tools) || !Array.isArray(data.pages)) return null;
    /* CacheService holds 100KB per key; the manifest is a few KB, but
       guard anyway so a runaway file cannot start throwing. */
    const text = JSON.stringify(data);
    if (text.length < 90 * 1024) cache.put('manifest', text, MANIFEST_TTL_SECONDS);
    return data;
  } catch (err) {
    return null;
  }
}

/* ---------------- Helpers ---------------- */

/* Dates read back from the sheet do not always satisfy `instanceof Date`
   (they can arrive from another realm), which silently skipped every
   pageview row and turned idea timestamps into raw strings. Accepts a
   Date from any realm, an epoch number, or a date-ish string. */
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
  const t = typeof value.getTime === 'function' ? value.getTime() : NaN;
  return isNaN(t) ? null : new Date(t);
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