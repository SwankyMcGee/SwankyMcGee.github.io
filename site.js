/* ============================================================
   The Learning Toolshed — site pages (hub + docs).
   Uses toolshed-common for shared theme tokens & utilities.
   This file contains only site-specific logic:
     - Manifest-driven rendering (Tools hub, Resources hub)
     - Ideas Engine public submission form
     - Anonymous page-view tracking
     - Jump-back card (last guide visited)
     - What's-new ribbon
     - Palette picker (more sophisticated than common's)
   ============================================================ */

'use strict';

/* Site-only constants */
const SITE_KEY = 'workCycleTimer.site.v1';
const NEWS_VERSION = '2026-11';
const IDEAS_ENDPOINT =
  'https://script.google.com/macros/s/AkfycbzZG7bLh8EQTsnZN8pfkHiry_gQMT2PFggl7M4Ku1RAUjDgpHDGczpla_dsEXhmIA4jDw/exec';

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

/* Fallback tool list (manifest is source of truth) */
const TOOLS = ['Work Cycle Timer', 'Math Playground', 'Morning Work', 'Our Day'];
const MANIFEST_URL = 'site-manifest.json';
let manifestCache = null;

/* ---------- Small helpers ---------- */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(value) { return esc(value); }
function slug(value) {
  return String(value == null ? '' : value).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ---------- Manifest (source of truth for tools/pages) ---------- */
async function loadManifest() {
  if (manifestCache) return manifestCache;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.tools) || !Array.isArray(data.pages)) {
      throw new Error('bad manifest');
    }
    manifestCache = data;
  } catch (err) {
    manifestCache = null;
  }
  return manifestCache;
}

/* ---------- Tools hub (tools.html) ---------- */
function toolCardsHtml(tools) {
  return tools.map((t) => {
    const id = t.id || slug(t.name);
    const href = t.path || ('#' + id);
    return '<a class="card" href="' + escAttr(href) + '" data-tool="' + escAttr(id) + '">' +
      '<h3>' + esc(t.name) + '</h3>' +
      '<p>' + (t.blurb || '') + '</p>' +
      '<span class="go">Open ' + esc(t.name) + ' →</span>' +
      '</a>';
  }).join('');
}

async function initTools() {
  const grid = document.querySelector('[data-render="tools"]');
  if (!grid) return;
  const manifest = await loadManifest();
  const tools = manifest ? manifest.tools : [];
  if (!tools.length) return;
  grid.innerHTML = toolCardsHtml(tools);
}

/* ---------- Resources hub (resources.html) ---------- */
function resourceSectionsHtml(tools, pages) {
  return tools.map((tool) => {
    const mine = pages.filter((p) => p.tool === tool.id && p.kind === 'resource');
    if (!mine.length) return '';
    const cards = mine.map((p) =>
      '<a class="card" href="' + escAttr(p.path) + '">' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<span class="go">Read →</span>' +
      '</a>').join('');
    return '<section class="tool-group" data-tool="' + escAttr(tool.id) + '">' +
      '<div class="cards">' + cards + '</div></section>';
  }).join('');
}

function resourceOptionsHtml(tools) {
  const opts = tools.map((t) =>
    '<option value="' + escAttr(t.id) + '">' + esc(t.name) + '</option>');
  return '<option value="" selected>Select a tool…</option>' + opts.join('');
}

async function initResources() {
  const picker = document.getElementById('toolSelect');
  if (!picker) return;
  const manifest = await loadManifest();
  const host = picker.closest('main') || document.body;

  if (manifest) {
    let groups = host.querySelector('[data-resource-groups]');
    if (!groups) {
      groups = document.createElement('div');
      groups.setAttribute('data-resource-groups', '');
      host.insertBefore(groups, picker.closest('.tool-picker').nextSibling);
      host.querySelectorAll('.tool-group').forEach((g) => g.remove());
    }
    groups.innerHTML = resourceSectionsHtml(manifest.tools, manifest.pages);
    picker.innerHTML = resourceOptionsHtml(manifest.tools);
  }

  bindResourcePicker(picker, host);
}

function bindResourcePicker(picker, host) {
  const hint = document.getElementById('pickerHint');
  const showSelected = () => {
    const chosen = picker.value;
    host.querySelectorAll('.tool-group').forEach((g) => {
      g.hidden = (g.getAttribute('data-tool') !== chosen);
    });
    if (hint) hint.hidden = !!chosen;
  };
  picker.addEventListener('change', showSelected);
  showSelected();
}

/* ---------- Ideas Engine public form (ideas.html) ---------- */
function initIdeas() {
  const form = document.getElementById('ideaForm');
  if (!form) return;

  const submit = document.getElementById('ideaSubmit');
  const status = document.getElementById('ideaStatus');
  const title = document.getElementById('ideaStatusTitle');
  const text = document.getElementById('ideaStatusText');
  const fallback = document.getElementById('ideaFallback');
  const again = document.getElementById('ideaAgain');
  const fine = document.getElementById('ideaFine');
  const loadIn = document.getElementById('ideaLoaded');
  const typeRadios = form.querySelectorAll('input[name="type"]');
  const toolField = document.getElementById('toolField');
  const toolSelect = document.getElementById('ideaTool');

  function stamp() { if (loadIn) loadIn.value = String(Date.now()); }
  stamp();

  function fillTools(names) {
    if (!toolSelect || !names.length) return;
    const current = toolSelect.value;
    toolSelect.innerHTML = '';
    const first = document.createElement('option');
    first.value = ''; first.textContent = '-Select A Tool-';
    toolSelect.appendChild(first);
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      toolSelect.appendChild(opt);
    });
    if (current && names.indexOf(current) >= 0) toolSelect.value = current;
  }

  fillTools(TOOLS);
  loadManifest().then((manifest) => {
    if (manifest && manifest.tools && manifest.tools.length) {
      fillTools(manifest.tools.map((t) => t.name).filter(Boolean));
    }
  });

  typeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const feature = radio.checked && radio.value === 'feature';
      toolField.hidden = !feature;
      toolSelect.required = feature;
      if (!feature) toolSelect.value = '';
    });
  });

  function show(kind, head, body) {
    form.hidden = true;
    status.hidden = false;
    status.className = 'idea-status ' + kind;
    title.textContent = head;
    text.textContent = body;
    fallback.hidden = kind !== 'error';
    again.hidden = kind !== 'ok';
    status.focus();
  }

  if (!IDEAS_ENDPOINT) {
    submit.disabled = true;
    if (fine) {
      fine.textContent = 'Not connected yet — deploy the backend ' +
        '(ideas-engine/SETUP.md) and paste its URL into IDEAS_ENDPOINT in site.js.';
    }
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const res = await fetch(IDEAS_ENDPOINT, {
        method: 'POST', body: new FormData(form)
      });
      const data = await res.json();
      if (!data || !data.ok) throw new Error('endpoint said no');
      show('ok', 'Gulp!', 'The Ideas Engine swallowed your idea whole and ' +
        'looks pleased with itself. It reads every one — thanks for feeding it!');
    } catch (err) {
      show('error', 'That idea didn\'t send', 'Something got in the way — ' +
        'try once more, or use the fallback form below. No idea is lost.');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Send idea →';
    }
  });

  again.addEventListener('click', () => {
    status.hidden = true;
    form.hidden = false;
    form.reset();
    stamp();
    document.getElementById('ideaText').focus();
  });
}

/* ---------- Anonymous usage ping ---------- */
function trackPageView() {
  if (!IDEAS_ENDPOINT) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  const started = Date.now();
  let lastSent = -1;

  const send = () => {
    const seconds = Math.min(3600, Math.max(0,
      Math.round((Date.now() - started) / 1000)));
    if (seconds === lastSent) return;
    lastSent = seconds;
    const body = 'action=track' +
      '&path=' + encodeURIComponent(location.pathname) +
      '&seconds=' + seconds +
      '&referrer=' + encodeURIComponent(document.referrer || '');
    try {
      const blob = new Blob([body], { type: 'application/x-www-form-urlencoded' });
      if (navigator.sendBeacon && navigator.sendBeacon(IDEAS_ENDPOINT, blob)) return;
      fetch(IDEAS_ENDPOINT, {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        keepalive: true
      }).catch(() => {});
    } catch (err) {}
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
  });
  window.addEventListener('beforeunload', send);
  setTimeout(() => { if (document.visibilityState === 'visible') send(); }, 30000);
}

/* ---------- Jump-back card (home page) ---------- */
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
  } catch (err) {}
  card.hidden = true;
}

function initHome() {
  if (!document.body.classList.contains('home')) return;
  renderJump();

  const dismiss = document.getElementById('newsDismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      try { localStorage.setItem('workCycleTimer.site.news', NEWS_VERSION); } catch (err) {}
      const ribbon = document.getElementById('newsRibbon');
      if (ribbon) ribbon.hidden = true;
      document.documentElement.classList.add('news-off');
    });
  }

  const plate = document.getElementById('logoPlate');
  const art = document.getElementById('heroArt');
  if (plate && art) {
    let clicks = 0, lastAt = 0;
    plate.addEventListener('click', () => {
      const now = Date.now();
      clicks = (now - lastAt > 2500) ? 1 : clicks + 1;
      lastAt = now;
      if (clicks >= 5) { art.classList.add('cat-on'); clicks = 0; }
    });
  }
}

function recordLastPage() {
  const file = location.pathname.split('/').pop() || 'index.html';
  if (!PAGE_NAMES[file]) return;
  try { localStorage.setItem(SITE_KEY, JSON.stringify({ last: file })); } catch (err) {}
}

/* ---------- Palette picker (site-specific, more sophisticated) ---------- */
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

  for (const t of ToolshedCommon.THEMES) {
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
    chips.setAttribute('aria-hidden', 'true');
    for (const hex of t.chips) {
      const chip = document.createElement('span');
      chip.className = 'theme-chip';
      chip.style.background = hex;
      chips.appendChild(chip);
    }

    row.append(name, chips);
    row.addEventListener('click', () => {
      ToolshedCommon.writeTheme(t.id);
      ToolshedCommon.applyTheme(t.id);
      closePanel();
    });
    panel.appendChild(row);
  }

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
    ToolshedCommon.patchSettings({ homeMotifs: !ToolshedCommon.motifsOn() });
    ToolshedCommon.syncMotifs();
  });
  panel.appendChild(motifBtn);

  btn.addEventListener('click', togglePanel);
  wrap.append(btn, panel);
  head.appendChild(wrap);

  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  ToolshedCommon.syncPicker(ToolshedCommon.readTheme());
  ToolshedCommon.syncMotifs();
}

/* ---------- One-time setup (runs inline for no-flash theme) ---------- */
ToolshedCommon.applyTheme(ToolshedCommon.readTheme());
if (!ToolshedCommon.motifsOn()) document.documentElement.classList.add('motifs-off');
if (localStorage.getItem('workCycleTimer.site.news') === NEWS_VERSION) {
  document.documentElement.classList.add('news-off');
}

/* ---------- Page initialization ---------- */
function initPage() {
  injectPicker();
  ToolshedCommon.upgradeFooters();
  recordLastPage();
  initHome();
  initIdeas();
  initTools();
  initResources();
  trackPageView();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}

/* Cross-tab sync for theme changes */
window.addEventListener('storage', (e) => {
  if (e.key === ToolshedCommon.STORAGE_KEY) {
    ToolshedCommon.applyTheme(ToolshedCommon.readTheme());
    ToolshedCommon.syncMotifs();
  } else if (e.key === SITE_KEY) {
    renderJump();
  }
});