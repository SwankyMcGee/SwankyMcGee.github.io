# The Learning Toolshed

**Sensory-friendly tools for autistic classrooms.**

The site behind the collection — the menu and staff resources for every tool.

**Live: `https://swankymcgee.github.io/`**

## Structure

| Page | What it is |
|---|---|
| `index.html` | Home — a chooser: **Tools** or **Resources** |
| `tools.html` | Tools hub — cards for each tool (currently: the Work Cycle Timer + The Ideas Engine) |
| `resources.html` | Resources hub — dropdown picks the tool, then its resource cards load on the page |
| `quick-start.html` | Work Cycle Timer quick start (one page) |
| `user-guide.html` | Work Cycle Timer full user guide |
| `settings-ref.html` | Work Cycle Timer settings reference |
| `troubleshooting.html` | Work Cycle Timer troubleshooting FAQ |
| `scenarios.html` | Work Cycle Timer scenario walkthroughs |
| `glossary.html` | Work Cycle Timer glossary |
| `site.css` | Shared styling + print styles for every page |
| `site.js` | Shared color palette — applies the remembered theme before first paint and injects the 🎨 Palette header button on every page |

The tools themselves live in **their own repos** and are served from their own
Paths on the same domain — the Work Cycle Timer app comes from the
`work-cycle-timer` repo at
`https://swankymcgee.github.io/work-cycle-timer/timer.html`.

## Adding a tool

1. Ship the tool's app in its own repo with its own GitHub Pages path
   (e.g. `/some-tool/`).
2. Add a card to `tools.html`.
3. Add its staff resources as pages here, then register them on
   `resources.html`: an `<option>` in the dropdown plus a matching
   `<section class="tool-group" data-tool="…">` block (there's a comment
   in the file showing exactly what to copy). The dropdown shows only the
   selected tool's cards.
4. Every new page needs `<script src="site.js"></script>` in its `<head>`
   right after the site.css link — it applies the shared palette before
   first paint (no flash) and adds the 🎨 Palette button to the header.
   Palettes come from the timer's setting
   (`localStorage["workCycleTimer.settings.v1"].theme`); a tool with its
   own theme UI should read and write that same field (patching one field
   of the parsed JSON, never overwriting the rest) so every page and tool
   stays in step. Keep `THEMES` in `site.js` identical to the app's
   `THEMES` in its `app.js`.

## Publishing

`git add -A` → `git commit` → `git push`. Pages rebuilds in about a minute.
Check with
`gh api repos/SwankyMcGee/SwankyMcGee.github.io/pages/builds/latest`.

Materials dated **November 2026** to match the tools' state.
