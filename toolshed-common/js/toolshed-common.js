/* ============================================================
   toolshed-common — shared runtime for The Learning Toolshed
   projects: site, morning-work, math-playground, work-cycle-timer.

   Import once per page (before first paint):
     <script src="https://swankymcgee.github.io/toolshed-common/js/toolshed-common.js"></script>

   Or locally during development:
     <script src="/toolshed-common/js/toolshed-common.js"></script>

   This module exposes:
     THEMES           — the 11 color palettes (array of {id, name, chips})
     STORAGE_KEY      — 'workCycleTimer.settings.v1'
     readTheme()      — returns current theme id, validates against THEMES
     patchSettings()  — patches single fields in shared localStorage key
     writeTheme()     — convenience: patchSettings({ theme: id })
     motifsOn()       — reads homeMotifs flag (default true)
     syncMotifs()     — applies motifs-off class to documentElement
     applyTheme()     — sets data-theme + syncs picker UI
     syncPicker()     — highlights active theme in picker panel
     makeHoldable()   — attaches hold-to-activate behavior to any element
     makeHoldBtn()    — creates a hold button (icon + label + progress ring)
     injectHeader()   — builds brand + tool nav + the standard control
                        cluster: Chime · Fullscreen · Settings · Home
     injectFooter()   — builds the shared footer (workbench scene + rotating
                        shed wisdom + the "Staff resources" phrase)
     upgradeFooters() — adds scene/wisdom to footers that already have markup
     initCommon()     — one-call setup: applyTheme(readTheme()), syncMotifs(),
                        injectHeader(), injectFooter(), storage listener

   Each tool provides its own:
     - tool-specific settings key (e.g., 'workCycleTimer.morning.v1')
     - tool-specific parts/games config
     - tool-specific init*() function called after initCommon()
   ============================================================ */

/* Wrapped in an IIFE: top-level const/let in a classic script become
   shared global lexical bindings, which collide with the same names
   in a tool's own script (e.g. STORAGE_KEY) and throw SyntaxErrors
   that kill the whole tool script. Nothing but window.ToolshedCommon
   may escape this scope. */
(function () {

'use strict';

/* ---------- The 11 shared palettes ----------
   chips = [page background, surface, text, accent, second accent].
   Keep in step with the [data-theme] blocks in toolshed-common.css.
   Do NOT edit here — edit the CSS and this array together, or use
   the generate-themes.ps1 script to keep them in sync. */
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

/* The shared localStorage key — holds theme, homeMotifs, and any
   other cross-tool settings (timer durations, music, etc.). */
const STORAGE_KEY = 'workCycleTimer.settings.v1';

/* ---------- Theme helpers ---------- */

function readTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && THEMES.some((t) => t.id === s.theme)) return s.theme;
    }
  } catch (err) { /* storage blocked — fall through */ }
  return 'calm';
}

function patchSettings(fields) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    if (!s || typeof s !== 'object') return false;
    Object.assign(s, fields);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch (err) {
    return false;
  }
}

function writeTheme(id) { return patchSettings({ theme: id }); }

function motifsOn() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.homeMotifs === false) return false;
    }
  } catch (err) { /* default on */ }
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

/* ---------- Hold-to-activate system ---------- */

function makeHoldable(el, ms, action) {
  if (!el) return;
  let timer = null;
  let raf = null;
  const fill = el.querySelector('.hold-fill');
  const start = () => {
    timer = setTimeout(action, ms);
    if (fill) {
      const dur = ms / 1000;
      fill.style.transition = `transform ${dur}s linear`;
      fill.style.transform = 'scaleX(1)';
    }
    el.classList.add('holding');
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (fill) {
      fill.style.transition = '';
      fill.style.transform = 'scaleX(0)';
    }
    el.classList.remove('holding');
  };
  const down = (e) => {
    if (e.type === 'mousedown' && e.button !== 0) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    start();
  };
  const up = () => cancel();
  el.addEventListener('mousedown', down);
  el.addEventListener('touchstart', down, { passive: true });
  el.addEventListener('keydown', down);
  window.addEventListener('mouseup', up);
  window.addEventListener('touchend', up);
  window.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') up(); });
}

/* ---------- Header cluster icons ----------
   One monochrome SVG set for every tool's control cluster, so a
   teacher who learns the buttons on one tool recognises them on the
   next: bell (chime), expand (fullscreen), gear (settings), house
   (home). 16px reads clearly at the button's font size. */
const ICONS = {
  bell: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
  expand: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm16 0v6h-6v-2h4v-4z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.58-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.24 0 .45-.18.49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1c.22.08.48 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>',
  home: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 3.2 2.6 11.5V21h6.6v-6.2h5.6V21h6.6v-9.5z"/></svg>'
};

function makeHoldBtn(kind, label, ms, action, icon) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `hold-btn ${kind}-btn`;
  btn.title = `Hold for ${ms / 1000} second${ms > 1000 ? 's' : ''} to ${label.toLowerCase()}`;
  btn.setAttribute('aria-label', `${label} — hold ${ms / 1000}s`);
  btn.innerHTML =
    (icon ? `<span class="hold-icon" aria-hidden="true">${icon}</span>` : '') +
    `<span class="hold-label">${label}</span>` +
    `<span class="hold-track" aria-hidden="true"><span class="hold-fill"></span></span>`;
  makeHoldable(btn, ms, action);
  return btn;
}

/* ---------- Fullscreen (standard cluster button) ----------
   The same 1-second hold everywhere. The label flips to "Exit
   fullscreen" while the screen is filled, so the button always says
   what the next hold will do. Tools with their own fullscreen code
   (Work Cycle Timer) keep it — this is for the pages that had none. */

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
  if (!isFullscreen()) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) { /* denied */ }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try { if (exit) exit.call(document); } catch (err) { /* ignore */ }
  }
}

function makeFullscreenBtn() {
  const btn = makeHoldBtn('fs', 'Fullscreen', 1000, toggleFullscreen, ICONS.expand);
  const sync = () => {
    const on = isFullscreen();
    btn.querySelector('.hold-label').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
    btn.title = on ? 'Hold for 1 second to leave fullscreen'
                   : 'Hold for 1 second to fill the screen';
    btn.setAttribute('aria-label', on
      ? 'Exit fullscreen — hold 1 second'
      : 'Fullscreen — hold 1 second to fill the screen');
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  sync();
  return btn;
}

/* ---------- Shared header/footer injection ---------- */

function injectHeader(config = {}) {
  const {
    title = 'The Learning Toolshed',
    subtitle = 'Toolshed',
    brandHref = 'index.html',
    showSoundBtn = true,
    showFullscreenBtn = true,
    showSettingsBtn = true,
    showHomeBtn = true,
    homeUrl = 'https://swankymcgee.github.io/',
    tools = [],
    activeTool = null,
    onSoundToggle = null,
    onSettingsOpen = null
  } = config;

  const head = document.querySelector('header.site-head') || document.querySelector('header.app-header');
  if (!head) return;

  /* Clear existing dynamic content (keep static brand if present) */
  const existingBrand = head.querySelector('.brand');
  const existingTools = head.querySelector('.header-tools, .site-nav');
  if (existingBrand && !existingBrand.querySelector('h1')) existingBrand.remove();
  if (existingTools) existingTools.remove();

  /* Brand */
  let brand = head.querySelector('.brand');
  if (!brand) {
    brand = document.createElement('div');
    brand.className = 'brand';
    head.insertBefore(brand, head.firstChild);
  }
  brand.innerHTML = `<h1>${title}</h1><span class="brand-sub">· ${subtitle}</span>`;
  const brandLink = document.createElement('a');
  brandLink.href = brandHref;
  brandLink.className = 'brand-link';
  brandLink.title = `Back to ${title}`;
  brandLink.append(...brand.childNodes);
  brand.appendChild(brandLink);

  /* Tool nav + controls */
  const toolsDiv = document.createElement('div');
  toolsDiv.className = 'header-tools';

  if (tools.length) {
    const nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', 'Tools');
    for (const t of tools) {
      const a = document.createElement('a');
      a.href = t.href;
      a.textContent = t.name;
      a.setAttribute('aria-current', t.id === activeTool ? 'page' : 'false');
      nav.appendChild(a);
    }
    toolsDiv.appendChild(nav);
  }

  const controls = document.createElement('div');
  controls.className = 'header-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Tool controls');

  /* The standard cluster — same order on every tool, always parked on
     the right: Chime (1s hold) · Fullscreen (1s hold) · Settings
     (3s hold) · Home (1s hold). Each tool's own syncSoundBtn() keeps
     the chime label ("Chime: on/off") honest after the first build. */
  if (showSoundBtn && onSoundToggle) {
    const snd = makeHoldBtn('sound', 'Chime: on', 1000, onSoundToggle, ICONS.bell);
    snd.title = 'Chime: on — hold 1 second to turn it off';
    snd.setAttribute('aria-label', snd.title);
    controls.appendChild(snd);
  }
  if (showFullscreenBtn) controls.appendChild(makeFullscreenBtn());
  if (showSettingsBtn && onSettingsOpen) {
    controls.appendChild(makeHoldBtn('settings', 'Settings', 3000, onSettingsOpen, ICONS.gear));
  }
  if (showHomeBtn) {
    controls.appendChild(makeHoldBtn('home', 'Home', 1000, () => { window.location.href = homeUrl; }, ICONS.home));
  }

  toolsDiv.appendChild(controls);
  head.appendChild(toolsDiv);
}

/* ---------- Shared footer: workbench scene + shed wisdom ----------
   Every Toolshed page closes with the same little scene, drawn only
   from the active palette's own variables so it reads correctly on
   all 11 themes: the shed, a hanging tool rail, a workbench with a
   sprout, and the shed's notice board. The phrase below it stays
   fixed — "Staff resources for The Learning Toolshed" — and one line
   of rotating shed wisdom changes every 20 seconds (instant swap,
   no fade, when the visitor prefers reduced motion). */

const FOOTER_SCENE = [
  '<svg viewBox="0 0 1100 160" xmlns="http://www.w3.org/2000/svg" focusable="false">',
  '<g stroke-linecap="round" stroke-linejoin="round">',

  /* ground + two twinkles */
  '<path d="M18 141h1064" stroke="var(--border)" stroke-width="3"/>',
  '<path class="glow" style="animation-delay:-1s" d="M556 16l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="var(--accent)" opacity=".65"/>',
  '<path class="glow" style="animation-delay:-3s" d="M678 28l2.5 6.5 6.5 2.5-6.5 2.5-2.5 6.5-2.5-6.5-6.5-2.5 6.5-2.5z" fill="var(--accent2)" opacity=".7"/>',

  /* the shed: walls, chimney, roof, window, door */
  '<rect x="78" y="68" width="134" height="73" rx="3" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="3"/>',
  '<rect x="176" y="28" width="16" height="26" rx="2" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="3"/>',
  '<path d="M64 72 145 26l81 46h-14L145 40 78 72z" fill="var(--accent)"/>',
  '<rect x="94" y="84" width="30" height="28" rx="3" fill="var(--surface)" stroke="var(--dim)" stroke-width="3"/>',
  '<path d="M109 84v28M94 98h30" stroke="var(--dim)" stroke-width="2.5"/>',
  '<rect x="140" y="98" width="44" height="43" rx="4" fill="var(--surface)" stroke="var(--dim)" stroke-width="3"/>',
  '<circle cx="174" cy="120" r="3.5" fill="var(--dim)"/>',

  /* tool rail + hanging tools (each sways from its own peg) */
  '<path d="M262 42h284" stroke="var(--dim)" stroke-width="4"/>',
  '<circle cx="262" cy="42" r="5" fill="var(--accent)"/>',
  '<circle cx="546" cy="42" r="5" fill="var(--accent)"/>',

  '<g class="sway" style="animation-delay:-1s">',
  '<rect x="261" y="42" width="38" height="13" rx="3" fill="var(--accent)"/>',
  '<rect x="275" y="55" width="10" height="46" rx="5" fill="var(--dim)"/>',
  '</g>',

  '<g class="sway" style="animation-delay:-3s">',
  '<rect x="338" y="44" width="42" height="18" rx="9" fill="var(--accent)"/>',
  '<path d="M344 62h32l4 40-4 6-4-6-4 6-4-6-4 6-4-6-4 6-4-6-4 6-4-6z" fill="var(--surface-2)" stroke="var(--dim)" stroke-width="2.5"/>',
  '</g>',

  '<g class="sway" style="animation-delay:-2s">',
  '<rect x="434" y="44" width="12" height="42" rx="6" fill="var(--accent)"/>',
  '<rect x="430" y="84" width="20" height="13" rx="3" fill="var(--dim)"/>',
  '<path d="M431 97h18l-4 20h-10z" fill="var(--accent2)"/>',
  '</g>',

  '<g class="sway" style="animation-delay:-4s">',
  '<path d="M505 44v12" stroke="var(--dim)" stroke-width="3"/>',
  '<circle cx="505" cy="74" r="18" fill="var(--accent)" stroke="var(--dim)" stroke-width="3"/>',
  '<circle cx="505" cy="74" r="6" fill="var(--surface)"/>',
  '<rect x="500" y="90" width="10" height="16" rx="2" fill="var(--dim)"/>',
  '</g>',

  /* the workbench: shelf, legs, top */
  '<rect x="592" y="126" width="286" height="9" rx="4" fill="var(--surface-2)" stroke="var(--border)" stroke-width="2"/>',
  '<rect x="592" y="118" width="14" height="23" fill="var(--dim)"/>',
  '<rect x="864" y="118" width="14" height="23" fill="var(--dim)"/>',
  '<rect x="570" y="104" width="330" height="14" rx="5" fill="var(--accent)"/>',

  /* on the bench: sprout in a pot, blocks, mug, pencil */
  '<g class="nod">',
  '<path d="M624 71c0-10 0-16 0-24" stroke="var(--accent2)" stroke-width="3.5" fill="none"/>',
  '<path d="M624 60c-11-2-17-11-15-21 10 1 17 10 15 21z" fill="var(--accent2)"/>',
  '<path d="M624 52c10-3 15-12 12-21-9 2-15 11-12 21z" fill="var(--accent2)"/>',
  '</g>',
  '<rect x="601" y="71" width="46" height="11" rx="5" fill="var(--accent)"/>',
  '<path d="M606 81h36l-5 23h-26z" fill="var(--accent)"/>',

  '<rect x="690" y="82" width="24" height="22" rx="3" fill="var(--surface-2)" stroke="var(--dim)" stroke-width="2.5"/>',
  '<rect x="718" y="82" width="24" height="22" rx="3" fill="var(--surface-2)" stroke="var(--dim)" stroke-width="2.5"/>',
  '<rect x="704" y="58" width="24" height="24" rx="3" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="2.5"/>',

  '<path d="M790 74h30v20a10 10 0 0 1-10 10h-10a10 10 0 0 1-10-10z" fill="var(--surface-2)" stroke="var(--dim)" stroke-width="2.5"/>',
  '<path d="M820 80a9 9 0 0 1 0 16" fill="none" stroke="var(--dim)" stroke-width="3"/>',
  '<path d="M798 66c0-6 6-6 6-12M810 68c0-5 5-6 5-11" stroke="var(--dim)" stroke-width="2.5" fill="none" opacity=".7"/>',

  '<g transform="rotate(-4 870 98)">',
  '<rect x="838" y="94" width="46" height="10" rx="3" fill="var(--accent)"/>',
  '<path d="M884 94l12 5-12 5z" fill="var(--dim)"/>',
  '</g>',

  /* the shed's notice board */
  '<rect x="1000" y="70" width="13" height="71" fill="var(--dim)"/>',
  '<rect x="944" y="46" width="132" height="46" rx="8" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="3"/>',
  '<path d="M960 60h100M960 70h100M960 80h64" stroke="var(--dim)" stroke-width="3" opacity=".75"/>',

  '</g></svg>'
].join('');

const SHED_WISDOM = [
  'Measure twice, click once.',
  'Built in the shed \u2014 no sawdust in the keyboard.',
  'Take your time; good work never hurries.',
  'Small steps build strong shelves.',
  'Every expert started with a wobbly first nail.',
  'A tidy bench makes room for big ideas.',
  'Sharpen the pencil, then begin.',
  'Slow hands make neat work.',
  'You\u2019re plane amazing.',
  'Sawdust settles, good ideas rise.'
];

const WISDOM_MS = 20000;

function startWisdom(foot) {
  const el = foot.querySelector('.foot-wisdom');
  if (!el || el.dataset.on === '1') return;
  el.dataset.on = '1';
  let i = Math.floor(Math.random() * SHED_WISDOM.length);
  const quote = () => '\u201C' + SHED_WISDOM[i] + '\u201D';
  el.textContent = quote();
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  window.setInterval(() => {
    i = (i + 1) % SHED_WISDOM.length;
    if (reduce) { el.textContent = quote(); return; }
    el.classList.add('fading');
    window.setTimeout(() => {
      el.textContent = quote();
      el.classList.remove('fading');
    }, 650);
  }, WISDOM_MS);
}

/* Add the scene + wisdom line to footers that already carry their own
   markup (the hub's ten pages keep their per-page meta lines). */
function upgradeFooters() {
  const footers = document.querySelectorAll('footer.site-foot, footer.app-foot');
  for (const foot of footers) {
    if (foot.dataset.tscFoot === '1') continue;
    foot.dataset.tscFoot = '1';
    if (!foot.querySelector('.foot-scene')) {
      const scene = document.createElement('div');
      scene.className = 'foot-scene';
      scene.setAttribute('aria-hidden', 'true');
      scene.innerHTML = FOOTER_SCENE;
      foot.insertBefore(scene, foot.firstChild);
    }
    if (!foot.querySelector('.foot-wisdom')) {
      const w = document.createElement('p');
      w.className = 'foot-wisdom';
      const phrase = foot.querySelector('.foot-phrase');
      if (phrase) phrase.insertAdjacentElement('afterend', w);
      else foot.appendChild(w);
    }
    startWisdom(foot);
  }
}

function injectFooter(config = {}) {
  const {
    homeUrl = 'https://swankymcgee.github.io/',
    homeText = 'The Learning Toolshed',
    meta = 'App state: November 2026'
  } = config;
  let foot = document.querySelector('footer.site-foot, footer.app-foot');
  if (!foot) {
    foot = document.createElement('footer');
    foot.className = 'site-foot';
    document.body.appendChild(foot);
  }
  if (foot.dataset.tscFoot !== '1') {
    foot.dataset.tscFoot = '1';
    foot.innerHTML =
      `<div class="foot-scene" aria-hidden="true">${FOOTER_SCENE}</div>` +
      `<p class="foot-phrase">Staff resources for <a href="${homeUrl}">${homeText}</a></p>` +
      `<p class="foot-wisdom"></p>` +
      `<p class="foot-meta">${meta}</p>`;
  }
  startWisdom(foot);
}

/* ---------- One-call initialization ---------- */

function initCommon(headerConfig = {}, footerConfig = {}) {
  /* Apply theme before first paint (caller should have called this inline) */
  applyTheme(readTheme());
  syncMotifs();

  /* Inject shared chrome */
  injectHeader(headerConfig);
  injectFooter(footerConfig);

  /* Cross-tab sync for theme changes */
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      applyTheme(readTheme());
      syncMotifs();
    }
  });

  /* Palette picker delegation (if present) */
  const panel = document.getElementById('themePanel');
  if (panel) {
    panel.addEventListener('click', (e) => {
      const row = e.target.closest('.theme-opt');
      if (row) {
        const id = row.dataset.theme;
        writeTheme(id);
        applyTheme(id);
        const wrap = document.getElementById('themeWrap');
        if (wrap) wrap.querySelector('.theme-btn')?.click();
      }
    });
  }

  /* Motif toggle delegation */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#motifBtn');
    if (btn) {
      patchSettings({ homeMotifs: !motifsOn() });
      syncMotifs();
    }
  });
}

/* ---------- Our Day reminder notices on every Toolshed page ----------
   ourday-notify.js draws a small top-right toast when a schedule block is
   about to start. Only load it from the hub (never from disk — the offline
   tools must stay offline), and never on Our Day's own pages, which load
   it themselves. */

function loadOurDayNotify() {
  try {
    if (location.protocol === 'file:') return;
    const host = location.hostname;
    if (host !== 'swankymcgee.github.io' &&
        host !== 'localhost' && host !== '127.0.0.1') return;
    if (/^\/our-day(\/|$)/.test(location.pathname)) return;
    if (document.querySelector('script[data-ourday-notify]')) return;
    const s = document.createElement('script');
    s.src = '/our-day/ourday-notify.js';
    s.dataset.ourdayNotify = '1';
    s.defer = true;
    document.head.appendChild(s);
  } catch (err) { /* never break the host page */ }
}

/* ---------- Export for ES modules / global ---------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { THEMES, STORAGE_KEY, readTheme, patchSettings, writeTheme, motifsOn, syncMotifs, applyTheme, syncPicker, makeHoldable, makeHoldBtn, ICONS, makeFullscreenBtn, injectHeader, injectFooter, upgradeFooters, initCommon };
} else {
  window.ToolshedCommon = { THEMES, STORAGE_KEY, readTheme, patchSettings, writeTheme, motifsOn, syncMotifs, applyTheme, syncPicker, makeHoldable, makeHoldBtn, ICONS, makeFullscreenBtn, injectHeader, injectFooter, upgradeFooters, initCommon };
  /* Notices on every page that loads this lib (site, WCT, …) — the site
     never calls initCommon, so hook it up here at load time. */
  loadOurDayNotify();
}

})();