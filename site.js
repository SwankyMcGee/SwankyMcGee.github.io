/* ============================================================
   The Learning Toolshed — shared color palette.
   The site pages and the Work Cycle Timer share one setting:
   localStorage["workCycleTimer.settings.v1"].theme. This script
   applies it before first paint (no flash) and gives every page
   the same 11 palettes in its header. Keep THEMES in sync with
   app.js (THEMES) in the work-cycle-timer repo.
   ============================================================ */

'use strict';

const STORAGE_KEY = 'workCycleTimer.settings.v1';

/* Same 11 palettes as the timer's Settings → Display (app.js THEMES).
   chips = [page background, surface, text, accent, second accent]. */
const THEMES = [
  { id: 'calm',     name: 'Calm (soft blue & green)',   chips: ['#f2f6f8', '#ffffff', '#33414d', '#4d84a6', '#628f5d'] },
  { id: 'lavender', name: 'Lavender (soft purple)',     chips: ['#f5f3fb', '#ffffff', '#3d3a52', '#7a6fc0', '#6a9a76'] },
  { id: 'mint',     name: 'Mint (fresh green)',         chips: ['#eef8f3', '#ffffff', '#2f4640', '#35837e', '#6f9a58'] },
  { id: 'peach',    name: 'Peach (warm apricot)',       chips: ['#fdf6ef', '#fffdfb', '#4d3f34', '#c26a3c', '#7a9a5a'] },
  { id: 'rose',     name: 'Rose (soft pink)',           chips: ['#fdf4f6', '#ffffff', '#4f3540', '#c25f7e', '#6f9466'] },
  { id: 'ocean',    name: 'Ocean (aqua blue)',          chips: ['#eef8fa', '#ffffff', '#2c4750', '#2f87a3', '#5f9a6a'] },
  { id: 'low',      name: 'Low contrast (very gentle)', chips: ['#eef1f3', '#f6f8f9', '#5b6570', '#94b4c3', '#a9c5a5'] },
  { id: 'high',     name: 'High contrast',              chips: ['#000000', '#0b0d10', '#ffffff', '#56e0ff', '#b7ff5e'] },
  { id: 'dark',     name: 'Dark (slate)',               chips: ['#151a20', '#1e242b', '#e7edf2', '#6fa9c7', '#8fbf88'] },
  { id: 'midnight', name: 'Midnight (deep blue)',       chips: ['#0a0f1e', '#121a30', '#e3e9f7', '#6fa8ff', '#67d6a5'] },
  { id: 'warm',     name: 'Warm dark (sepia)',          chips: ['#211a14', '#2b221a', '#f0e6da', '#d9a05f', '#93b877'] }
];

/* Site-only state (the menu/docs pages — the timer doesn't read this):
   the last guide visited, for the home page's jump-back card. */
const SITE_KEY = 'workCycleTimer.site.v1';

/* Version of the "what's new" ribbon — bump it to show a fresh message. */
const NEWS_VERSION = '2026-11';

/* Friendly names for the jump-back card — every page except the home
   page itself (the card is the way back into whatever was open). */
const PAGE_NAMES = {
  'tools.html': 'Tools',
  'resources.html': 'Resources',
  'quick-start.html': 'Quick start',
  'user-guide.html': 'User guide',
  'settings-ref.html': 'Settings reference',
  'troubleshooting.html': 'Troubleshooting',
  'scenarios.html': 'Scenarios',
  'glossary.html': 'Glossary'
};

/* Read the shared setting. Never trust it: unknown ids fall back to
   calm, exactly like the timer validates on load. */
function readTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && THEMES.some((t) => t.id === s.theme)) return s.theme;
    }
  } catch (err) { /* storage blocked — fall through to the default */ }
  return 'calm';
}

/* Write back fields of the shared setting while preserving every other
   one (the timer's durations, music, etc.) — read, patch, write. */
function patchSettings(fields) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    if (!s || typeof s !== 'object') return false;
    Object.assign(s, fields);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch (err) {
    return false;   // still apply for this visit; it just won't persist
  }
}

function writeTheme(id) {
  return patchSettings({ theme: id });
}

/* Home background patterns: on unless the shared setting says off. */
function motifsOn() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.homeMotifs === false) return false;
    }
  } catch (err) { /* blocked storage — default on */ }
  return true;
}

function syncMotifs() {
  const on = motifsOn();
  document.documentElement.classList.toggle('motifs-off', !on);
  const btn = document.getElementById('motifBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const state = document.getElementById('motifState');
    if (state) state.textContent = on ? 'On' : 'Off';
  }
}

/* Has this version of the what's-new ribbon been dismissed? */
function newsDismissed() {
  try {
    return localStorage.getItem('workCycleTimer.site.news') === NEWS_VERSION;
  } catch (err) {
    return false;
  }
}

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  syncPicker(id);
}

function syncPicker(id) {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  for (const row of panel.querySelectorAll('.theme-opt')) {
    const on = row.dataset.theme === id;
    row.classList.toggle('active', on);
    row.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function closePanel() {
  const panel = document.getElementById('themePanel');
  const btn = document.getElementById('themeBtn');
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function togglePanel() {
  const panel = document.getElementById('themePanel');
  const btn = document.getElementById('themeBtn');
  if (!panel) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

/* Build the header button + panel once the header exists. */
function injectPicker() {
  const head = document.querySelector('.site-head');
  if (!head || document.getElementById('themeWrap')) return;

  const wrap = document.createElement('div');
  wrap.className = 'theme-wrap';
  wrap.id = 'themeWrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-btn';
  btn.id = 'themeBtn';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Change the color palette';
  btn.setAttribute('aria-label', 'Change the color palette');
  btn.innerHTML = '<span aria-hidden="true">\uD83C\uDFA8</span><span>Palette</span>';

  const panel = document.createElement('div');
  panel.className = 'theme-panel';
  panel.id = 'themePanel';
  panel.hidden = true;
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Color palettes');

  for (const t of THEMES) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'theme-opt';
    row.dataset.theme = t.id;
    row.setAttribute('aria-pressed', 'false');

    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = t.name;

    const chips = document.createElement('span');
    chips.className = 'theme-chips';
    chips.setAttribute('aria-hidden', 'true');   // the name says it all
    for (const hex of t.chips) {
      const chip = document.createElement('span');
      chip.className = 'theme-chip';
      chip.style.background = hex;
      chips.appendChild(chip);
    }

    row.append(name, chips);
    row.addEventListener('click', () => {
      writeTheme(t.id);        // remembered on every page and in the timer
      applyTheme(t.id);
      closePanel();
    });
    panel.appendChild(row);
  }

  /* Toggle for the home page's background patterns (off switch lives
     right beside the palettes it decorates). */
  const motifBtn = document.createElement('button');
  motifBtn.type = 'button';
  motifBtn.className = 'motif-btn';
  motifBtn.id = 'motifBtn';
  motifBtn.setAttribute('aria-pressed', 'true');
  motifBtn.title = 'Gentle background patterns on the home page';
  const motifLabel = document.createElement('span');
  motifLabel.textContent = 'Background patterns';
  const motifState = document.createElement('span');
  motifState.className = 'motif-state';
  motifState.id = 'motifState';
  motifState.textContent = 'On';
  motifBtn.append(motifLabel, motifState);
  motifBtn.addEventListener('click', () => {
    patchSettings({ homeMotifs: !motifsOn() });
    syncMotifs();
  });
  panel.appendChild(motifBtn);

  btn.addEventListener('click', togglePanel);
  wrap.append(btn, panel);
  head.appendChild(wrap);

  /* Click away or press Escape to close. */
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  syncPicker(readTheme());
  syncMotifs();
}

/* Apply before first paint — no flash of the wrong palette. */
applyTheme(readTheme());
/* Same for the home page's two switches: patterns and the news ribbon. */
if (!motifsOn()) document.documentElement.classList.add('motifs-off');
if (newsDismissed()) document.documentElement.classList.add('news-off');

/* ---------- Home page extras ---------- */

/* Jump-back card: show the last page that was open (the home page
   itself is never recorded — you're already there). */
function renderJump() {
  const card = document.getElementById('jumpCard');
  const name = document.getElementById('jumpName');
  if (!card || !name) return;
  try {
    const raw = localStorage.getItem(SITE_KEY);
    const st = raw ? JSON.parse(raw) : null;
    const last = st && typeof st.last === 'string' ? st.last : '';
    if (last && PAGE_NAMES[last]) {
      name.textContent = PAGE_NAMES[last];
      card.href = last;
      card.hidden = false;
      return;
    }
  } catch (err) { /* no storage, no card */ }
  card.hidden = true;
}

function initHome() {
  if (!document.body.classList.contains('home')) return;

  renderJump();

  /* What's-new ribbon: dismiss remembers the version, so a future
     message (bump NEWS_VERSION) shows up fresh. */
  const dismiss = document.getElementById('newsDismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      try { localStorage.setItem('workCycleTimer.site.news', NEWS_VERSION); } catch (err) {}
      const ribbon = document.getElementById('newsRibbon');
      if (ribbon) ribbon.hidden = true;
      document.documentElement.classList.add('news-off');
    });
  }

  /* Easter egg: click the title 5 times (within ~2.5s of each other)
     and a cat appears beside the shed — same trick as the timer. */
  const title = document.getElementById('homeTitle');
  const art = document.getElementById('heroArt');
  if (title && art) {
    let clicks = 0;
    let lastAt = 0;
    title.addEventListener('click', () => {
      const now = Date.now();
      clicks = (now - lastAt > 2500) ? 1 : clicks + 1;
      lastAt = now;
      if (clicks >= 5) {
        art.classList.add('cat-on');
        clicks = 0;
      }
    });
  }
}

/* Remember the current page for the home page's jump-back card.
   Every page counts now — tools and resources included; only the
   home page itself is skipped. */
function recordLastPage() {
  const file = location.pathname.split('/').pop() || 'index.html';
  if (!PAGE_NAMES[file]) return;   // the home page (or nothing) — nothing to remember
  try {
    localStorage.setItem(SITE_KEY, JSON.stringify({ last: file }));
  } catch (err) { /* private mode */ }
}

function initPage() {
  injectPicker();
  recordLastPage();
  initHome();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}

/* Another tab changed something we share — follow it live:
   the palette and pattern switch live in the timer's key, the
   jump-back target in ours. */
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    applyTheme(readTheme());
    syncMotifs();
  } else if (e.key === SITE_KEY) {
    renderJump();
  }
});
