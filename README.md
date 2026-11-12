# swankymcgee.github.io

The base site — the menu and staff resources for the classroom tools.

**Live: `https://swankymcgee.github.io/`**

## Structure

| Page | What it is |
|---|---|
| `index.html` | Home — a chooser: **Tools** or **Resources** |
| `tools.html` | Tools hub — cards for each tool (currently: the Work Cycle Timer + The Ideas Engine) |
| `resources.html` | Resources hub — the staff-resource cards |
| `quick-start.html` | Work Cycle Timer quick start (one page) |
| `user-guide.html` | Work Cycle Timer full user guide |
| `settings-ref.html` | Work Cycle Timer settings reference |
| `troubleshooting.html` | Work Cycle Timer troubleshooting FAQ |
| `scenarios.html` | Work Cycle Timer scenario walkthroughs |
| `glossary.html` | Work Cycle Timer glossary |
| `site.css` | Shared styling + print styles for every page |

The tools themselves live in **their own repos** and are served from their own
Paths on the same domain — the Work Cycle Timer app comes from the
`work-cycle-timer` repo at
`https://swankymcgee.github.io/work-cycle-timer/timer.html`.

## Adding a tool

1. Ship the tool's app in its own repo with its own GitHub Pages path
   (e.g. `/some-tool/`).
2. Add a card to `tools.html`.
3. Add its staff resources as pages here and a card to `resources.html`.

## Publishing

`git add -A` → `git commit` → `git push`. Pages rebuilds in about a minute.
Check with
`gh api repos/SwankyMcGee/SwankyMcGee.github.io/pages/builds/latest`.

Materials dated **November 2026** to match the tools' state.
