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

1. Open the sheet → **Extensions → Apps Script**.
2. In `Code.gs`, find `const ADMIN_KEY = '';` and paste your string
   between the quotes. **Ctrl+S**.
3. If you paste a new `Code.gs` from this repo later, re-add the key —
   it is deliberately not committed anywhere.

## 3. Redeploy

**Deploy → Manage deployments → ✏ (edit) → Version: New version → Deploy.**

The `/exec` URL stays the same, so `IDEAS_ENDPOINT` in `site.js` does not
change and the public form keeps working.

## 4. Test in a browser

- `…/exec` → `{"ok":true,"service":"The Ideas Engine","api":3}`
- `…/exec?key=WRONG&action=ideas` → `{"ok":false,"error":"forbidden"}`
- `…/exec?key=YOUR_KEY&action=state` → `{"ok":true,"admin":true,"api":3}`
- `…/exec?key=YOUR_KEY&action=ideas` → `{"ok":true,"ideas":[…]}`
- `…/exec?key=YOUR_KEY&action=pageviews` → `{"ok":true,"rows":[…]}`

## 5. Enter it in the app

Toolshed Admin → **Settings** (gear) → paste the same `/exec` URL and
the key. The app keeps them in its own storage; nothing is shared.

## What the admin API can do

| Action | Method | Fields | Result |
|---|---|---|---|
| `state` | GET | `key` | `{ ok, admin, api }` — the app's connection test |
| `ideas` | GET | `key` | `{ ok, ideas: [...] }` — newest first |
| `read` | POST | `key`, `ids` (comma-separated row numbers) | `{ ok, changed }` |
| `status` | POST | `key`, `id`, `status`, `note` (optional) | `{ ok }` |
| `pageviews` | GET | `key` | `{ ok, rows: [...] }` — last 90 days, grouped by path and day |

Idea shape:

```json
{ "id": 12, "type": "Feature", "when": "2026-11-15T09:04:11.000Z",
  "idea": "…", "name": "…", "tool": "Math Playground",
  "read": false, "status": "new", "note": "" }
```

`status` is one of `new | reading | planned | done | shelved`; anything
else is stored as `new`.

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
- **Read (admin):** `GET ?key=YOUR_KEY&action=pageviews` →

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

The sheet now has eight columns:
`Type | When | Idea | Name or email | Which tool | Read | Status | Note`.
The header rewrites itself on the next submission if it finds an older
one. **Old data below the header does not migrate** — rows written before
the admin columns existed stay where they are and keep working (their
`Read`/`Status`/`Note` cells simply read as blank, which the API treats
as unread / new).

## Notes

- The key travels in the URL, so it lands in Apps Script logs. That is
  acceptable for a single-teacher inbox; it is **not** a login. Anyone
  with the key can read staff names and emails from the sheet — treat it
  like a house key.
- If the key is empty, every admin call gets `forbidden`. That is the
  safe default on purpose.
- To revoke: clear `ADMIN_KEY`, save, redeploy as a new version.
- The public form is unchanged: no key, no admin columns written by
  submitters (they get `Read = no`, `Status = new`).