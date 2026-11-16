# The Ideas Engine — admin access (one time, ~5 minutes)

The Toolshed Admin app (Android) is a thin client over this Apps Script.
The public `Ideas` sheet is readable by anyone who has the spreadsheet
link, so the admin surface has its own way in and never touches the
public submit path.

As of API 6 that way in is **Google sign-in**: the app signs you in with
Google, and the server checks the token and your email address. You do
not type a key and nothing is stored on the phone. A key still works, for
a deployment that has not moved over yet — see *The key, as a fallback*
at the end.

You need: the spreadsheet from `SETUP.md` (The Learning Toolshed —
Ideas), edit access to its Apps Script, and a Google Cloud project.

## 1. Create the two OAuth clients

In [console.cloud.google.com](https://console.cloud.google.com), pick (or
create) a project, then **APIs & Services → OAuth consent screen →
Credentials**. The consent screen must be configured first; for this app
an *External* consent screen with your own address added as a **test
user** is enough.

**a) Web application client.** Create credentials → **OAuth client ID →
Web application**. No redirect URIs are needed. Copy the **Client ID**
(it ends in `.apps.googleusercontent.com`). This is the string the script
calls `ANDROID_OAUTH_CLIENT_ID`, and the same string the app passes as
`serverClientId`.

**b) Android client.** Create credentials → **OAuth client ID →
Android**. Package name `com.learningtoolshed.admin`, and the SHA-1 of
the signing certificate:

```powershell
& "C:\Android\Sdk\build-tools\35.0.0\apksigner.bat" verify --print-certs `
  "C:\Users\Tanner\Desktop\Toolshed App\app-release-signed.apk"
```

Right now that is `8c46feb16a8bb6735592107365609dd92a84e1e1`. The
Android client is what Google uses to recognise the app; the ID token it
produces is still addressed to the **web** client, which is what makes
the check below possible.

## 2. Put both in the script (optional)

`Code.gs` already carries the client ID and the allowlist as constants,
so a fresh deployment answers `google: true` with no setup at all. The
Script Properties exist for the two things a file cannot hold:

**Project Settings** (gear) → **Script Properties** → **Add property**:

| Property | Overrides | Why you would |
|---|---|---|
| `OAUTH_CLIENT_ID` | the web client ID in `Code.gs` | rotating the client without a redeploy |
| `ADMIN_EMAILS` | the hashed allowlist in `Code.gs` | changing the list without a redeploy, in a hurry |
| `ADMIN_KEY` | — | keeping the old door open, then closing it |

`ANDROID_OAUTH_CLIENT_ID` is the old name for `OAUTH_CLIENT_ID`; it is
still read, so a deployment that already set it does not break. The new
name wins when both are present.

The one value that must **not** be written into `Code.gs` is
`ADMIN_KEY`. That file lives in a public repo, so the key stays a
property. The client ID is public information and the allowlist is
hashed (below), so neither is a risk in source.

### The allowlist is a list of digests

The addresses are not in `Code.gs`, because `Code.gs` is in a public
repo. A token still arrives with the address in the clear — Google put
it there — but the file only ever holds SHA-256 digests of the addresses
that are allowed. A reader of the repo learns nothing from it: no staff
addresses, no personal Gmail, nothing to phish.

To **add** someone, run this once in the Apps Script editor and paste
the digest it prints into `ADMIN_EMAIL_HASHES`:

```js
hashEmail_('someone@school.org')
```

To **remove** someone, delete their digest. Either way it is an edit to
a constant and a new version of the script; the `/exec` URL does not
change and nothing on the site or in the app has to be touched.

To **change it without editing code**, set the `ADMIN_EMAILS` Script
Property to a comma-separated list of addresses. It wins over the
digests — that is the break-glass path, and the addresses still stay out
of the repo. (Clear the property to go back to the digests.)

Both forms are matched case-insensitively and exactly: no wildcards, no
domains. A trailing space or a different case is fine; a different
address is not.

## 3. Redeploy

**Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy.**

The `/exec` URL stays the same, so `IDEAS_ENDPOINT` in `site.js` does not
change and the public form keeps working.

The first Google-signed request asks for one extra authorisation —
`UrlFetchApp`, used to verify tokens with Google. Approve it and nothing
else will ask.

## 4. Test it

Admin calls are **POST only** — a credential in a URL is a credential in
history, in proxy logs, and in the Referer header of anything that URL
touches. A plain browser visit still answers the "is it alive" check:

- `…/exec` → `{"ok":true,"service":"The Ideas Engine","api":6}`

Everything else needs a POST:

```powershell
$exec = 'https://script.google.com/macros/s/AKfy…/exec'

# what the server will accept
Invoke-RestMethod -Method Post -Uri $exec -Body @{ action = 'state' }
# {ok:false, error:'no credential'}

# a key still works, if one is configured
Invoke-RestMethod -Method Post -Uri $exec -Body @{ key = 'WRONG'; action = 'ideas' }
# {ok:false, error:'forbidden'}

# a real Google token, from the app (or from OAuth Playground with the
# web client as the audience)
Invoke-RestMethod -Method Post -Uri $exec -Body @{ idToken = $token; action = 'state' }
# ok, admin, api, minSupportedVersionCode, auth, email, manifestVersion
```

The failure reasons are deliberate and distinct, because they mean
different things to the person holding the phone:

| Response | What it means |
|---|---|
| `forbidden` | wrong or missing key |
| `no credential` | neither `idToken` nor `key` was sent |
| `bad token` | malformed, wrong audience, wrong issuer, or unverified email |
| `token expired` | the ID token has passed its `exp`; sign in again |
| `not allowed` | valid token, but the email is not in the allowlist |
| `google sign-in not configured` | no client ID, or no allowlist, on the server |
| `token check failed` | Google could not be reached |

`GET` with `action` or `key` is refused by name:
`{"ok":false,"error":"admin actions must use POST"}`. That answer is what
an app older than v1.9 gets — it's a clear failure rather than
`forbidden`, which is what makes the upgrade obvious.

## 5. Sign in from the app

Toolshed Admin → **Settings** (gear) → **Sign in with Google**. Pick the
address that is on the allowlist. The `/exec` URL is already built in;
there is no key field to fill in and no key stored on the device.

## What the admin API can do

Every action is a form-encoded **POST** — `idToken` (or `key`),
`action`, then fields. The credential is never in the URL.

| Action | Fields | Result |
|---|---|---|
| `state` | `idToken`/`key` | `{ ok, admin, api, minSupportedVersionCode, auth, email }` — the connection test |
| `ideas` | `idToken`/`key` | `{ ok, ideas: [...] }` — everything, newest first |
| `changes` | `idToken`/`key`, `since` (epoch ms) | `{ ok, ideas: [...], serverTime }` — only rows touched since |
| `read` | `idToken`/`key`, `ids` (comma-separated row numbers) | `{ ok, changed }` |
| `status` | `idToken`/`key`, `id`, `status`, `note` (optional) | `{ ok }` |
| `reply` | `idToken`/`key`, `id`, `body` | `{ ok, reply }` — also appends to `Replies` |
| `replies` | `idToken`/`key`, `id` | `{ ok, replies: [...] }` |
| `pageviews` | `idToken`/`key`, `days` (optional) | `{ ok, rows: [...] }` — raw rows, grouped by path and day |
| `usage` | `idToken`/`key`, `days` (optional) | `{ ok, tools, resources, pages, unmapped, perDay, ... }` — already rolled up |
| `manifest` | `idToken`/`key` | `{ ok, manifest }` — the site's registry (`site-manifest.json`) |

`state` also returns `auth: { google, key }` — what this deployment will
accept — so the app can offer Google sign-in only where it works.

Idea shape:

```json
{ "id": 12, "type": "Feature", "when": "2026-11-15T09:04:11.000Z",
  "idea": "…", "name": "…", "tool": "Math Playground",
  "read": false, "status": "new", "note": "", "updated": "2026-11-15T09:04:11.000Z" }
```

`status` is one of `new | reading | planned | done | shelved`; anything
else is stored as `new`. `updated` is blank for rows written before
v1.7.

## Growing without an app release

Three things keep the app from needing a new build every time the site
grows:

**`action=manifest`** serves `site-manifest.json` from the site, cached
for six hours. It's the one place a tool or a page is declared; the
app's "Ideas per tool" chart, its page titles and its tool list all
come from it. A new tool reaches every device on the next sync.

**`action=changes&since=`** returns only rows touched since the app's
last sync, so the background sync stops re-reading the whole sheet.
Rows edited by hand in the sheet don't move the `Updated` cell — the
app only hears about changes the app itself wrote. A full `ideas` read
still exists and is what a fresh install uses.

**`action=usage`** rolls the page views up per tool and per page before
sending them, so the answer stays a few hundred bytes no matter how
many visits the site gets. A path the manifest doesn't know comes back
in `unmapped` rather than being dropped — that list is the to-do: each
row is a page to add to the manifest.

## The nightly rollup

`action=usage` prefers the `DailyRollup` sheet (one row per path per
day) and only falls back to aggregating `PageViews` live if that sheet
has nothing for today. Install the trigger **once**, from the Apps
Script editor:

1. Select `installDailyRollup_` in the function dropdown.
2. Press **Run**. Authorise it when asked.
3. It runs daily at 02:00, folds yesterday's views into one row per
   path, and drops rollup rows older than twice the retention window.

Re-running the install replaces the old trigger rather than adding a
second one.

## Page views (anonymous usage)

`site.js` sends one **usage ping** per visit: which page, how long it
was open, and the referring page. No cookies, no logins, nothing that
identifies a person.

- **Sheet:** a `PageViews` tab with `Path | When | Seconds | Referrer`
  (created automatically the first time a ping arrives).
- **Write (public, no key):** `POST action=track` with `path`,
  `seconds`, `referrer` — one row per ping.
- **Rate limit (bot trap):** one path on one day stops being recorded
  after **200 pings** or **2 hours** of reported time; the rest are
  dropped with a fake `ok`, exactly like the form's honeypot.
- **Read (admin):** `POST action=pageviews` with `idToken`, optional
  `days` →

```json
{ "ok": true, "rows": [
  { "path": "/tools.html", "day": "2026-11-15", "views": 12, "seconds": 431 },
  { "path": "/user-guide.html", "day": "2026-11-15", "views": 3, "seconds": 87 }
] }
```

  Only the **last 90 days**, grouped by path and day (`views` = pings
  that day, `seconds` = their total), newest day first.
- **What `seconds` means:** the visit's *elapsed* time when that ping
  fired — one ping at ~30 seconds of visible time, another when the
  tab hides, another when the page closes (never above 3600). One
  visit therefore leaves several rows, and pings after the first
  repeat time an earlier ping already counted: a visit's true length
  is its **largest** ping, while `views` counts pings, not people.

## New columns

The sheet now has nine columns:
`Type | When | Idea | Name or email | Which tool | Read | Status | Note | Updated`.
The header rewrites itself on the next submission if it finds an older
one, and appends only the columns that are missing, so an existing
sheet gains `Updated` without losing anything. **Old data below the
header does not migrate** — rows written before the admin columns
existed stay where they are and keep working (their
`Read`/`Status`/`Note`/`Updated` cells simply read as blank, which the
API treats as unread / new).

## The key, as a fallback

If `ADMIN_KEY` is a Script Property it is accepted exactly as before, so
a v1.9–v1.12 build keeps working and a deployment can move over at its
own pace. Generate one with:

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

and store it under `ADMIN_KEY` in **Project Settings → Script
Properties**. The `ADMIN_KEY` constant in `Code.gs` is `''` on purpose —
this file lives in a repo.

## Notes

- **Nobody types a secret.** The app holds a Google session and a
  short-lived ID token; the server verifies each one against Google and
  caches the answer by token digest, so a page of requests is one call
  out. The cache entry dies with the token.
- **The allowlist is the whole of the security.** A Google token proves
  who signed in; the allowlist is what decides whether that person may
  read staff names and emails. It is a list of SHA-256 digests, so the
  repo never carries the addresses themselves — keep it short and keep
  it accurate.
- **A lost phone is fixed in the sheet, not in the app.** Remove that
  person's digest from `ADMIN_EMAIL_HASHES` (or their address from the
  `ADMIN_EMAILS` property), save, redeploy. Their next request gets
  `not allowed`. Google sign-out on the device is not enough on its own
  — the allowlist is.
- **Rotate the client ID** only by making a new web client, putting its
  ID in the property and in a new app build. Tokens minted for the old
  audience stop verifying at once.
- **Keep credentials out of URLs.** v4 accepted `GET ?key=…`; v5
  refuses admin GETs, and v6 does the same for `idToken`.
- **The public form is unchanged:** no credential, no admin columns
  written by submitters (they get `Read = no`, `Status = new`).

## Deploying v6 (one time)

v6 adds Google sign-in. The backend can go first on its own — a v5
backend receiving an `idToken` sees no `key`, treats the call as a public
form submission and answers `{"ok":true}`, which looks like a silent
success; an app older than v1.9 is refused by name.

1. **Redeploy this script** (step 3). `/exec` does not change, so
   `site.js` and the public form are untouched. Add the Script
   Properties only if you want to override the defaults in the file
   (step 2); the key still works until you blank it.
2. **Install the app build that speaks v6.** Until then the installed
   build keeps using the key, which is why `ADMIN_KEY` should stay set
   for now.
3. **Only once every device has moved:** clear `ADMIN_KEY`, save. Any
   remaining old build then gets `forbidden` — which is the correct
   answer, and the reason to do it last.

`MIN_SUPPORTED_VERSION_CODE` is unchanged at 10: v6 is additive, so
nothing that worked before stops working.