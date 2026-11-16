# The Ideas Engine — admin access (one time, ~3 minutes)

The Toolshed Admin app (Android) is a thin client over this Apps Script.
The public `Ideas` sheet is readable by anyone who has the spreadsheet
link, so the admin surface has its **own key** and never touches the
public submit path.

You need: the spreadsheet from `SETUP.md` (The Learning Toolshed — Ideas),
edit access to its Apps Script.

## 1. Pick a key

A long random string. Generate one in PowerShell:

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

## 2. Put it in the script

Store it as a **Script Property**, not in the code:

1. Open the sheet → **Extensions → Apps Script**.
2. **Project Settings** (gear) → **Script Properties** → **Add property**.
3. Name `ADMIN_KEY`, value your string. **Save script properties**.

The code reads the property first and only falls back to the
`ADMIN_KEY` constant in `Code.gs`, so a key you pasted into the file
still works — but the property is the better home. A key in source is a
key that gets pasted into a repo, and this script's file already lives
in one. Rotating then means editing a property instead of code.

## 3. Redeploy

**Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy.**

The `/exec` URL stays the same, so `IDEAS_ENDPOINT` in `site.js` does not
change and the public form keeps working.

## 4. Test it

Admin calls are **POST only** — a key in a URL is a key in history, in
proxy logs, and in the Referer header of anything that URL touches. A
plain browser visit still answers the "is it alive" check:

- `…/exec` → `{"ok":true,"service":"The Ideas Engine","api":5}`

Everything else needs a POST. In PowerShell:

```powershell
$exec = 'https://script.google.com/macros/s/AKfy…/exec'
$key  = 'YOUR_KEY'

Invoke-RestMethod -Method Post -Uri $exec -Body @{ key = 'WRONG'; action = 'ideas' }
# {ok, error} → forbidden

Invoke-RestMethod -Method Post -Uri $exec -Body @{ key = $key; action = 'state' }
# ok, admin, api, minSupportedVersionCode, manifestVersion

Invoke-RestMethod -Method Post -Uri $exec -Body @{ key = $key; action = 'ideas' }
# ok, ideas: [ … ]
```

`GET` with `action` or `key` is refused by name:
`{"ok":false,"error":"admin actions must use POST"}`. That answer is what
an app older than v1.9 gets — it's a clear failure rather than
`forbidden`, which is what makes the upgrade obvious.

## 5. Enter it in the app

Toolshed Admin → **Settings** (gear) → paste the same `/exec` URL and
the key. The app keeps them in its own storage; nothing is shared.

## What the admin API can do

Every action is a form-encoded **POST** — `key`, `action`, then fields.
The key is never in the URL.

| Action | Fields | Result |
|---|---|---|
| `state` | `key` | `{ ok, admin, api, minSupportedVersionCode }` — the app's connection test |
| `ideas` | `key` | `{ ok, ideas: [...] }` — everything, newest first |
| `changes` | `key`, `since` (epoch ms) | `{ ok, ideas: [...], serverTime }` — only rows touched since |
| `read` | `key`, `ids` (comma-separated row numbers) | `{ ok, changed }` |
| `status` | `key`, `id`, `status`, `note` (optional) | `{ ok }` |
| `reply` | `key`, `id`, `body` | `{ ok, reply }` — also appends to `Replies` |
| `replies` | `key`, `id` | `{ ok, replies: [...] }` |
| `pageviews` | `key`, `days` (optional) | `{ ok, rows: [...] }` — raw rows, grouped by path and day |
| `usage` | `key`, `days` (optional) | `{ ok, tools, resources, pages, unmapped, perDay, ... }` — already rolled up |
| `manifest` | `key` | `{ ok, manifest }` — the site's registry (`site-manifest.json`) |

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
- **Read (admin):** `POST action=pageviews` with `key`, optional `days` →

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

## Notes

- **The key travels in the POST body, over TLS, and stops there.** It is
  not a login and there is no per-user identity: anyone with the key can
  read staff names and emails from the sheet. Treat it like a house key.
- **Keep it out of URLs.** v4 accepted `GET ?key=…`, which put the key in
  browser history, proxy logs and the Referer header. v5 refuses admin
  GETs. If you are pasting a command to test the API, paste a POST.
- **Store it as a Script Property** (step 2), not in `Code.gs`. The repo
  copy of this file has `ADMIN_KEY = ''` on purpose.
- **Rotate it** when a device is lost, when someone leaves, or when the
  key has been anywhere it shouldn't: Project Settings → Script
  Properties, replace `ADMIN_KEY`, save, then update the app's Settings
  with the new one. There is no other place to change — that is the
  point of the property.
- If the key is empty, every admin call gets `forbidden`. That is the
  safe default on purpose.
- To revoke without issuing a new one: clear `ADMIN_KEY`, save. Every
  admin call gets `forbidden` until it's set again.
- The public form is unchanged: no key, no admin columns written by
  submitters (they get `Read = no`, `Status = new`).

## Deploying v5 (one time)

v5 moves admin reads from GET to POST, and the app and the backend have
to move together. **Backend first, then the app** — the other order does
not work, because v4 only accepted POST for `read`, `status` and
`reply`; every read (`state`, `ideas`, `usage`, …) was GET-only, so an
app that only POSTs gets `unknown action` from a v4 backend.

1. **Redeploy this script** (Manage deployments → edit → New version →
   Deploy). `/exec` does not change, so `site.js` and the public form
   are untouched.
2. **Install app v1.9.** Until you do, the installed v1.8 gets
   `admin actions must use POST` on every read and its inbox shows an
   error. That is the expected state for the few minutes in between,
   not a fault: the update banner comes from GitHub, not from this
   script, so v1.8 still offers v1.9 and installs it normally.

Once v1.9 is on, everything reads normally again and nothing about the
cutover needs repeating.
