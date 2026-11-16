# The Ideas Engine — admin access (one time, ~5 minutes)

The Toolshed Admin app (Android) is a thin client over this Apps Script.
The public `Ideas` sheet is readable by anyone who has the spreadsheet
link, so the admin surface has its own way in and never touches the
public submit path.

That way in is **Google sign-in**. The app signs you in with Google and
posts the ID token; the server verifies it with Google and checks the
address against an allowlist. There is no key to type, copy, store or
rotate, and nothing permanent is kept on the phone.

You need: the spreadsheet from `SETUP.md` (The Learning Toolshed —
Ideas), edit access to its Apps Script, and a Google Cloud project.

## 1. Create the two OAuth clients

In [console.cloud.google.com](https://console.cloud.google.com), pick (or
create) a project, then set up the **OAuth consent screen** and create
credentials. The consent screen must exist first; for this app an
*External* one with your own address added as a **test user** is enough.

**a) Web application client.** Credentials → **OAuth client ID → Web
application**. No redirect URIs are needed. Copy the **Client ID** (it
ends in `.apps.googleusercontent.com`). This is the string the app passes
as `serverClientId`, and the audience every ID token is minted for.

**b) Android client.** Credentials → **OAuth client ID → Android**.
Package name `com.learningtoolshed.admin`, and the SHA-1 of the signing
certificate:

```powershell
& "C:\Android\Sdk\build-tools\35.0.0\apksigner.bat" verify --print-certs `
  "C:\Users\Tanner\Desktop\Toolshed App\app-release-signed.apk"
```

Right now that is `8c46feb16a8bb6735592107365609dd92a84e1e1`. The
Android client is how Google recognises the app on the device; the token
it produces is still addressed to the **web** client, which is what makes
the check below possible.

## 2. Put the values in the script (optional)

`Code.gs` already carries the web client ID and a hashed allowlist as
constants, so a fresh deployment answers `google: true` with no setup at
all. Script Properties override them, for the two things a file cannot
do: change the client without a redeploy, and change the list with no
code edit.

**Project Settings** (gear) → **Script Properties** → **Add property**:

| Property | Overrides | Why you would |
|---|---|---|
| `OAUTH_CLIENT_ID` | the web client ID in `Code.gs` | rotating the client |
| `ADMIN_EMAIL_HASHES` | the digest list in `Code.gs` | moving the allowlist out of source |
| `ADMIN_EMAILS` | the digest list | changing the list in a hurry, in plain text |

`ANDROID_OAUTH_CLIENT_ID` is the old name for `OAUTH_CLIENT_ID`; it is
still read, so a deployment that already set it does not break. The new
name wins when both are present.

Nothing secret belongs in `Code.gs`: the file is in a public repo. The
client ID is public information (it is inside every APK), and the
allowlist is hashed, so neither is a risk in source. `ADMIN_EMAILS` is
the break-glass path — plain addresses, but only ever in Script
Properties.

### The allowlist is a list of digests

The addresses are not in `Code.gs`. A token still arrives with the
address in the clear — Google put it there — but the file only holds
SHA-256 digests of the addresses that are allowed. A reader of the repo
learns nothing from it: no staff addresses, no personal Gmail.

To **add** someone, run this once in the Apps Script editor and paste the
digest it prints into `ADMIN_EMAIL_HASHES`:

```js
hashEmail_('someone@school.org')
```

To **remove** someone, delete their digest. Either way it is an edit to
a constant and a new version of the script; `/exec` does not change and
nothing on the site or in the app has to be touched.

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
Invoke-RestMethod -Method Post -Uri $exec -Body @{ action = 'authconfig' }
# {google:true, clientId:'…'}

# a real Google token, from the app (or from OAuth Playground with the
# web client as the audience)
Invoke-RestMethod -Method Post -Uri $exec -Body @{ idToken = $token; action = 'state' }
# ok, admin, api, minSupportedVersionCode, auth, email, manifestVersion
```

The failure reasons are deliberate and distinct, because they mean
different things to the person holding the phone:

| Response | What it means |
|---|---|
| `bad token` | malformed, wrong audience, wrong issuer, or unverified email |
| `token expired` | the ID token has passed its `exp`; sign in again |
| `not allowed` | valid token, but the address is not on the allowlist |
| `google sign-in not configured` | no client ID, or no allowlist, on the server |
| `token check failed` | Google could not be reached |
| `key sign-in was removed; update the app` | a build older than 1.13 tried to authenticate |

`GET` with `action`, `key` or `idToken` is refused by name:
`{"ok":false,"error":"admin actions must use POST"}`. That answer is what
an app older than v1.9 gets — a clear failure rather than a silent one,
which is what makes the upgrade obvious.

## 5. Sign in from the app

Toolshed Admin → **Settings** (gear) → **Sign in with Google**. Pick the
address that is on the allowlist. The `/exec` URL is already built in.

## What the admin API can do

Every action is a form-encoded **POST** — `idToken`, `action`, then
fields. The credential is never in the URL.

| Action | Fields | Result |
|---|---|---|
| `state` | `idToken` | `{ ok, admin, api, minSupportedVersionCode, auth, email }` — the connection test |
| `ideas` | `idToken` | `{ ok, ideas: [...] }` — everything, newest first |
| `changes` | `idToken`, `since` (epoch ms) | `{ ok, ideas: [...], serverTime }` — only rows touched since |
| `read` | `idToken`, `ids` (comma-separated row numbers) | `{ ok, changed }` |
| `status` | `idToken`, `id`, `status`, `note` (optional) | `{ ok }` |
| `reply` | `idToken`, `id`, `body` | `{ ok, reply: {...} }` — also appends to `Replies` |
| `replies` | `idToken`, `id` | `{ ok, replies: [...] }` |
| `pageviews` | `idToken`, `days` (optional) | `{ ok, rows: [...] }` — raw rows, grouped by path and day |
| `usage` | `idToken`, `days` (optional) | `{ ok, tools, resources, pages, unmapped, perDay, ... }` — already rolled up |
| `manifest` | `idToken` | `{ ok, manifest }` — the site's registry (`site-manifest.json`) |

`state` also returns `auth: { google, clientId }` — what this deployment
will accept — so the app can offer Google sign-in only where it works.

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
app's "Ideas per tool" chart, its page titles and its tool list all come
from it. A new tool reaches every device on the next sync.

**`action=changes&since=`** returns only rows touched since the app's
last sync, so the background sync stops re-reading the whole sheet.
Rows edited by hand in the sheet don't move the `Updated` cell — the app
only hears about changes the app itself wrote. A full `ideas` read still
exists and is what a fresh install uses.

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
- **Write (public, no credential):** `POST action=track` with `path`,
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

The sheet has nine columns:
`Type | When | Idea | Name or email | Which tool | Read | Status | Note | Updated`.
The header rewrites itself on the next write if it finds an older one,
and appends only the columns that are missing, so an existing sheet gains
`Updated` without losing anything. **Old data below the header does not
migrate** — rows written before the admin columns existed stay where they
are and keep working (their `Read`/`Status`/`Note`/`Updated` cells simply
read as blank, which the API treats as unread / new).

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
- **Rotate the client ID** by making a new web client and putting its ID
  in `OAUTH_CLIENT_ID` (or the property). The app fetches the ID from
  the server at launch, so no app release is needed — tokens minted for
  the old audience stop verifying at once.
- **Keep credentials out of URLs.** v4 accepted `GET ?key=…`; v5 refused
  admin GETs, and v6 does the same for `idToken`.
- **The public form is unchanged:** no credential, no admin columns
  written by submitters (they get `Read = no`, `Status = new`).

## Deploying v6

1. **Redeploy this script** (step 3). `/exec` does not change, so
   `site.js` and the public form are untouched. The Script Properties are
   optional — the file carries the client ID and the allowlist.
2. **Install Toolshed Admin 1.13 or newer.** It is the first build that
   signs in with Google. Anything older has no way to authenticate and
   is told so.

`MIN_SUPPORTED_VERSION_CODE` is 13: builds below that cannot sign in at
all, so they are pointed at the releases page rather than shown an empty
inbox.