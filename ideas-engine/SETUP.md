# The Ideas Engine — backend setup (one time, ~5 minutes)

The site's `ideas.html` posts each idea to a **Google Apps Script web app**
that appends a row to a **Google Sheet** — the same data readability as the
old Google Form (a sheet you can sort, filter, and read), but the form
itself lives on our site in our theming.

You need: a Google account (school or personal) that should *own* the data.
The script runs as **you**; nothing else needs an account.

## 1. Create the spreadsheet

1. Go to <https://sheets.new> (signed in as the account that should own it).
2. Title it **The Learning Toolshed — Ideas**.

## 2. Paste the script

1. In the sheet: **Extensions → Apps Script**.
2. Delete anything in the editor, paste all of `Code.gs` (this folder), **Ctrl+S**.

## 3. Deploy it as a web app

1. **Deploy → New deployment**.
2. Click the ⚙ (gear) → **Web app**.
3. Fill in:
   - **Description:** `Ideas Engine`
   - **Execute as:** **Me** (the account that owns the sheet)
   - **Who has access:** **Anyone** ← required, so staff can submit without signing in
4. **Deploy** → if asked to authorize, pick your account, then
   **Advanced → Go to … (unsafe)** — it's your own script, nothing is shared.
5. Copy the **Web app URL** (it ends with `/exec`).

If **Anyone** is missing or greyed out, your Google Workspace admin has
blocked it — stop and tell me; there's a fallback plan.

## 4. Hand me the URL

Paste the `/exec` URL back into the chat (or drop it into
`IDEAS_ENDPOINT` at the top of `site.js` yourself) and I'll wire, test,
and ship it.

## 5. Test

1. Open `https://swankymcgee.github.io/ideas.html`, type a test idea, **Send idea →**
   → the "Gulp!" confirmation appears, and a row shows up in the sheet's
   **Ideas** tab with timestamp, idea, name, and page.
2. Visit the `/exec` URL directly → `{"ok":true,"service":"The Ideas Engine"}`.

## Notes

- Submissions under ~3 seconds after page load, or with the hidden
  honeypot field filled, are silently dropped (bot traps) — a real person
  typing never trips them.
- The old Google Form stays up as the in-page **error fallback** only;
  its responses remain readable in its own spreadsheet.
- Rows: `When | Idea | Name or email | Page`.
