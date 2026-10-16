/* Beacon — crew portal.
 *
 * Plain browser JS, no build step. Data lives in Supabase and is reached only
 * through password-checked RPC functions (see supabase/schema.sql); the key
 * below is the public "publishable" key and grants nothing on its own.
 *
 * Sync model: every client polls `sync` with the server time it last saw and
 * merges what changed. Edits are sent as small per-field patches, so two
 * people typing in different fields of the same sheet don't overwrite each
 * other.
 */
'use strict';

const SB_URL  = 'https://kposvtazbuizognblzbb.supabase.co';
const SB_KEY  = 'sb_publishable_4IWxzlBAecz36z68OyukgA_fCaTjbX4';
const POLL_MS = 2500;

// ── Rules data ─────────────────────────────────────────────────────────────

const STATS = [
  { k: 'intelligence', n: 'Intelligence', s: 'Int',   a: ['int', 'intelligence'] },
  { k: 'wits',         n: 'Wits',         s: 'Wits',  a: ['wit', 'wits'] },
  { k: 'strength',     n: 'Strength',     s: 'Str',   a: ['str', 'strength'] },
  { k: 'dexterity',    n: 'Dexterity',    s: 'Dex',   a: ['dex', 'dexterity'] },
  { k: 'manipulation', n: 'Manipulation', s: 'Manip', a: ['man', 'manip', 'manipulation'] },
  { k: 'composure',    n: 'Composure',    s: 'Comp',  a: ['com', 'comp', 'composure'] },
];
const SKILLS = {
  intelligence: ['Investigation', 'History', 'Technology'],
  wits:         ['Perception', 'Insight', 'Survival'],
  strength:     ['Athletics', 'Intimidation', 'Endurance'],
  dexterity:    ['Stealth', 'Sleight of Hand', 'Acrobatics'],
  manipulation: ['Deception', 'Persuasion', 'Performance'],
  composure:    ['Nerve', 'Empathy', 'Focus'],
};
const VICES   = ['Greed', 'Pride', 'Wrath', 'Fear', 'Lust', 'Envy', 'Gluttony', 'Sloth'];
const VIRTUES = ['Loyalty', 'Mercy', 'Honesty', 'Fortitude', 'Hope', 'Charity', 'Humility', 'Diligence'];
const MOD = { 4: 2, 3: 1, 2: 0, 1: -1 };
const STAT_SPREAD = '4,3,3,2,2,1';
const PALETTE = ['#c9a24b', '#5fa8d3', '#d9776b', '#8fbf6a', '#b48ad6', '#e0a458', '#4fb3a9', '#d68fb0'];

const PANELS = {
  identity: 'Identity', look: 'Appearance', money: 'Money', gear: 'Gear',
  backstory: 'Backstory', notes: 'Notes',
  stats: 'Stats', skills: 'Skills', hp: 'HP', dying: 'Dropping', wear: 'Wear',
};
const FIELD_TYPES = {
  text: 'Short text', long: 'Long text', number: 'Number',
  check: 'Checkbox', track: 'Tracker boxes', roll: 'Roll button',
};

function blankSheet(name) {
  return {
    name: name || 'New Character', player: '', job: '', specialty: '', vice: '', virtue: '',
    accent: '', portrait: '',
    look: { height: '', skin: '', hair: '', eyes: '', markings: '' },
    stats: { intelligence: null, wits: null, strength: null, dexterity: null, manipulation: null, composure: null },
    skills: [],
    hp: { cur: null, max: null },
    death: { s: 0, f: 0, stable: false },
    money: { rolled: null, left: null },
    wear: 0,
    gear: ['', '', ''],
    backstory: '', notes: '',
    custom: [],   // [{ id, title, tab: 'bio'|'attr', fields: [{ id, label, type, value, max, formula }] }]
    hidden: [],   // core panel keys this sheet hides
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const uid = () => Math.random().toString(36).slice(2, 10);
const signed = n => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '+0');
const money = n => (n == null || n === '' ? '—' : '$' + Number(n).toLocaleString());

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

// Fill in anything the template has that the stored data is missing.
function withDefaults(tpl, data) {
  if (isObj(tpl)) {
    const out = isObj(data) ? { ...data } : {};
    for (const k of Object.keys(tpl)) out[k] = withDefaults(tpl[k], out[k]);
    return out;
  }
  return data === undefined ? clone(tpl) : data;
}
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
function statMod(data, k) {
  const v = data.stats && data.stats[k];
  return v == null ? 0 : (MOD[v] ?? 0);
}
function relTime(iso) {
  const t = Date.parse(trimTs(iso));
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// Postgres sends microseconds; trim to milliseconds before Date.parse.
const trimTs = s => String(s || '').replace(/(\.\d{3})\d+/, '$1');

const DIE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" stroke="none"/></svg>';

// ── State ──────────────────────────────────────────────────────────────────

const S = {
  pass: lsGet('beacon.pass') || '',
  gmPass: lsGet('beacon.gm') || '',
  who: lsGet('beacon.who') || '',
  tab: lsGet('beacon.tab') || 'bio',
  sheets: new Map(),   // id -> { id, data, sort, updated_at }
  rolls: new Map(),    // id -> roll row
  grit: 0,
  since: null,
  ready: false,
  syncing: false,
  route: { view: 'crew' },
  customize: false,
  spec: false,         // next roll: add Specialty +2
  bonus: 0,            // next roll: extra modifier
  logOpen: false,
  seenRolls: new Set(),
  deferRender: false,
  gmNotes: null,
  deleted: null,
};
const pending = new Map(); // `${id}|${path}` -> { id, path, value, timer }

// ── API ────────────────────────────────────────────────────────────────────

async function rpc(fn, args, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    keepalive: !!opts.keepalive,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error((body && body.message) || res.statusText || 'Request failed');
    err.code = body && body.code;
    throw err;
  }
  return body;
}

const ERRORS = {
  bad_password: 'Wrong password.',
  no_grit: 'The Grit pool is empty.',
  not_d6: 'Grit only adds to rolls that use d6s.',
  worn_out: 'At 3 Wear the job has taken everything. Take a break first.',
  cant_reroll: 'Only rolls made from a character sheet can be pushed.',
  too_big: 'That is too big to save. Try a smaller picture.',
  not_found: 'That no longer exists. It may have been deleted.',
};
function fail(err) {
  if (err && err.code === '28P01') return logout('Password changed. Enter it again.');
  toast(ERRORS[err && err.message] || (err && err.message) || 'Something went wrong.', true);
}

// ── Sync ───────────────────────────────────────────────────────────────────

function sheetRecord(rec) {
  const data = withDefaults(blankSheet(), rec.data);
  // Keep what the user typed but hasn't been saved yet.
  for (const p of pending.values()) if (p.id === rec.id) setPath(data, p.path, clone(p.value));
  return { id: rec.id, data, sort: rec.sort, updated_at: rec.updated_at, _json: JSON.stringify(data) };
}

function applySheet(rec) {
  const cur = S.sheets.get(rec.id);
  if (rec.deleted) { if (cur) { S.sheets.delete(rec.id); return true; } return false; }
  if (cur && cur.updated_at >= rec.updated_at) return false;
  const next = sheetRecord(rec);
  S.sheets.set(rec.id, next);
  return !cur || cur._json !== next._json || cur.sort !== next.sort;
}

function applyRoll(r) {
  const cur = S.rolls.get(r.id);
  if (cur && cur.updated_at === r.updated_at) return false;
  S.rolls.set(r.id, r);
  return true;
}

async function sync() {
  if (S.syncing || !S.pass) return;
  S.syncing = true;
  try {
    const since = S.since ? new Date(Date.parse(trimTs(S.since)) - 5000).toISOString() : null;
    const r = await rpc('sync', { p_pass: S.pass, p_since: since });
    S.since = r.now;
    const changed = new Set();
    let rollsChanged = false, gritChanged = false;
    if (r.grit !== S.grit) { S.grit = r.grit; gritChanged = true; }
    for (const rec of r.sheets) if (applySheet(rec)) changed.add(rec.id);
    for (const roll of r.rolls) if (applyRoll(roll)) rollsChanged = true;
    for (const id of [...S.rolls.keys()]) {
      if (r.roll_min == null || id < r.roll_min) { S.rolls.delete(id); rollsChanged = true; }
    }
    if (S.rolls.size > 150) {
      [...S.rolls.keys()].sort((a, b) => a - b).slice(0, S.rolls.size - 150).forEach(k => S.rolls.delete(k));
    }

    if (!S.ready) { S.ready = true; renderApp(); return; }
    if (changed.size) renderNav();
    if (changed.size || gritChanged) refreshMain(changed, gritChanged);
    if (rollsChanged || gritChanged || changed.size) renderLog();
  } catch (err) {
    if (err.code === '28P01') logout('Password changed. Enter it again.');
  } finally {
    S.syncing = false;
  }
}

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) sync(); }, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) sync(); });

// ── Saving edits ───────────────────────────────────────────────────────────

function setLocal(id, path, value) {
  const rec = S.sheets.get(id);
  if (!rec) return;
  setPath(rec.data, path, value);
  rec._json = JSON.stringify(rec.data);
}

// Debounced save of one field.
function queuePatch(id, path, value, delay = 450) {
  const key = id + '|' + path;
  const old = pending.get(key);
  if (old) clearTimeout(old.timer);
  const p = { id, path, value: clone(value) };
  p.timer = setTimeout(() => flushPatch(key, p), delay);
  pending.set(key, p);
  showSaving(true);
}

async function flushPatch(key, p, keepalive = false) {
  try {
    await rpc('patch_sheet', { p_pass: S.pass, p_id: p.id, p_path: p.path.split('.'), p_value: p.value }, { keepalive });
  } catch (err) {
    fail(err);
  } finally {
    if (pending.get(key) === p) pending.delete(key);
    if (!pending.size) showSaving(false);
  }
}

// Immediate save of a whole value (lists, structural changes).
async function commit(id, path, value) {
  for (const [key, p] of pending) {
    if (p.id === id && (p.path === path || p.path.startsWith(path + '.'))) {
      clearTimeout(p.timer);
      pending.delete(key);
    }
  }
  setLocal(id, path, value);
  const key = id + '|' + path;
  const p = { id, path, value: clone(value) };
  pending.set(key, p);
  showSaving(true);
  await flushPatch(key, p);
  sync();
}

window.addEventListener('pagehide', () => {
  for (const [key, p] of pending) { clearTimeout(p.timer); flushPatch(key, p, true); }
});

function showSaving(on) {
  const el = $('#saving');
  if (el) el.textContent = on ? 'Saving…' : 'Saved';
}

// ── Dice ───────────────────────────────────────────────────────────────────

function whoName() {
  if (S.who === 'gm') return 'GM';
  const rec = S.sheets.get(S.who);
  return rec ? rec.data.name : 'Someone';
}

function nextRollExtras() {
  const parts = [];
  let mod = 0;
  if (S.spec) { mod += 2; parts.push('Specialty'); }
  if (S.bonus) { mod += S.bonus; parts.push(signed(S.bonus)); }
  return { mod, label: parts.length ? ' + ' + parts.join(' ') : '' };
}
function resetNextRoll() {
  if (!S.spec && !S.bonus) return;
  S.spec = false; S.bonus = 0;
  const bar = $('.modbar');
  if (bar) bar.outerHTML = modbarHTML();
}

async function roll({ sheetId = null, label, kind = 'check', n = 2, sides = 6, mod = 0, mult = 1, who }) {
  const rec = sheetId && S.sheets.get(sheetId);
  try {
    const r = await rpc('roll', {
      p_pass: S.pass, p_sheet: sheetId, p_who: who || (rec ? rec.data.name : whoName()),
      p_label: label, p_kind: kind, p_n: n, p_sides: sides, p_mod: mod, p_mult: mult,
    });
    applyRoll(r);
    renderLog();
    if (window.matchMedia('(max-width: 1100px)').matches && !S.logOpen) {
      toast(`${r.who} · ${r.label}: ${r.total}${isDoubles(r) ? ' · doubles!' : ''}`);
    }
    sync();
    return r;
  } catch (err) { fail(err); return null; }
}

const isDoubles = r => r.sides === 6 && r.dice.length === 2 && r.dice[0] === r.dice[1];

function parseFormula(str, data) {
  const s = String(str || '').toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d*)d(\d+)(.*)$/);
  if (!m) return null;
  const n = +(m[1] || 1), sides = +m[2];
  const parts = m[3].match(/[+-][^+-]+/g) || [];
  if (parts.join('') !== m[3]) return null;
  let mod = 0;
  for (const p of parts) {
    const sign = p[0] === '-' ? -1 : 1, t = p.slice(1);
    if (/^\d+$/.test(t)) { mod += sign * +t; continue; }
    if (t === 'spec' || t === 'specialty') { mod += sign * 2; continue; }
    const st = STATS.find(x => x.a.includes(t));
    if (st && data) { mod += sign * statMod(data, st.k); continue; }
    return null;
  }
  if (n < 1 || n > 30 || sides < 2 || sides > 1000) return null;
  return { n, sides, mod };
}

// ── Rendering: shell ───────────────────────────────────────────────────────

const app = $('#app');

function renderGate(msg) {
  clearInterval(pollTimer);
  app.innerHTML = `
    <div class="gate">
      <form id="gate-form" autocomplete="on">
        <div class="logo-die"><i></i><i></i><i></i></div>
        <h1>BEACON</h1>
        <p>Crew sheets, dice and the Grit pool.</p>
        <div class="field stack">
          <label for="gate-pass">Crew password</label>
          <input id="gate-pass" type="password" autocomplete="current-password" required autofocus>
        </div>
        <button class="btn brass" type="submit">Enter</button>
        <p class="err" id="gate-err">${esc(msg || '')}</p>
      </form>
    </div>`;
  $('#gate-form').onsubmit = async e => {
    e.preventDefault();
    const pass = $('#gate-pass').value;
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const role = await rpc('check_pass', { p_pass: pass });
      if (!role) throw Object.assign(new Error('bad_password'), { code: 'bad' });
      S.pass = pass; lsSet('beacon.pass', pass);
      if (role === 'gm') { S.gmPass = pass; lsSet('beacon.gm', pass); }
      boot();
    } catch (err) {
      $('#gate-err').textContent = err.message === 'bad_password' ? 'That’s not the password.' : 'Couldn’t reach the server. Try again.';
      btn.disabled = false; btn.textContent = 'Enter';
    }
  };
}

function logout(msg) {
  S.pass = ''; lsSet('beacon.pass', null);
  S.ready = false; S.since = null; S.sheets.clear(); S.rolls.clear();
  renderGate(msg);
}

function renderApp() {
  app.innerHTML = `
    <header class="top">
      <a class="brand" href="#/crew">BEACON</a>
      <nav class="nav" id="nav"></nav>
      <label class="who">Playing as <select id="who-select" aria-label="Playing as"></select></label>
    </header>
    <div class="layout">
      <main class="main" id="main"></main>
      <aside class="log" id="log" aria-label="Dice log"></aside>
    </div>
    <button class="log-fab" id="log-fab" data-act="log-toggle" aria-label="Open dice log">${DIE_SVG.replace('<svg', '<svg width="22" height="22"')}<span id="fab-last"></span></button>
    <datalist id="dl-skills">${Object.values(SKILLS).flat().map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <datalist id="dl-vice">${VICES.map(s => `<option value="${s}">`).join('')}</datalist>
    <datalist id="dl-virtue">${VIRTUES.map(s => `<option value="${s}">`).join('')}</datalist>
    <input type="file" id="file-portrait" accept="image/*" hidden>
    <input type="file" id="file-import" accept="application/json,.json" hidden>`;
  renderNav();
  renderMain();
  renderLog();
}

function orderedSheets() {
  return [...S.sheets.values()].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}
function accentOf(rec) {
  if (rec.data.accent) return rec.data.accent;
  const i = orderedSheets().findIndex(r => r.id === rec.id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const r = S.route;
  nav.innerHTML = [
    `<a href="#/crew" class="${r.view === 'crew' ? 'on' : ''}">Crew</a>`,
    ...orderedSheets().map(rec =>
      `<a href="#/c/${rec.id}" class="${r.view === 'sheet' && r.id === rec.id ? 'on' : ''}">
         <span class="sw" style="background:${esc(accentOf(rec))}"></span>${esc(rec.data.name || 'Unnamed')}</a>`),
    `<a href="#" class="add" data-act="new-sheet">+ New</a>`,
    `<a href="#/rules" class="${r.view === 'rules' ? 'on' : ''}">Rules</a>`,
    `<a href="#/gm" class="${r.view === 'gm' ? 'on' : ''}">GM</a>`,
  ].join('');
  const sel = $('#who-select');
  sel.innerHTML = `<option value="">Watching</option>` +
    orderedSheets().map(rec => `<option value="${rec.id}">${esc(rec.data.name || 'Unnamed')}</option>`).join('') +
    `<option value="gm">GM</option>`;
  sel.value = S.who && (S.who === 'gm' || S.sheets.has(S.who)) ? S.who : '';
}

// Re-render the main view without losing the caret in the field being typed in.
function renderMain() {
  const main = $('#main');
  if (!main) return;
  const a = document.activeElement;
  const key = a && main.contains(a) && (a.dataset.bind || a.dataset.fk);
  let s0 = null, s1 = null;
  try { s0 = a.selectionStart; s1 = a.selectionEnd; } catch { /* not a text field */ }

  const r = S.route;
  if (r.view === 'sheet' && S.sheets.has(r.id)) main.innerHTML = sheetHTML(S.sheets.get(r.id));
  else if (r.view === 'rules') main.innerHTML = rulesHTML();
  else if (r.view === 'gm') { main.innerHTML = gmHTML(); if (gmOK() && S.gmNotes === null) loadGM(); }
  else main.innerHTML = crewHTML();
  S.deferRender = false;

  if (key) {
    const el = main.querySelector(`[data-bind="${CSS.escape(key)}"], [data-fk="${CSS.escape(key)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      try { if (s0 != null) el.setSelectionRange(s0, s1); } catch { /* selects etc. */ }
    }
  }
}

function typingInMain() {
  const a = document.activeElement, main = $('#main');
  return !!(a && main && main.contains(a)) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|number|search|)$/.test(a.type)));
}

function refreshMain(changed, gritChanged) {
  const r = S.route;
  if (r.view === 'sheet') {
    if (!S.sheets.has(r.id)) { location.hash = '#/crew'; return; }
    if (!changed.has(r.id) && !gritChanged) return;
    if (typingInMain()) {
      // Update the other fields in place; rebuild once the user leaves this field.
      const data = S.sheets.get(r.id).data;
      $('#main').querySelectorAll('[data-bind]').forEach(el => {
        if (el === document.activeElement) return;
        const v = getPath(data, el.dataset.bind);
        if (el.type === 'checkbox') el.checked = !!v;
        else { const s = v == null ? '' : String(v); if (el.value !== s) el.value = s; }
      });
      S.deferRender = true;
      return;
    }
    renderMain();
  } else if (r.view === 'crew') {
    if (typingInMain()) { S.deferRender = true; return; }
    renderMain();
  }
}
document.addEventListener('focusout', () => {
  setTimeout(() => { if (S.deferRender && !typingInMain()) renderMain(); }, 0);
});

// ── Rendering: crew board ──────────────────────────────────────────────────

function pipsHTML(count, filled, act, extra = '', cls = '') {
  let h = `<div class="pips ${cls}">`;
  for (let i = 1; i <= count; i++) {
    h += `<button type="button" class="pip ${i <= filled ? 'on' : ''}" data-act="${act}" data-n="${i}" ${extra} aria-label="${i}" aria-pressed="${i <= filled}"></button>`;
  }
  return h + '</div>';
}

function avatarHTML(rec, lg) {
  const d = rec.data;
  const style = `--accent:${esc(accentOf(rec))};${d.portrait ? `background-image:url('${esc(d.portrait)}')` : ''}`;
  return `<div class="avatar ${lg ? 'lg' : ''}" style="${style}">${d.portrait ? '' : esc((d.name || '?').trim().charAt(0).toUpperCase())}</div>`;
}

function crewHTML() {
  const sheets = orderedSheets();
  const cards = sheets.map(rec => {
    const d = rec.data;
    const cur = d.hp.cur, max = d.hp.max;
    const pct = max ? Math.max(0, Math.min(100, (cur ?? 0) / max * 100)) : 0;
    return `
      <section class="panel card" style="--accent:${esc(accentOf(rec))}" data-sheet="${rec.id}">
        <a class="card-head" href="#/c/${rec.id}">
          ${avatarHTML(rec)}
          <div>
            <div class="card-name">${esc(d.name || 'Unnamed')}</div>
            <div class="meta">${esc([d.job, d.player && 'played by ' + d.player].filter(Boolean).join(' · ') || 'No job yet')}</div>
          </div>
        </a>
        <div>
          <div class="line">
            <span class="k">HP</span>
            <span class="row">
              <button class="icon-btn" data-act="hp-step" data-d="-1" aria-label="Lose 1 HP">−</button>
              <span>${cur ?? '—'} / ${max ?? '—'}</span>
              <button class="icon-btn" data-act="hp-step" data-d="1" aria-label="Gain 1 HP">+</button>
            </span>
          </div>
          ${max ? `<div class="hpbar ${pct <= 25 ? 'low' : ''}"><i style="width:${pct}%"></i></div>` : ''}
        </div>
        <div class="line"><span class="k">Wear</span>${pipsHTML(3, d.wear, 'wear-set', '', 'red sm')}</div>
        <div class="line"><span class="k">Money left</span><span>${money(d.money.left)}</span></div>
        <div class="line"><span class="k">Specialty</span><span class="dim">${esc(d.specialty || '—')}</span></div>
        <div class="chips">
          ${d.vice ? `<span class="chip vice">${esc(d.vice)}</span>` : ''}
          ${d.virtue ? `<span class="chip virtue">${esc(d.virtue)}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn sm" data-act="grit-vv" data-name="${esc(d.name)}" title="Acted on their Vice or Virtue">+1 Grit</button>
        </div>
      </section>`;
  }).join('');

  return `
    <div class="wrap">
      <div class="grid">
        <section class="panel s7">
          <h2>Grit: shared pool</h2>
          <div class="row between">
            <div class="grit-count" aria-live="polite">${S.grit}<small> / 10</small></div>
            <div class="row">
              <button class="btn" data-act="grit-adj" data-d="-1" aria-label="Remove 1 Grit">−</button>
              <button class="btn" data-act="grit-adj" data-d="1" aria-label="Add 1 Grit">+</button>
              <button class="btn brass" data-act="grit-session">${DIE_SVG.replace('<svg', '<svg width="16" height="16"')} Session roll 1d6</button>
            </div>
          </div>
          <div style="margin-top:14px">${pipsHTML(10, S.grit, 'grit-set', '', 'big')}</div>
          <p class="note">Spend 1 Grit to roll 1d6 and add it to any d6 roll, yours or anyone else’s, even after seeing the result. Use the Grit button on a roll in the dice log. Regain 1 when a player acts on their Vice or Virtue.</p>
        </section>
        <section class="panel s5">
          <h2>Quick rules</h2>
          <p class="small"><span class="hl">Wear</span> Mark 1 whenever you roll doubles (done for you). Mark 1 to reroll any roll. At 3, no more pushing until you take a break.</p>
          <p class="small"><span class="hl">Specialty +2</span> to the one thing you’re known for, when the GM says it applies.</p>
          <p class="small"><span class="hl">Dropping</span> at 0 HP: roll 2d6 + Composure each round. 10+ stable, 7–9 success, 6− fail. Three of either decides it.</p>
          <p class="small dim" style="margin:0"><a href="#/rules">Full crew rules</a></p>
        </section>
      </div>
      <div class="row between" style="margin:26px 0 12px">
        <h1 class="page-title" style="margin:0">The crew</h1>
        <div class="row">
          <button class="btn ghost sm" data-act="import">Import JSON</button>
        </div>
      </div>
      <div class="cards">
        ${cards}
        <button class="new-card" data-act="new-sheet"><span style="font-size:30px">+</span>New character</button>
      </div>
    </div>`;
}

// ── Rendering: character sheet ─────────────────────────────────────────────

function panel(rec, key, cls, body, extraHead = '') {
  const hidden = rec.data.hidden.includes(key);
  if (hidden && !S.customize) return '';
  const toggle = S.customize
    ? `<button class="btn sm ghost" data-act="panel-toggle" data-k="${key}">${hidden ? 'Show' : 'Hide'}</button>` : '';
  return `
    <section class="panel ${cls}" style="${hidden ? 'opacity:.45' : ''}">
      <h2><span class="grow">${PANELS[key]}</span>${extraHead}${toggle}</h2>
      ${body}
    </section>`;
}

function field(label, path, data, attrs = '') {
  const v = getPath(data, path);
  return `<div class="field"><label>${label}</label><input data-bind="${path}" value="${esc(v)}" ${attrs}></div>`;
}

function modbarHTML() {
  return `
    <div class="modbar">
      <span class="lbl">Next roll</span>
      <button class="btn sm ${S.spec ? 'on' : ''}" data-act="toggle-spec" aria-pressed="${S.spec}">Specialty +2</button>
      <span class="lbl">Bonus</span>
      <span class="stepper">
        <button data-act="bonus" data-d="-1" aria-label="Lower bonus">−</button><b>${signed(S.bonus)}</b><button data-act="bonus" data-d="1" aria-label="Raise bonus">+</button>
      </span>
      <span class="spacer"></span>
      <span class="small dim">Click a stat or skill to roll 2d6 + mod</span>
    </div>`;
}

function sheetHTML(rec) {
  const d = rec.data;
  const tab = S.tab === 'attr' ? 'attr' : 'bio';
  const hiddenBar = S.customize ? `
    <div class="hidden-bar">
      <b class="hl">Customizing</b>
      <span>Hide or show panels, rename and add your own sections and fields.</span>
      <span class="spacer"></span>
      <button class="btn sm brass" data-act="customize">Done</button>
    </div>` : '';

  const body = tab === 'bio' ? bioTab(rec) : attrTab(rec);
  return `
    <div class="wrap ${S.customize ? 'customizing' : ''}" data-sheet="${rec.id}" style="--accent:${esc(accentOf(rec))}">
      <section class="panel">
        <div class="sheet-head">
          <button class="portrait-btn" data-act="portrait" aria-label="Change portrait">${avatarHTML(rec, true)}<span>Change</span></button>
          <div class="sheet-id">
            <input class="name-input" data-bind="name" value="${esc(d.name)}" aria-label="Character name" placeholder="Name">
            <div class="row">
              <input data-bind="player" value="${esc(d.player)}" placeholder="Player" aria-label="Player" style="max-width:220px">
              <span class="saving" id="saving"></span>
            </div>
          </div>
          <div class="sheet-tools">
            <label class="row small dim" title="Sheet colour">Colour <input type="color" data-bind="accent" value="${esc(accentOf(rec))}"></label>
            <button class="btn sm ${S.customize ? 'on' : ''}" data-act="customize">Customize</button>
            <button class="btn sm ghost" data-act="duplicate">Duplicate</button>
            <button class="btn sm ghost" data-act="export">Export</button>
            <button class="btn sm danger" data-act="delete">Delete</button>
          </div>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" class="${tab === 'bio' ? 'on' : ''}" aria-selected="${tab === 'bio'}" data-act="tab" data-t="bio">Bio &amp; Info</button>
        <button role="tab" class="${tab === 'attr' ? 'on' : ''}" aria-selected="${tab === 'attr'}" data-act="tab" data-t="attr">Attributes &amp; Abilities</button>
      </div>
      ${hiddenBar}
      ${tab === 'attr' ? modbarHTML() : ''}
      <div class="grid">${body}</div>
    </div>`;
}

function bioTab(rec) {
  const d = rec.data;
  const gear = d.gear.map((g, i) => `
    <div class="gear-row">
      <span class="n">${i + 1}.</span>
      <input data-bind="gear.${i}" value="${esc(g)}" aria-label="Gear slot ${i + 1}">
      <button class="icon-btn" data-act="gear-del" data-i="${i}" aria-label="Remove slot ${i + 1}">×</button>
    </div>`).join('');
  return [
    panel(rec, 'identity', 's6', `
      ${field('Job', 'job', d)}
      ${field('Specialty (+2)', 'specialty', d, 'placeholder="The one thing you’re known for"')}
      ${field('Vice', 'vice', d, 'list="dl-vice" placeholder="Pick or write one"')}
      ${field('Virtue', 'virtue', d, 'list="dl-virtue" placeholder="Pick or write one"')}
      <div class="row between note">
        <span>Act on your Vice or Virtue: the crew gains +1 Grit.</span>
        <button class="btn sm" data-act="grit-vv" data-name="${esc(d.name)}">+1 Grit</button>
      </div>`),
    panel(rec, 'look', 's6', `
      ${field('Height', 'look.height', d)}
      ${field('Skin', 'look.skin', d)}
      ${field('Hair', 'look.hair', d)}
      ${field('Eyes', 'look.eyes', d)}
      ${field('Unique markings', 'look.markings', d)}`),
    panel(rec, 'money', 's5', `
      <div class="field"><label>Rolled $</label><input type="number" data-type="num" data-bind="money.rolled" value="${esc(d.money.rolled)}"></div>
      <div class="field"><label>Left $</label><input type="number" data-type="num" data-bind="money.left" value="${esc(d.money.left)}"></div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="roll-money">${DIE_SVG.replace('<svg', '<svg width="16" height="16"')} Roll 2d6 × $60</button>
      </div>
      <p class="note">Rolling sets both Rolled and Left. Grit may be used if you want.</p>`),
    panel(rec, 'gear', 's7', `
      <p class="small dim" style="margin-top:-6px">${d.gear.length} slots · 3 to start, more can be earned.</p>
      ${gear}
      <button class="btn sm" data-act="gear-add">+ Add slot</button>`),
    panel(rec, 'backstory', 's12', `
      <p class="small dim" style="margin-top:-6px">This is how you earn a Specialty.</p>
      <textarea data-bind="backstory" rows="6" aria-label="Backstory">${esc(d.backstory)}</textarea>`),
    panel(rec, 'notes', 's12', `<textarea data-bind="notes" rows="5" aria-label="Notes">${esc(d.notes)}</textarea>`),
    customSections(rec, 'bio'),
  ].join('');
}

function attrTab(rec) {
  const d = rec.data;
  const vals = STATS.map(s => d.stats[s.k]);
  const assigned = vals.filter(v => v != null);
  const spreadOK = assigned.length === 6 && [...assigned].sort((a, b) => b - a).join(',') === STAT_SPREAD;
  const statRows = STATS.map(s => {
    const v = d.stats[s.k], m = statMod(d, s.k);
    return `
      <div class="stat-row">
        <button class="stat-name" data-act="roll-stat" data-k="${s.k}" title="Roll 2d6 ${signed(m)}">${s.n}</button>
        <select data-bind="stats.${s.k}" data-type="num" aria-label="${s.n} score">
          <option value="" ${v == null ? 'selected' : ''}>—</option>
          ${[4, 3, 2, 1].map(n => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <span class="mod-badge ${m > 0 ? 'pos' : m < 0 ? 'neg' : ''}" title="Modifier">${v == null ? '—' : signed(m)}</span>
        <button class="roll-btn" data-act="roll-stat" data-k="${s.k}" aria-label="Roll ${s.n}">${DIE_SVG}</button>
      </div>`;
  }).join('');

  const sk = d.skills;
  const bonuses = sk.map(x => +x.bonus || 0);
  const skillsOK = (sk.length === 3 && bonuses.every(b => b === 1)) || (sk.length === 2 && bonuses.every(b => b === 2));
  const skillRows = sk.map((x, i) => {
    const total = statMod(d, x.stat) + (+x.bonus || 0);
    return `
      <div class="skill-row">
        <input data-bind="skills.${i}.name" value="${esc(x.name)}" list="dl-skills" placeholder="Skill" aria-label="Skill name">
        <select class="skill-stat" data-bind="skills.${i}.stat" aria-label="Stat for this skill">
          ${STATS.map(s => `<option value="${s.k}" ${x.stat === s.k ? 'selected' : ''}>${s.n}</option>`).join('')}
        </select>
        <select data-bind="skills.${i}.bonus" data-type="num" aria-label="Skill bonus">
          ${[0, 1, 2, 3].map(n => `<option value="${n}" ${(+x.bonus || 0) === n ? 'selected' : ''}>+${n}</option>`).join('')}
        </select>
        <button class="roll-btn" data-act="roll-skill" data-i="${i}" title="Roll 2d6 ${signed(total)}" aria-label="Roll ${esc(x.name || 'skill')}">${DIE_SVG}</button>
        <button class="icon-btn" data-act="skill-del" data-i="${i}" aria-label="Remove skill">×</button>
      </div>`;
  }).join('');

  const hp = d.hp, dying = hp.cur != null && hp.cur <= 0;
  const de = d.death;
  const deathState = de.f >= 3 ? '<span class="warn">Dead.</span>'
    : de.stable ? '<span class="ok">Stable. Out, but you’ll live.</span>'
    : dying ? 'Dying. Roll again next round.' : 'Not dropping.';

  return [
    panel(rec, 'stats', 's6', `
      <p class="small dim" style="margin-top:-6px">Assign 4, 3, 3, 2, 2, 1 · 4 = +2 · 3 = +1 · 2 = +0 · 1 = −1</p>
      ${statRows}
      <p class="check-line ${spreadOK ? 'ok' : 'dim'}">${spreadOK ? '✓ Matches 4, 3, 3, 2, 2, 1' : assigned.length ? 'Current: ' + vals.map(v => v ?? '—').join(', ') + ' · should be 4, 3, 3, 2, 2, 1' : 'No stats assigned yet'}</p>`),
    panel(rec, 'skills', 's6', `
      <p class="small dim" style="margin-top:-6px">Pick 3 at +1 or 2 at +2. Roll uses the stat that fits.</p>
      ${skillRows || '<p class="dim small">No skills yet.</p>'}
      <div class="row between" style="margin-top:10px">
        <button class="btn sm" data-act="skill-add">+ Add skill</button>
        <span class="check-line ${skillsOK ? 'ok' : 'dim'}" style="margin:0">${skillsOK ? '✓ Fits the rules' : sk.length ? 'Usually 3 at +1 or 2 at +2' : ''}</span>
      </div>`),
    panel(rec, 'hp', 's4', `
      <div class="hp-big">
        <input type="number" data-type="num" data-bind="hp.cur" value="${esc(hp.cur)}" aria-label="Current HP">
        <span class="of">/</span>
        <input type="number" data-type="num" data-bind="hp.max" value="${esc(hp.max)}" aria-label="Max HP">
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn sm" data-act="hp-step" data-d="-1">−1</button>
        <button class="btn sm" data-act="hp-step" data-d="1">+1</button>
        <span class="spacer"></span>
        <button class="btn sm" data-act="roll-hp">${DIE_SVG.replace('<svg', '<svg width="14" height="14"')} 2d6 + 6</button>
      </div>
      <p class="note">Rolling sets current and max HP.</p>`),
    panel(rec, 'dying', 's4 ' + (dying && !de.stable && de.f < 3 ? 'dying' : ''), `
      <button class="btn ${dying ? 'brass' : ''}" data-act="roll-death" style="width:100%">${DIE_SVG.replace('<svg', '<svg width="16" height="16"')} Roll 2d6 + Composure</button>
      <div class="row between" style="margin-top:12px"><span class="small dim">Successes</span>${pipsHTML(3, de.s, 'death-set', 'data-k="s"', 'green sm')}</div>
      <div class="row between" style="margin-top:8px"><span class="small dim">Fails</span>${pipsHTML(3, de.f, 'death-set', 'data-k="f"', 'red sm')}</div>
      <p class="small" style="margin:10px 0 0">${deathState}</p>
      <p class="note">10+ stable · 7–9 success · 6− fail. <button class="btn sm ghost" data-act="death-reset" style="margin-left:4px">Reset</button></p>`),
    panel(rec, 'wear', 's4', `
      ${pipsHTML(3, d.wear, 'wear-set', '', 'red big')}
      <p class="small" style="margin:12px 0 0">Doubles mark 1 Wear automatically. Push a roll from the dice log to mark 1 and reroll.</p>
      ${d.wear >= 3 ? '<p class="small warn" style="margin:8px 0 0">The job has taken everything. No more pushing until you take a break.</p>' : ''}
      <div class="row" style="margin-top:10px"><button class="btn sm" data-act="wear-clear" ${d.wear ? '' : 'disabled'}>Took a break · clear</button></div>`),
    customSections(rec, 'attr'),
  ].join('');
}

function customSections(rec, tab) {
  const d = rec.data;
  const list = d.custom.map((sec, si) => ({ sec, si })).filter(x => (x.sec.tab || 'bio') === tab);
  const html = list.map(({ sec, si }) => S.customize ? customEditHTML(rec, sec, si) : customViewHTML(rec, sec, si)).join('');
  const add = S.customize
    ? `<div class="s12"><button class="btn" data-act="cs-add" data-t="${tab}">+ Add section to this tab</button></div>`
    : '';
  return html + add;
}

function customViewHTML(rec, sec, si) {
  const fields = (sec.fields || []).map((f, fi) => {
    const p = `custom.${si}.fields.${fi}.value`;
    const label = esc(f.label || 'Untitled');
    switch (f.type) {
      case 'long':
        return `<div class="cfield"><span class="lbl">${label}</span><textarea data-bind="${p}" rows="4">${esc(f.value)}</textarea></div>`;
      case 'number':
        return `<div class="cfield row between"><span class="lbl" style="margin:0">${label}</span>
          <span class="counter"><button class="icon-btn" data-act="cf-step" data-si="${si}" data-fi="${fi}" data-d="-1" aria-label="Lower">−</button>
          <input type="number" data-type="num" data-bind="${p}" value="${esc(f.value)}" aria-label="${label}">
          <button class="icon-btn" data-act="cf-step" data-si="${si}" data-fi="${fi}" data-d="1" aria-label="Raise">+</button></span></div>`;
      case 'check':
        return `<label class="cfield row"><input type="checkbox" data-bind="${p}" ${f.value ? 'checked' : ''}> ${label}</label>`;
      case 'track':
        return `<div class="cfield row between"><span class="lbl" style="margin:0">${label}</span>
          ${pipsHTML(Math.max(1, Math.min(20, +f.max || 3)), +f.value || 0, 'cf-track', `data-si="${si}" data-fi="${fi}"`, 'sm')}</div>`;
      case 'roll':
        return `<div class="cfield"><button class="btn" data-act="cf-roll" data-si="${si}" data-fi="${fi}">${DIE_SVG.replace('<svg', '<svg width="16" height="16"')} ${label} <span class="dim">${esc(f.formula || '')}</span></button></div>`;
      default:
        return `<div class="cfield"><span class="lbl">${label}</span><input data-bind="${p}" value="${esc(f.value)}" aria-label="${label}"></div>`;
    }
  }).join('');
  return `
    <section class="panel s6">
      <h2>${esc(sec.title || 'Untitled section')}</h2>
      ${fields || '<p class="small dim">No fields yet. Use Customize to add some.</p>'}
    </section>`;
}

function customEditHTML(rec, sec, si) {
  const n = rec.data.custom.length;
  const fields = (sec.fields || []).map((f, fi) => {
    const base = `custom.${si}.fields.${fi}`;
    const extra = f.type === 'track'
      ? `<input type="number" data-type="num" data-bind="${base}.max" value="${esc(f.max ?? 3)}" placeholder="Boxes" aria-label="Number of boxes">`
      : f.type === 'roll'
        ? `<input data-bind="${base}.formula" value="${esc(f.formula || '')}" placeholder="e.g. 2d6+dex+2" aria-label="Roll formula">`
        : '<span></span>';
    return `
      <div class="cfield-edit">
        <input data-bind="${base}.label" value="${esc(f.label)}" placeholder="Field name" aria-label="Field name">
        <select data-bind="${base}.type" aria-label="Field type">
          ${Object.entries(FIELD_TYPES).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        ${extra}
        <span class="row" style="gap:2px">
          <button class="icon-btn" data-act="cf-move" data-si="${si}" data-fi="${fi}" data-d="-1" aria-label="Move up">↑</button>
          <button class="icon-btn" data-act="cf-move" data-si="${si}" data-fi="${fi}" data-d="1" aria-label="Move down">↓</button>
          <button class="icon-btn" data-act="cf-del" data-si="${si}" data-fi="${fi}" aria-label="Delete field">×</button>
        </span>
      </div>`;
  }).join('');
  return `
    <section class="panel s12">
      <div class="row" style="margin-bottom:12px">
        <input data-bind="custom.${si}.title" value="${esc(sec.title)}" placeholder="Section title" aria-label="Section title" style="flex:1;min-width:160px;font-family:var(--slab);font-size:18px">
        <select data-bind="custom.${si}.tab" aria-label="Which tab" style="width:auto">
          <option value="bio" ${sec.tab !== 'attr' ? 'selected' : ''}>Bio &amp; Info tab</option>
          <option value="attr" ${sec.tab === 'attr' ? 'selected' : ''}>Attributes tab</option>
        </select>
        <button class="icon-btn" data-act="cs-move" data-si="${si}" data-d="-1" ${si === 0 ? 'disabled' : ''} aria-label="Move section up">↑</button>
        <button class="icon-btn" data-act="cs-move" data-si="${si}" data-d="1" ${si === n - 1 ? 'disabled' : ''} aria-label="Move section down">↓</button>
        <button class="btn sm danger" data-act="cs-del" data-si="${si}">Delete section</button>
      </div>
      ${fields}
      <button class="btn sm" data-act="cf-add" data-si="${si}">+ Add field</button>
      <p class="note">Roll formulas: dice plus numbers or stats, like <b>2d6+wits</b>, <b>1d20+2</b>, <b>2d6+dex+spec</b>.</p>
    </section>`;
}

// ── Rendering: rules & GM ──────────────────────────────────────────────────

function rulesHTML() {
  return `
    <div class="wrap rules">
      <h1 class="page-title">Crew rules</h1>
      <div class="grid">
        <section class="panel s6">
          <h2>Stats</h2>
          <p>Assign 4, 3, 3, 2, 2, 1 across your six stats.</p>
          <div class="mods">
            <div><b class="ok">+2</b><span>4</span></div><div><b class="ok">+1</b><span>3</span></div>
            <div><b>0</b><span>2</span></div><div><b class="warn">−1</b><span>1</span></div>
          </div>
        </section>
        <section class="panel s3"><h2>HP</h2><div class="big-rule">2d6 + 6</div><p class="dim small">Grit may be used if you want.</p></section>
        <section class="panel s3"><h2>Specialty</h2><div class="big-rule">+2</div><p class="dim small">To one thing you’re known for, based on your backstory. Applies when the GM decides.</p></section>
        <section class="panel s6">
          <h2>Dropping</h2>
          <p>You drop. You roll 2d6 + Composure.</p>
          <p><span class="hl">10+</span> you’re stable. You’re out, but you’ll live.<br>
             <span class="hl">7–9</span> mark a success. Roll again next round.<br>
             <span class="hl">6−</span> mark a fail. Roll again next round.</p>
          <p class="dim">Three successes and you stabilize: unconscious but alive. Three fails and you’re dead.</p>
        </section>
        <section class="panel s6">
          <h2>Moneys</h2>
          <p>Roll 2d6 × $60.</p><p class="dim small">Grit may be used if you want.</p>
          <h2 style="margin-top:18px">Wear: reroll, max 3</h2>
          <p>The job grinds you down. Mark 1 Wear whenever you roll <span class="hl">doubles</span>. Spend 1 Wear to <span class="hl">reroll</span> any roll.</p>
          <p class="warn">At 3 Wear the job has taken everything. No more pushing until you take a break.</p>
        </section>
        <section class="panel s6">
          <h2>Grit: shared pool</h2>
          <p>Roll <span class="hl">1d6</span> at session start.</p>
          <p>Spend 1 Grit to roll <span class="hl">1d6</span> and add it to any roll that uses d6s, yours or anyone else’s. You can spend it after seeing the result.</p>
          <p class="dim">Regain 1 Grit when a player acts on their Vice or Virtue.</p>
        </section>
        <section class="panel s6">
          <h2>Vice &amp; Virtue</h2>
          <div class="vv">
            <div class="vice"><h3>Vice</h3><ul>${VICES.map(v => `<li>${v}</li>`).join('')}</ul></div>
            <div class="virtue"><h3>Virtue</h3><ul>${VIRTUES.map(v => `<li>${v}</li>`).join('')}</ul></div>
          </div>
          <p class="note">Act on your Vice or Virtue and the crew gains +1 Grit.</p>
        </section>
        <section class="panel s12">
          <h2>Skills: roll the stat that fits</h2>
          <p class="small"><span class="hl">Pick 3 at +1</span> or <span class="hl">pick 2 at +2</span>, your choice.</p>
          <div class="sk">${STATS.map(s => `<div><b>${s.n}</b>${SKILLS[s.k].join(', ')}</div>`).join('')}</div>
        </section>
      </div>
    </div>`;
}

function gmOK() { return !!S.gmPass; }

function gmHTML() {
  if (!gmOK()) {
    return `
      <div class="wrap" style="max-width:460px">
        <h1 class="page-title">GM</h1>
        <form class="panel" id="gm-form">
          <h2>GM password</h2>
          <p class="small dim" style="margin-top:-4px">GM notes stay hidden from the crew.</p>
          <input type="password" id="gm-pass" autocomplete="off" aria-label="GM password">
          <div class="row" style="margin-top:12px"><button class="btn brass" type="submit">Unlock</button><span class="warn small" id="gm-err"></span></div>
        </form>
      </div>`;
  }
  const deleted = S.deleted || [];
  return `
    <div class="wrap">
      <div class="row between"><h1 class="page-title">GM</h1><button class="btn sm ghost" data-act="gm-lock">Lock</button></div>
      <div class="grid">
        <section class="panel s8">
          <h2><span class="grow">GM notes</span><span class="saving" id="gm-saving"></span></h2>
          <textarea id="gm-notes" data-fk="gm-notes" rows="18" placeholder="Only people with the GM password can see this." aria-label="GM notes">${esc(S.gmNotes === null ? '' : S.gmNotes)}</textarea>
          ${S.gmNotes === null ? '<p class="small dim">Loading…</p>' : ''}
        </section>
        <div class="s4" style="display:grid;gap:16px;align-content:start">
          <section class="panel">
            <h2>Dice log</h2>
            <p class="small dim" style="margin-top:-4px">Wipes every roll for everyone.</p>
            <button class="btn danger" data-act="gm-clear">Clear dice log</button>
          </section>
          <section class="panel">
            <h2>Deleted characters</h2>
            ${deleted.length ? deleted.map(x => `
              <div class="row between" style="padding:6px 0;border-bottom:1px dashed var(--line)">
                <span>${esc(x.name || 'Unnamed')}</span>
                <button class="btn sm" data-act="gm-restore" data-id="${x.id}">Restore</button>
              </div>`).join('') : '<p class="small dim">None.</p>'}
          </section>
          <section class="panel">
            <h2>Passwords</h2>
            <p class="small">Change them in the Supabase SQL editor:</p>
            <p class="small dim" style="word-break:break-word">select private.set_secret('entry', '…');<br>select private.set_secret('gm', '…');</p>
          </section>
        </div>
      </div>
    </div>`;
}

async function loadGM() {
  try {
    const [notes, deleted] = await Promise.all([
      rpc('gm_get_notes', { p_gm: S.gmPass }),
      rpc('gm_deleted_sheets', { p_gm: S.gmPass }),
    ]);
    S.gmNotes = notes.body; S.deleted = deleted;
    if (S.route.view === 'gm') renderMain();
  } catch (err) {
    if (err.code === '28P01') { S.gmPass = ''; lsSet('beacon.gm', null); if (S.route.view === 'gm') renderMain(); }
    else fail(err);
  }
}

// ── Rendering: dice log ────────────────────────────────────────────────────

function entryHTML(r) {
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  const accent = rec ? accentOf(rec) : 'var(--line)';
  const dbl = isDoubles(r);
  const dice = r.dice.map(v => `<span class="die ${dbl ? 'dbl' : ''}">${v}</span>`).join('<span class="op">+</span>');
  const grit = (r.extras || []).map(e => `<span class="op">+</span><span class="die grit" title="Grit from ${esc(e.who)}">${e.die}</span>`).join('');
  const mod = r.modifier ? `<span class="op">${r.modifier > 0 ? '+' : '−'} ${Math.abs(r.modifier)}</span>` : '';
  const mult = r.mult > 1 ? `<span class="op">× $${r.mult}</span>` : '';
  const nd = r.dice.length;

  const tags = [];
  if (!(nd === 2 && r.sides === 6) && !(nd === 1 && r.sides === 6)) tags.push(`<span class="tag">${nd}d${r.sides}</span>`);
  if (dbl && r.kind !== 'hp' && r.kind !== 'money' && r.kind !== 'grit_session') tags.push('<span class="tag red">Doubles</span>');
  if (r.wear_marked) tags.push(`<span class="tag red">+${r.wear_marked} Wear marked</span>`);
  if (r.rerolls) tags.push(`<span class="tag">Pushed${r.rerolls > 1 ? ' ×' + r.rerolls : ''}</span>`);
  for (const e of r.extras || []) tags.push(`<span class="tag brass">Grit +${e.die} from ${esc(e.who)}</span>`);
  if (r.kind === 'death') {
    tags.push(r.total >= 10 ? '<span class="tag green">Stable</span>' : r.total >= 7 ? '<span class="tag green">Success</span>' : '<span class="tag red">Fail</span>');
  }
  if (r.kind === 'grit_session') tags.push('<span class="tag brass">Grit pool set</span>');

  const canGrit = r.sides === 6 && S.grit > 0 && r.kind !== 'grit_session';
  const canPush = rec && ['check', 'death', 'free'].includes(r.kind) && rec.data.wear < 3;
  const actions = (canGrit || canPush) ? `
    <div class="entry-actions">
      ${canGrit ? `<button class="btn" data-act="spend-grit" data-id="${r.id}">+ Grit (1d6)</button>` : ''}
      ${canPush ? `<button class="btn" data-act="push" data-id="${r.id}" title="Mark 1 Wear and reroll">Push · +1 Wear</button>` : ''}
    </div>` : '';

  const fresh = S.ready && !S.seenRolls.has(r.id) ? 'fresh' : '';
  S.seenRolls.add(r.id);
  return `
    <article class="entry ${fresh}" style="--accent:${esc(accent)}">
      <div class="entry-top"><b>${esc(r.who || 'Someone')}</b><span title="${esc(new Date(Date.parse(trimTs(r.created_at))).toLocaleString())}">${relTime(r.created_at)}</span></div>
      <div class="entry-label">${esc(r.label || 'Roll')}</div>
      <div class="entry-body">${dice}${grit}${mod}${mult}<span class="total">${r.total.toLocaleString()}</span></div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      ${actions}
    </article>`;
}

function renderLog() {
  const log = $('#log');
  if (!log) return;
  const rolls = [...S.rolls.values()].sort((a, b) => b.id - a.id);
  const listEl = $('#log-list');
  const scroll = listEl ? listEl.scrollTop : 0;
  const draft = $('#free-input') ? $('#free-input').value : '';
  const hadFocus = document.activeElement && document.activeElement.id === 'free-input';
  log.className = 'log' + (S.logOpen ? ' open' : '');
  log.innerHTML = `
    <div class="log-head">
      <h2><span class="grow">Dice</span><span class="tag brass" title="Shared Grit pool">Grit ${S.grit}/10</span>
        <button class="icon-btn log-close" data-act="log-toggle" aria-label="Close dice log">×</button></h2>
      <form class="free-roll" id="free-form">
        <input id="free-input" placeholder="2d6+1, 1d20, 2d6+wits" aria-label="Dice to roll" autocomplete="off">
        <button class="btn brass" type="submit">Roll</button>
      </form>
      <div class="quick">
        ${['2d6', '1d6', '1d4', '1d8', '1d10', '1d12', '1d20', '1d100'].map(q => `<button class="btn" data-act="quick" data-f="${q}">${q}</button>`).join('')}
      </div>
      <div class="small dim">Rolling as <b style="color:var(--paper)">${esc(whoName())}</b></div>
    </div>
    <div class="log-list" id="log-list">
      ${rolls.length ? rolls.map(entryHTML).join('') : '<p class="log-empty">No rolls yet. Click a stat on a sheet or roll here.</p>'}
    </div>`;
  $('#log-list').scrollTop = scroll;
  const fi = $('#free-input');
  fi.value = draft;
  if (hadFocus) fi.focus();
  $('#free-form').onsubmit = e => { e.preventDefault(); freeRoll(fi.value); };
  const last = rolls[0];
  const fab = $('#fab-last');
  if (fab) fab.textContent = last ? last.total : '';
}

function freeRoll(text) {
  const sheetRec = S.sheets.get(S.who);
  const f = parseFormula(text, sheetRec && sheetRec.data);
  if (!f) {
    toast(sheetRec || !/[a-z]{3}/i.test(String(text).replace(/d\d+/gi, ''))
      ? 'Try something like 2d6+1 or 1d20.'
      : 'Pick a character under “Playing as” to use stats in a roll.', true);
    return;
  }
  roll({ sheetId: sheetRec ? sheetRec.id : null, label: String(text).trim(), kind: 'free', ...f, who: whoName() });
  $('#free-input').value = '';
}

// ── Toast ──────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, err ? 4200 : 2600);
}

// ── Events ─────────────────────────────────────────────────────────────────

function currentSheet(el) {
  const host = el.closest('[data-sheet]');
  return host ? S.sheets.get(host.dataset.sheet) : null;
}
function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.dataset.type === 'num') return el.value === '' ? null : Number(el.value);
  return el.value;
}

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'gm-notes') return gmNotesChanged(el.value);
  if (!el.dataset.bind || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') return;
  const rec = currentSheet(el);
  if (!rec) return;
  const v = readValue(el);
  setLocal(rec.id, el.dataset.bind, v);
  queuePatch(rec.id, el.dataset.bind, v);
  if (el.dataset.bind === 'name') renderNav();
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'who-select') {
    S.who = el.value; lsSet('beacon.who', el.value || null);
    renderLog();
    return;
  }
  if (!el.dataset.bind) return;
  const rec = currentSheet(el);
  if (!rec) return;
  const path = el.dataset.bind;
  const v = readValue(el);
  setLocal(rec.id, path, v);
  queuePatch(rec.id, path, v, 0);

  // Picking a known skill fills in its stat.
  const m = path.match(/^skills\.(\d+)\.name$/);
  if (m) {
    const st = Object.keys(SKILLS).find(k => SKILLS[k].some(s => s.toLowerCase() === String(v).trim().toLowerCase()));
    if (st) { setLocal(rec.id, `skills.${m[1]}.stat`, st); queuePatch(rec.id, `skills.${m[1]}.stat`, st, 0); }
  }
  if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color' || m) {
    renderMain();
    if (el.type === 'color' || path === 'name') renderNav();
  }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const rec = currentSheet(el);
  const d = rec && rec.data;
  const n = +el.dataset.n, dd = +el.dataset.d, i = +el.dataset.i, si = +el.dataset.si, fi = +el.dataset.fi;
  if (el.tagName === 'A') e.preventDefault();

  switch (act) {
    // Navigation & shell
    case 'log-toggle': S.logOpen = !S.logOpen; $('#log').classList.toggle('open', S.logOpen); break;
    case 'tab': S.tab = el.dataset.t; lsSet('beacon.tab', S.tab); renderMain(); break;
    case 'customize': S.customize = !S.customize; renderMain(); break;
    case 'toggle-spec': S.spec = !S.spec; $('.modbar').outerHTML = modbarHTML(); break;
    case 'bonus': S.bonus = Math.max(-10, Math.min(10, S.bonus + dd)); $('.modbar').outerHTML = modbarHTML(); break;

    // Sheets
    case 'new-sheet': {
      try {
        const id = await rpc('create_sheet', { p_pass: S.pass, p_data: blankSheet('New Character') });
        await sync();
        S.tab = 'bio';
        location.hash = '#/c/' + id;
      } catch (err) { fail(err); }
      break;
    }
    case 'duplicate': {
      try {
        const copy = clone(d); copy.name = (d.name || 'Unnamed') + ' (copy)'; copy.accent = '';
        const id = await rpc('create_sheet', { p_pass: S.pass, p_data: copy });
        await sync();
        location.hash = '#/c/' + id;
        toast('Duplicated.');
      } catch (err) { fail(err); }
      break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (d.name || 'character').replace(/[^\w-]+/g, '_') + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      break;
    }
    case 'import': $('#file-import').click(); break;
    case 'delete': {
      if (!confirm(`Delete ${d.name || 'this character'}? The GM can restore it later.`)) break;
      try {
        await rpc('delete_sheet', { p_pass: S.pass, p_id: rec.id });
        S.sheets.delete(rec.id);
        if (S.who === rec.id) { S.who = ''; lsSet('beacon.who', null); }
        location.hash = '#/crew';
        renderNav();
        sync();
      } catch (err) { fail(err); }
      break;
    }
    case 'portrait': $('#file-portrait').dataset.sheet = rec.id; $('#file-portrait').click(); break;
    case 'panel-toggle': {
      const k = el.dataset.k;
      const hidden = d.hidden.includes(k) ? d.hidden.filter(x => x !== k) : [...d.hidden, k];
      commit(rec.id, 'hidden', hidden); renderMain(); break;
    }

    // Stats on the sheet / crew card
    case 'hp-step': {
      const cur = (d.hp.cur ?? d.hp.max ?? 0) + dd;
      const max = d.hp.max;
      commit(rec.id, 'hp.cur', max != null ? Math.min(max, cur) : cur); renderMain(); break;
    }
    case 'wear-set': commit(rec.id, 'wear', d.wear >= n ? n - 1 : n); renderMain(); renderLog(); break;
    case 'wear-clear': commit(rec.id, 'wear', 0); renderMain(); renderLog(); break;
    case 'death-set': {
      const k = el.dataset.k, death = { ...d.death };
      death[k] = death[k] >= n ? n - 1 : n;
      death.stable = death.s >= 3 || (death.stable && k !== 's');
      commit(rec.id, 'death', death); renderMain(); break;
    }
    case 'death-reset': commit(rec.id, 'death', { s: 0, f: 0, stable: false }); renderMain(); break;
    case 'gear-add': commit(rec.id, 'gear', [...d.gear, '']); renderMain(); break;
    case 'gear-del': commit(rec.id, 'gear', d.gear.filter((_, j) => j !== i)); renderMain(); break;
    case 'skill-add': commit(rec.id, 'skills', [...d.skills, { name: '', stat: 'wits', bonus: 1 }]); renderMain(); break;
    case 'skill-del': commit(rec.id, 'skills', d.skills.filter((_, j) => j !== i)); renderMain(); break;

    // Rolls from the sheet
    case 'roll-stat': {
      const st = STATS.find(s => s.k === el.dataset.k);
      const x = nextRollExtras();
      roll({ sheetId: rec.id, label: st.n + x.label, mod: statMod(d, st.k) + x.mod });
      resetNextRoll(); break;
    }
    case 'roll-skill': {
      const sk = d.skills[i], st = STATS.find(s => s.k === sk.stat) || STATS[0];
      const x = nextRollExtras();
      roll({ sheetId: rec.id, label: `${sk.name || 'Skill'} (${st.s})${x.label}`, mod: statMod(d, st.k) + (+sk.bonus || 0) + x.mod });
      resetNextRoll(); break;
    }
    case 'roll-hp': {
      if (d.hp.max != null && !confirm('Roll new HP? This replaces current and max HP.')) break;
      const r = await roll({ sheetId: rec.id, label: 'HP', kind: 'hp', mod: 6 });
      if (r) { await commit(rec.id, 'hp', { cur: r.total, max: r.total }); renderMain(); }
      break;
    }
    case 'roll-money': {
      if (d.money.rolled != null && !confirm('Roll money again? This replaces Rolled and Left.')) break;
      const r = await roll({ sheetId: rec.id, label: 'Money', kind: 'money', mult: 60 });
      if (r) { await commit(rec.id, 'money', { rolled: r.total, left: r.total }); renderMain(); }
      break;
    }
    case 'roll-death': {
      const r = await roll({ sheetId: rec.id, label: 'Dropping', kind: 'death', mod: statMod(d, 'composure') });
      if (!r) break;
      const fresh = S.sheets.get(rec.id).data;
      const death = { ...fresh.death };
      if (r.total >= 10) death.stable = true;
      else if (r.total >= 7) { death.s = Math.min(3, death.s + 1); if (death.s >= 3) death.stable = true; }
      else death.f = Math.min(3, death.f + 1);
      await commit(rec.id, 'death', death); renderMain();
      break;
    }

    // Custom sections
    case 'cs-add': {
      const custom = [...d.custom, { id: uid(), title: 'New section', tab: el.dataset.t, fields: [{ id: uid(), label: 'Field', type: 'text', value: '' }] }];
      commit(rec.id, 'custom', custom); renderMain(); break;
    }
    case 'cs-del': {
      if (!confirm(`Delete the section “${d.custom[si].title || 'Untitled'}” and everything in it?`)) break;
      commit(rec.id, 'custom', d.custom.filter((_, j) => j !== si)); renderMain(); break;
    }
    case 'cs-move': {
      const c = [...d.custom], j = si + dd;
      if (j < 0 || j >= c.length) break;
      [c[si], c[j]] = [c[j], c[si]];
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-add': {
      const c = clone(d.custom);
      c[si].fields = [...(c[si].fields || []), { id: uid(), label: 'Field', type: 'text', value: '' }];
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-del': {
      const c = clone(d.custom);
      c[si].fields.splice(fi, 1);
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-move': {
      const c = clone(d.custom), f = c[si].fields, j = fi + dd;
      if (j < 0 || j >= f.length) break;
      [f[fi], f[j]] = [f[j], f[fi]];
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-step': {
      const p = `custom.${si}.fields.${fi}.value`;
      commit(rec.id, p, (+getPath(d, p) || 0) + dd); renderMain(); break;
    }
    case 'cf-track': {
      const p = `custom.${si}.fields.${fi}.value`, cur = +getPath(d, p) || 0;
      commit(rec.id, p, cur >= n ? n - 1 : n); renderMain(); break;
    }
    case 'cf-roll': {
      const f = d.custom[si].fields[fi];
      const parsed = parseFormula(f.formula, d);
      if (!parsed) { toast(`“${f.formula || ''}” isn’t a roll. Try 2d6+wits or 1d20+2.`, true); break; }
      const x = nextRollExtras();
      roll({ sheetId: rec.id, label: (f.label || 'Roll') + x.label, kind: 'check', ...parsed, mod: parsed.mod + x.mod });
      resetNextRoll(); break;
    }

    // Crew-wide
    case 'grit-set': setGrit(S.grit >= n ? n - 1 : n); break;
    case 'grit-adj': adjustGrit(dd); break;
    case 'grit-vv': adjustGrit(1, `${el.dataset.name || 'Someone'} acted on their Vice or Virtue: +1 Grit.`); break;
    case 'grit-session': roll({ label: 'Session Grit', kind: 'grit_session', n: 1, sides: 6, who: whoName() }); break;

    // Dice log
    case 'quick': {
      const sheetRec = S.sheets.get(S.who);
      const f = parseFormula(el.dataset.f);
      roll({ sheetId: sheetRec ? sheetRec.id : null, label: el.dataset.f, kind: 'free', ...f, who: whoName() });
      break;
    }
    case 'spend-grit': {
      el.disabled = true;
      try {
        const r = await rpc('spend_grit', { p_pass: S.pass, p_roll: +el.dataset.id, p_who: whoName() });
        applyRoll(r); S.grit = Math.max(0, S.grit - 1); renderLog(); refreshMain(new Set(), true); sync();
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }
    case 'push': {
      el.disabled = true;
      try {
        const r = await rpc('reroll', { p_pass: S.pass, p_roll: +el.dataset.id });
        applyRoll(r); renderLog(); await sync();
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }

    // GM
    case 'gm-lock': S.gmPass = ''; lsSet('beacon.gm', null); S.gmNotes = null; S.deleted = null; renderMain(); break;
    case 'gm-clear': {
      if (!confirm('Clear the dice log for everyone?')) break;
      try { await rpc('gm_clear_rolls', { p_gm: S.gmPass }); S.rolls.clear(); renderLog(); toast('Dice log cleared.'); } catch (err) { fail(err); }
      break;
    }
    case 'gm-restore': {
      try {
        await rpc('gm_restore_sheet', { p_gm: S.gmPass, p_id: el.dataset.id });
        S.deleted = S.deleted.filter(x => x.id !== el.dataset.id);
        await sync(); renderMain(); toast('Restored.');
      } catch (err) { fail(err); }
      break;
    }
  }
});

async function setGrit(v) {
  try { S.grit = await rpc('set_grit', { p_pass: S.pass, p_value: v }); refreshMain(new Set(), true); renderLog(); }
  catch (err) { fail(err); }
}
async function adjustGrit(delta, msg) {
  try {
    S.grit = await rpc('adjust_grit', { p_pass: S.pass, p_delta: delta });
    refreshMain(new Set(), true); renderLog();
    if (msg) toast(msg);
  } catch (err) { fail(err); }
}

let gmTimer = null;
function gmNotesChanged(value) {
  S.gmNotes = value;
  const s = $('#gm-saving'); if (s) s.textContent = 'Saving…';
  clearTimeout(gmTimer);
  gmTimer = setTimeout(async () => {
    try { await rpc('gm_set_notes', { p_gm: S.gmPass, p_body: value }); const el = $('#gm-saving'); if (el) el.textContent = 'Saved'; }
    catch (err) { fail(err); }
  }, 700);
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'gm-form') return;
  e.preventDefault();
  const pass = $('#gm-pass').value;
  try {
    const role = await rpc('check_pass', { p_pass: pass });
    if (role !== 'gm') { $('#gm-err').textContent = 'Not the GM password.'; return; }
    S.gmPass = pass; lsSet('beacon.gm', pass);
    S.gmNotes = null;
    renderMain();
  } catch (err) { fail(err); }
});

// Portrait: centre-crop to a 320px square JPEG and keep it in the sheet.
document.addEventListener('change', async e => {
  if (e.target.id !== 'file-portrait') return;
  const file = e.target.files[0];
  const id = e.target.dataset.sheet;
  e.target.value = '';
  if (!file || !id) return;
  try {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = 320;
    c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 320, 320);
    await commit(id, 'portrait', c.toDataURL('image/jpeg', 0.82));
    renderMain(); renderNav();
  } catch (err) { toast('Couldn’t read that image.', true); }
});

document.addEventListener('change', async e => {
  if (e.target.id !== 'file-import') return;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!isObj(data)) throw new Error('bad');
    const id = await rpc('create_sheet', { p_pass: S.pass, p_data: withDefaults(blankSheet(), data) });
    await sync();
    location.hash = '#/c/' + id;
    toast(`Imported ${data.name || 'character'}.`);
  } catch (err) { toast('That file isn’t a Beacon character.', true); }
});

// ── Routing & boot ─────────────────────────────────────────────────────────

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  if (view === 'c' && id) return { view: 'sheet', id };
  if (view === 'rules') return { view: 'rules' };
  if (view === 'gm') return { view: 'gm' };
  return { view: 'crew' };
}

window.addEventListener('hashchange', () => {
  const prev = S.route;
  S.route = parseRoute();
  if (prev.view !== S.route.view || prev.id !== S.route.id) { S.customize = false; window.scrollTo(0, 0); }
  if (S.route.view === 'gm') { S.gmNotes = null; }
  if (S.logOpen && window.matchMedia('(max-width: 1100px)').matches) { S.logOpen = false; }
  if (!S.ready) return;
  renderNav(); renderMain(); renderLog();
});

function boot() {
  S.route = parseRoute();
  app.innerHTML = '<div class="gate"><p class="dim">Loading the crew…</p></div>';
  sync();
  startPolling();
  setInterval(() => { if (S.ready && !document.hidden) renderLogTimes(); }, 30000);
}
function renderLogTimes() {
  const rolls = [...S.rolls.values()].sort((a, b) => b.id - a.id);
  document.querySelectorAll('.entry-top span').forEach((el, j) => { if (rolls[j]) el.textContent = relTime(rolls[j].created_at); });
}

if (S.pass) boot(); else renderGate();
