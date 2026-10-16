/* Debt — crew portal.
 *
 * Plain browser JS, no build step. Data lives in Supabase and is reached only
 * through RPC functions (see supabase/schema.sql) that check a session token;
 * the key below is the public "publishable" key and grants nothing on its own.
 *
 * Roles: the GM sees and edits everything. A player logs in as one character
 * and edits only that sheet (the GM can lock parts of it).
 *
 * Sync model: every client polls `sync` with the server time it last saw and
 * merges what changed. A Realtime broadcast "ping" after each write makes the
 * others sync straight away. Edits are small per-field patches, so two people
 * typing in different fields of the same sheet don't overwrite each other.
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
// The skill matrix: each skill belongs to exactly one stat.
const SKILLS = {
  intelligence: ['Investigation', 'History', 'Technology'],
  wits:         ['Perception', 'Insight', 'Survival'],
  strength:     ['Athletics', 'Intimidation', 'Endurance'],
  dexterity:    ['Stealth', 'Sleight of Hand', 'Acrobatics'],
  manipulation: ['Deception', 'Persuasion', 'Performance'],
  composure:    ['Nerve', 'Empathy', 'Focus'],
};
const ALL_SKILLS = Object.values(SKILLS).flat();
const VICES   = ['Greed', 'Pride', 'Wrath', 'Fear', 'Lust', 'Envy', 'Gluttony', 'Sloth'];
const VIRTUES = ['Loyalty', 'Mercy', 'Honesty', 'Fortitude', 'Hope', 'Charity', 'Humility', 'Diligence'];
const MOD = { 4: 2, 3: 1, 2: 0, 1: -1 };
const STAT_SPREAD = '4,3,3,2,2,1';
const PALETTE = ['#c9a24b', '#5fa8d3', '#d9776b', '#8fbf6a', '#b48ad6', '#e0a458', '#4fb3a9', '#d68fb0'];
const DICE_TYPES = [4, 6, 8, 10, 12, 20, 100];

const PANELS = {
  identity: 'Identity', look: 'Appearance', money: 'Money', gear: 'Gear',
  backstory: 'Backstory', notes: 'Notes',
  stats: 'Stats & skills', hp: 'HP', dying: 'Dropping', wear: 'Wear',
};
// Panels the GM's lock freezes for the player (plus name, player and portrait).
const LOCKABLE = ['identity', 'look', 'backstory', 'gear'];
const FIELD_TYPES = {
  text: 'Short text', long: 'Long text', number: 'Number',
  check: 'Checkbox', track: 'Tracker boxes', roll: 'Roll button',
};

// The Vault, laid out like the sketch: A–J left, K–O centre top, P–Y right.
const VAULT_LEFT  = 'ABCDEFGHIJ'.split('');
const VAULT_MID   = 'KLMNO'.split('');
const VAULT_RIGHT = 'PQRSTUVWXY'.split('');
const VAULT_STATES = { '': 'Unmarked', open: 'Open', progress: 'In progress', complete: 'Complete' };

function blankSheet(name) {
  return {
    name: name || 'New Character', player: '', job: '', specialty: '', vice: '', virtue: '',
    accent: '', portrait: '',
    look: { height: '', skin: '', hair: '', eyes: '', markings: '' },
    stats: { intelligence: null, wits: null, strength: null, dexterity: null, manipulation: null, composure: null },
    skills: Object.fromEntries(ALL_SKILLS.map(s => [s, 0])),
    hp: { cur: null, max: null, temp: 0 },
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
const statOf = skill => Object.keys(SKILLS).find(k => SKILLS[k].includes(skill));

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
function normalize(raw) {
  const d = isObj(raw) ? { ...raw } : {};
  // v1 stored skills as a free list; map them onto the fixed matrix.
  if (Array.isArray(d.skills)) {
    const out = {};
    for (const x of d.skills) {
      const name = ALL_SKILLS.find(s => s.toLowerCase() === String(x && x.name || '').trim().toLowerCase());
      if (name) out[name] = Math.max(out[name] || 0, +x.bonus || 0);
    }
    d.skills = out;
  }
  if (isObj(d.skills)) {
    d.skills = { ...d.skills };
    for (const k of Object.keys(d.skills)) if (!ALL_SKILLS.includes(k)) delete d.skills[k];
  }
  return withDefaults(blankSheet(), d);
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
function statPart(data, k) {
  const st = STATS.find(s => s.k === k);
  const v = data.stats[k];
  return { label: `${st.n}${v == null ? '' : ' (' + v + ')'}`, value: statMod(data, k) };
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
const die = (px = 16) => DIE_SVG.replace('<svg', `<svg width="${px}" height="${px}"`);
const LOCK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const REROLL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>';

// ── State ──────────────────────────────────────────────────────────────────

const S = {
  token: lsGet('debt.token') || '',
  me: null,              // { role: 'gm'|'player', sheet_id }
  tab: lsGet('debt.tab') || 'bio',
  sheets: new Map(),     // id -> { id, data, sort, locked, has_pass, updated_at }
  rolls: new Map(),      // id -> roll row
  grit: 0,
  gritOpen: true,
  scene: null,           // { id, kind, title, caption, updated_at } of the current scene
  sceneShown: false,
  sceneKey: '',
  scenesSig: null,
  scenes: null,          // GM: list of scenes
  vault: new Map(),      // code -> { state, by }
  vaultLoaded: false,
  images: new Map(),     // scene id -> { key, src }
  win: loadWin(),
  since: null,
  ready: false,
  syncing: false,
  route: { view: 'crew' },
  customize: false,
  spec: false,           // next roll: add Specialty +2
  bonus: 0,              // next roll: extra modifier
  mr: { n: 2, sides: 6, mod: 0 },   // manual dice roller
  logOpen: false,
  seenRolls: new Set(),
  deferRender: false,
  gmNotes: null,
  deleted: null,
  vaultMenu: null,       // code whose state menu is open
};
const pending = new Map(); // `${id}|${path}` -> { id, path, value, timer }

const isGM = () => !!S.me && S.me.role === 'gm';
const mine = () => S.me && S.me.sheet_id;
const canEdit = rec => !!rec && (isGM() || rec.id === mine());
const canEditArea = (rec, key) => canEdit(rec) && (isGM() || !rec.locked || !LOCKABLE.includes(key));
const myName = () => (isGM() ? 'GM' : (S.sheets.get(mine()) || { data: { name: 'Player' } }).data.name);

function loadWin() {
  try { return { min: false, full: false, ...JSON.parse(lsGet('debt.win') || '{}') }; }
  catch { return { min: false, full: false }; }
}
function saveWin() { lsSet('debt.win', JSON.stringify({ x: S.win.x, y: S.win.y, w: S.win.w, h: S.win.h, min: S.win.min })); }

// ── API ────────────────────────────────────────────────────────────────────

async function rpc(fn, args = {}, opts = {}) {
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
// Calls that need the session token.
const api = (fn, args = {}, opts) => rpc(fn, { p_token: S.token, ...args }, opts);

const ERRORS = {
  no_grit: 'The Grit pool is empty.',
  grit_max: 'That roll already has its Grit die. Max 1 per roll.',
  grit_closed: 'The session Grit roll is used. The GM can reopen it.',
  not_d6: 'Grit only adds to rolls that use d6s.',
  no_wear: 'No Wear to spend. Earn it when you roll doubles.',
  wear_full: 'You already have 3 Wear.',
  already_marked: 'The Wear for those doubles is already taken.',
  cant_reroll: 'That roll can’t be rerolled.',
  not_yours: 'That isn’t your character.',
  locked: 'The GM has locked that part of the sheet.',
  gm_only: 'Only the GM can do that.',
  not_shown: 'That scene isn’t being shown right now.',
  too_big: 'That is too big to save. Try a smaller picture.',
  too_short: 'Use at least 4 characters.',
  not_found: 'That no longer exists. It may have been deleted.',
};
function fail(err) {
  if (err && err.code === '28P01') return signOut('You were signed out. Log in again.');
  toast(ERRORS[err && err.message] || (err && err.message) || 'Something went wrong.', true);
}

// ── Realtime ping ──────────────────────────────────────────────────────────
// A broadcast carries no data, only "something changed, sync now".

let channel = null;
function connectRealtime() {
  try {
    if (channel || !window.supabase) return;
    const client = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    channel = client.channel('debt-crew', { config: { broadcast: { self: false } } });
    let t = null;
    channel.on('broadcast', { event: 'ping' }, () => { clearTimeout(t); t = setTimeout(sync, 120); });
    channel.subscribe();
  } catch { channel = null; /* polling still works */ }
}
function ping() {
  try { if (channel) channel.send({ type: 'broadcast', event: 'ping', payload: {} }); } catch { /* ignore */ }
}

// ── Sync ───────────────────────────────────────────────────────────────────

function sheetRecord(rec) {
  const data = normalize(rec.data);
  // Keep what the user typed but hasn't been saved yet.
  for (const p of pending.values()) if (p.id === rec.id) setPath(data, p.path, clone(p.value));
  return {
    id: rec.id, data, sort: rec.sort, locked: !!rec.locked, has_pass: rec.has_pass,
    updated_at: rec.updated_at, _json: JSON.stringify(data),
  };
}

function applySheet(rec) {
  const cur = S.sheets.get(rec.id);
  if (rec.deleted) { if (cur) { S.sheets.delete(rec.id); return true; } return false; }
  if (cur && cur.updated_at >= rec.updated_at) return false;
  const next = sheetRecord(rec);
  S.sheets.set(rec.id, next);
  return !cur || cur._json !== next._json || cur.sort !== next.sort || cur.locked !== next.locked || cur.has_pass !== next.has_pass;
}

function applyRoll(r) {
  const cur = S.rolls.get(r.id);
  if (cur && cur.updated_at === r.updated_at) return false;
  S.rolls.set(r.id, r);
  return true;
}

async function sync() {
  if (S.syncing || !S.token) return;
  S.syncing = true;
  try {
    const since = S.since ? new Date(Date.parse(trimTs(S.since)) - 5000).toISOString() : null;
    const r = await api('sync', { p_since: since });
    S.since = r.now;
    S.me = r.me;
    const changed = new Set();
    let rollsChanged = false, crewChanged = false, sceneChanged = false, vaultChanged = false;

    if (r.grit !== S.grit || r.grit_open !== S.gritOpen) { S.grit = r.grit; S.gritOpen = r.grit_open; crewChanged = true; }
    for (const rec of r.sheets) if (applySheet(rec)) changed.add(rec.id);
    for (const roll of r.rolls) if (applyRoll(roll)) rollsChanged = true;
    for (const id of [...S.rolls.keys()]) {
      if (r.roll_min == null || id < r.roll_min) { S.rolls.delete(id); rollsChanged = true; }
    }
    if (S.rolls.size > 150) {
      [...S.rolls.keys()].sort((a, b) => a - b).slice(0, S.rolls.size - 150).forEach(k => S.rolls.delete(k));
    }

    // Scene: reopen the window when the GM shows something new.
    const key = r.scene_shown && r.scene ? r.scene.id + '|' + r.scene.updated_at : '';
    if (key !== S.sceneKey || r.scene_shown !== S.sceneShown) {
      const newId = r.scene_shown && r.scene ? r.scene.id : '';
      if (newId && newId !== S.sceneKey.split('|')[0] && S.ready) { S.win.min = false; S.win.fresh = true; }
      S.scene = r.scene; S.sceneShown = r.scene_shown; S.sceneKey = key;
      sceneChanged = true;
    } else if (r.scene && S.scene && r.scene.title !== S.scene.title) { S.scene = r.scene; sceneChanged = true; }
    const vaultVisible = S.sceneShown && S.scene && S.scene.kind === 'vault';
    if (r.vault) for (const b of r.vault) { S.vault.set(b.code, b); vaultChanged = true; }
    if (!vaultVisible && !isGM()) S.vaultLoaded = false;
    if ((vaultVisible || isGM()) && !S.vaultLoaded) await loadVault();

    if (isGM() && r.scenes_sig !== S.scenesSig) { S.scenesSig = r.scenes_sig; loadScenes(); }

    if (!S.ready) { S.ready = true; renderApp(); return; }
    if (changed.size) renderNav();
    if (changed.size || crewChanged || (vaultChanged && S.route.view === 'scenes')) refreshMain(changed, crewChanged);
    if (rollsChanged || crewChanged || changed.size) renderLog();
    if (sceneChanged || vaultChanged || changed.size) renderScene();
  } catch (err) {
    if (err.code === '28P01') signOut('You were signed out. Log in again.');
  } finally {
    S.syncing = false;
  }
}

async function loadVault() {
  try {
    const rows = await api('get_vault');
    for (const b of rows) S.vault.set(b.code, b);
    S.vaultLoaded = true;
  } catch { /* not shown any more */ }
}

async function loadScenes() {
  try {
    S.scenes = await api('gm_scenes');
    if (S.route.view === 'scenes') renderMain();
  } catch (err) { fail(err); }
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
    await api('patch_sheet', { p_id: p.id, p_path: p.path.split('.'), p_value: p.value }, { keepalive });
    ping();
  } catch (err) {
    fail(err);
    S.since = null; // pull the true state back
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

function nextRollParts(d) {
  const parts = [];
  if (S.spec) parts.push({ label: 'Specialty' + (d.specialty ? ': ' + d.specialty : ''), value: 2 });
  if (S.bonus) parts.push({ label: 'Bonus', value: S.bonus });
  return parts;
}
function resetNextRoll() {
  if (!S.spec && !S.bonus) return;
  S.spec = false; S.bonus = 0;
  refreshLastRoll();
}

async function roll({ sheetId = null, label, kind = 'free', n = 2, sides = 6, parts = [] }) {
  try {
    const r = await api('roll', {
      p_sheet: sheetId, p_label: label, p_kind: kind, p_n: n, p_sides: sides,
      p_parts: parts.filter(p => p.value !== 0 || /\(/.test(p.label)),
    });
    applyRoll(r);
    ping();
    renderLog();
    refreshLastRoll();
    if (window.matchMedia('(max-width: 1100px)').matches && !S.logOpen) {
      toast(`${r.who} · ${r.label}: ${r.total}${isDoubles(r) ? ' · doubles!' : ''}`);
    }
    sync();
    return r;
  } catch (err) { fail(err); return null; }
}

const isDoubles = r => r.sides === 6 && r.dice.length === 2 && r.dice[0] === r.dice[1];

// "2d6+wits+2" -> { n, sides, parts }. Stat names need a sheet.
function parseFormula(str, data) {
  const s = String(str || '').toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d*)d(\d+)(.*)$/);
  if (!m) return null;
  const n = +(m[1] || 1), sides = +m[2];
  const tokens = m[3].match(/[+-][^+-]+/g) || [];
  if (tokens.join('') !== m[3]) return null;
  const parts = [];
  let flat = 0;
  for (const p of tokens) {
    const sign = p[0] === '-' ? -1 : 1, t = p.slice(1);
    if (/^\d+$/.test(t)) { flat += sign * +t; continue; }
    if (t === 'spec' || t === 'specialty') { parts.push({ label: 'Specialty' + (data && data.specialty ? ': ' + data.specialty : ''), value: sign * 2 }); continue; }
    const st = STATS.find(x => x.a.includes(t));
    if (st && data) { const sp = statPart(data, st.k); parts.push({ label: sp.label, value: sign * sp.value }); continue; }
    return null;
  }
  if (flat) parts.push({ label: 'Modifier', value: flat });
  if (n < 1 || n > 30 || sides < 2 || sides > 1000) return null;
  return { n, sides, parts };
}

// What a death roll did to the pips, so a Wear reroll can undo it.
function deathOutcome(total) { return total >= 10 ? 'stable' : total >= 7 ? 's' : 'f'; }
function applyDeath(death, outcome, sign) {
  const d = { ...death };
  if (outcome === 'stable') d.stable = sign > 0;
  else d[outcome] = Math.max(0, Math.min(3, d[outcome] + sign));
  if (d.s >= 3) d.stable = true;
  return d;
}

// After a Wear reroll, roll effects that touched the sheet follow the new result.
async function afterReroll(before, after) {
  const rec = S.sheets.get(after.sheet_id);
  if (!rec) return;
  if (after.kind === 'hp') {
    await commit(rec.id, 'hp', { ...rec.data.hp, cur: after.total, max: after.total });
  } else if (after.kind === 'death') {
    let d = applyDeath(rec.data.death, deathOutcome(before.total), -1);
    d = applyDeath(d, deathOutcome(after.total), +1);
    await commit(rec.id, 'death', d);
  }
}

// ── Rendering: login ───────────────────────────────────────────────────────

const app = $('#app');

async function renderLogin(msg) {
  clearInterval(pollTimer);
  app.innerHTML = `<div class="gate"><div class="gate-box"><div class="logo-die"><i></i><i></i><i></i></div><h1>DEBT</h1><p class="dim">Loading the crew…</p></div></div>`;
  let options = [];
  try { options = await rpc('login_options'); }
  catch { app.querySelector('.gate-box p').textContent = 'Couldn’t reach the server. Refresh to try again.'; return; }

  const tiles = options.map((o, i) => `
    <button type="button" class="who-tile" data-pick="${o.id}" style="--accent:${esc(o.accent || PALETTE[i % PALETTE.length])}" aria-pressed="false">
      <span class="avatar" style="${o.portrait ? `background-image:url('${esc(o.portrait)}')` : ''}">${o.portrait ? '' : esc((o.name || '?').charAt(0).toUpperCase())}</span>
      <span class="who-name">${esc(o.name || 'Unnamed')}</span>
      ${o.ready ? '' : '<span class="who-note">No password yet</span>'}
    </button>`).join('');

  app.innerHTML = `
    <div class="gate">
      <form class="gate-box" id="login-form" autocomplete="on">
        <div class="logo-die"><i></i><i></i><i></i></div>
        <h1>DEBT</h1>
        <p class="dim">Who are you playing?</p>
        <div class="who-grid">
          ${tiles}
          <button type="button" class="who-tile gm" data-pick="gm" aria-pressed="false">
            <span class="avatar">GM</span><span class="who-name">Game Master</span>
          </button>
        </div>
        <div id="login-pass" hidden>
          <div class="field stack">
            <label for="pass" id="pass-label">Password</label>
            <input id="pass" type="password" autocomplete="current-password">
          </div>
          <button class="btn brass" type="submit" id="login-btn">Enter</button>
        </div>
        <p class="err" id="login-err">${esc(msg || '')}</p>
      </form>
    </div>`;

  let picked = null;
  app.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    picked = b.dataset.pick;
    app.querySelectorAll('[data-pick]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    const o = options.find(x => x.id === picked);
    const err = $('#login-err');
    if (o && !o.ready) {
      $('#login-pass').hidden = true;
      err.textContent = `${o.name} has no password yet. Ask the GM to set one.`;
      return;
    }
    err.textContent = '';
    $('#login-pass').hidden = false;
    $('#pass-label').textContent = picked === 'gm' ? 'GM password' : `Password for ${o.name}`;
    $('#pass').value = '';
    $('#pass').focus();
  });

  $('#login-form').onsubmit = async e => {
    e.preventDefault();
    if (!picked) return;
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const s = await rpc('login', { p_sheet: picked === 'gm' ? null : picked, p_pass: $('#pass').value });
      S.token = s.token; S.me = { role: s.role, sheet_id: s.sheet_id };
      lsSet('debt.token', s.token);
      boot();
    } catch (err) {
      $('#login-err').textContent = err.message === 'bad_login' ? 'That’s not the password.' : 'Couldn’t reach the server. Try again.';
      btn.disabled = false; btn.textContent = 'Enter';
    }
  };
}

async function signOut(msg) {
  const tok = S.token;
  S.token = ''; lsSet('debt.token', null);
  S.me = null; S.ready = false; S.since = null;
  S.sheets.clear(); S.rolls.clear(); S.vault.clear(); S.vaultLoaded = false;
  S.scene = null; S.sceneKey = ''; S.sceneShown = false; S.scenes = null; S.scenesSig = null;
  S.gmNotes = null; S.deleted = null; S.customize = false;
  if (tok && !msg) { try { await rpc('logout', { p_token: tok }); } catch { /* already gone */ } }
  location.hash = '#/crew';
  renderLogin(msg);
}

// ── Rendering: shell ───────────────────────────────────────────────────────

function renderApp() {
  app.innerHTML = `
    <header class="top">
      <a class="brand" href="#/crew">DEBT</a>
      <nav class="nav" id="nav"></nav>
      <div class="me" id="me"></div>
    </header>
    <div class="layout">
      <main class="main" id="main"></main>
      <aside class="log" id="log" aria-label="Dice"></aside>
    </div>
    <div id="scene-root"></div>
    <button class="log-fab" id="log-fab" data-act="log-toggle" aria-label="Open dice">${die(22)}<span id="fab-last"></span></button>
    <input type="file" id="file-portrait" accept="image/*" hidden>
    <input type="file" id="file-import" accept="application/json,.json" hidden>
    <input type="file" id="file-scene" accept="image/*" hidden>`;
  renderNav();
  renderMain();
  renderLog();
  renderScene();
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
         <span class="sw" style="background:${esc(accentOf(rec))}"></span>${esc(rec.data.name || 'Unnamed')}${rec.id === mine() ? ' <small class="you">you</small>' : ''}${rec.locked ? ' ' + LOCK_SVG : ''}</a>`),
    `<a href="#/rules" class="${r.view === 'rules' ? 'on' : ''}">Rules</a>`,
    ...(isGM() ? [
      `<a href="#/scenes" class="gm-link ${r.view === 'scenes' ? 'on' : ''}">Scenes</a>`,
      `<a href="#/gm" class="gm-link ${r.view === 'gm' ? 'on' : ''}">GM</a>`,
    ] : []),
  ].join('');
  const me = $('#me');
  const rec = S.sheets.get(mine());
  me.innerHTML = `
    ${rec ? avatarHTML(rec, 'sm') : '<span class="avatar sm gm-av">GM</span>'}
    <span class="me-name">${esc(myName())}</span>
    <button class="btn sm ghost" data-act="logout">Log out</button>`;
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
  else if (r.view === 'gm' && isGM()) { main.innerHTML = gmHTML(); if (S.gmNotes === null) loadGM(); }
  else if (r.view === 'scenes' && isGM()) main.innerHTML = scenesHTML();
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
  return !!(a && main && main.contains(a)) &&
    (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|number|search|password|)$/.test(a.type)));
}

function refreshMain(changed, crewChanged) {
  const r = S.route;
  if (r.view === 'sheet') {
    if (!S.sheets.has(r.id)) { location.hash = '#/crew'; return; }
    if (!changed.has(r.id) && !crewChanged) return;
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
  } else if (r.view === 'crew' || r.view === 'gm' || r.view === 'scenes') {
    if (typingInMain()) { S.deferRender = true; return; }
    renderMain();
  }
}
document.addEventListener('focusout', () => {
  setTimeout(() => { if (S.deferRender && !typingInMain()) renderMain(); }, 0);
});

// ── Rendering: shared bits ─────────────────────────────────────────────────

function pipsHTML(count, filled, act, extra = '', cls = '', disabled = false) {
  let h = `<div class="pips ${cls}">`;
  for (let i = 1; i <= count; i++) {
    h += `<button type="button" class="pip ${i <= filled ? 'on' : ''}" data-act="${act}" data-n="${i}" ${extra} ${disabled ? 'disabled' : ''} aria-label="${i}" aria-pressed="${i <= filled}"></button>`;
  }
  return h + '</div>';
}

function avatarHTML(rec, size = '') {
  const d = rec.data;
  const style = `--accent:${esc(accentOf(rec))};${d.portrait ? `background-image:url('${esc(d.portrait)}')` : ''}`;
  return `<span class="avatar ${size}" style="${style}">${d.portrait ? '' : esc((d.name || '?').trim().charAt(0).toUpperCase())}</span>`;
}

function hpText(hp) {
  return `${hp.cur ?? '—'} / ${hp.max ?? '—'}${+hp.temp ? ` <span class="temp">+${+hp.temp} temp</span>` : ''}`;
}

// −1 uses temp HP first; +1 heals up to max.
function hpStep(hp, dd) {
  const h = { ...hp, temp: +hp.temp || 0 };
  if (dd < 0) {
    if (h.temp > 0) h.temp -= 1;
    else h.cur = Math.max(0, (h.cur ?? h.max ?? 0) - 1);
  } else {
    const cur = (h.cur ?? 0) + 1;
    h.cur = h.max != null ? Math.min(h.max, cur) : cur;
  }
  return h;
}

// ── Rendering: crew board ──────────────────────────────────────────────────

function crewHTML() {
  const gm = isGM();
  const cards = orderedSheets().map(rec => {
    const d = rec.data, ed = canEdit(rec);
    const max = d.hp.max, cur = d.hp.cur ?? 0, temp = +d.hp.temp || 0;
    const base = Math.max(max || 0, cur) + temp;
    const pct = base ? Math.max(0, cur / base * 100) : 0, tpct = base ? temp / base * 100 : 0;
    return `
      <section class="panel card" style="--accent:${esc(accentOf(rec))}" data-sheet="${rec.id}">
        <a class="card-head" href="#/c/${rec.id}">
          ${avatarHTML(rec)}
          <div>
            <div class="card-name">${esc(d.name || 'Unnamed')}${rec.id === mine() ? ' <small class="you">you</small>' : ''}</div>
            <div class="meta">${esc([d.job, d.player && 'played by ' + d.player].filter(Boolean).join(' · ') || 'No job yet')}</div>
          </div>
          ${rec.locked ? `<span class="lock-badge" title="Locked by the GM">${LOCK_SVG}</span>` : ''}
        </a>
        <div>
          <div class="line">
            <span class="k">HP</span>
            <span class="row">
              ${ed ? `<button class="icon-btn" data-act="hp-step" data-d="-1" aria-label="Lose 1 HP">−</button>` : ''}
              <span>${hpText(d.hp)}</span>
              ${ed ? `<button class="icon-btn" data-act="hp-step" data-d="1" aria-label="Heal 1 HP">+</button>` : ''}
            </span>
          </div>
          ${max ? `<div class="hpbar ${pct <= 25 ? 'low' : ''}"><i style="width:${pct}%"></i><b style="width:${tpct}%"></b></div>` : ''}
        </div>
        <div class="line"><span class="k">Wear</span>${pipsHTML(3, d.wear, 'wear-set', '', 'red sm', !ed)}</div>
        <div class="line"><span class="k">Money left</span><span>${money(d.money.left)}</span></div>
        <div class="line"><span class="k">Specialty</span><span class="dim">${esc(d.specialty || '—')}</span></div>
        <div class="chips">
          ${d.vice ? `<span class="chip vice">${esc(d.vice)}</span>` : ''}
          ${d.virtue ? `<span class="chip virtue">${esc(d.virtue)}</span>` : ''}
          <span class="spacer"></span>
          ${gm ? `<button class="btn sm ${rec.locked ? 'on' : ''}" data-act="lock" title="Lock identity, appearance, backstory and gear">${LOCK_SVG} ${rec.locked ? 'Locked' : 'Lock'}</button>
                  <button class="btn sm" data-act="grit-vv" data-name="${esc(d.name)}" title="Acted on their Vice or Virtue">+1 Grit</button>` : ''}
        </div>
      </section>`;
  }).join('');

  const canSession = S.gritOpen || gm;
  return `
    <div class="wrap">
      <div class="grid">
        <section class="panel s7">
          <h2>Grit: shared pool</h2>
          <div class="row between">
            <div class="grit-count" aria-live="polite">${S.grit}<small> / 10</small></div>
            <div class="row">
              ${gm ? `<button class="btn" data-act="grit-adj" data-d="-1" aria-label="Remove 1 Grit">−</button>
                      <button class="btn" data-act="grit-adj" data-d="1" aria-label="Add 1 Grit">+</button>` : ''}
              <button class="btn brass" data-act="grit-session" ${canSession ? '' : 'disabled'}>${die(16)} Session roll 1d6</button>
            </div>
          </div>
          <div style="margin-top:14px">${pipsHTML(10, S.grit, 'grit-set', '', 'big', !gm)}</div>
          <div class="row between note">
            <span>${S.gritOpen ? 'Session roll is open: anyone can roll it once at the start of the session.' : 'Session roll used. The GM reopens it next session.'}</span>
            ${gm ? `<button class="btn sm" data-act="grit-open" data-v="${S.gritOpen ? 0 : 1}">${S.gritOpen ? 'Close session roll' : 'Reopen session roll'}</button>` : ''}
          </div>
          <p class="small dim" style="margin:8px 0 0">Spend 1 Grit to add 1d6 to any d6 roll, yours or anyone else’s, even after seeing it. Use <b>+ Grit</b> on a roll in the dice log. Max 1 per roll.</p>
        </section>
        <section class="panel s5">
          <h2>Quick rules</h2>
          <p class="small"><span class="hl">Wear</span> Banked rerolls, max 3. Roll doubles and you may mark 1. Spend 1 to reroll any of your rolls.</p>
          <p class="small"><span class="hl">Specialty +2</span> to the one thing you’re known for, when the GM says it applies.</p>
          <p class="small"><span class="hl">Dropping</span> at 0 HP: roll 2d6 + Composure each round. 10+ stable, 7–9 success, 6− fail. Three of either decides it.</p>
          <p class="small dim" style="margin:0"><a href="#/rules">Full crew rules</a></p>
        </section>
      </div>
      <div class="row between" style="margin:26px 0 12px">
        <h1 class="page-title" style="margin:0">The crew</h1>
        ${gm ? `<button class="btn ghost sm" data-act="import">Import JSON</button>` : ''}
      </div>
      <div class="cards">
        ${cards}
        ${gm ? `<button class="new-card" data-act="new-sheet"><span style="font-size:30px">+</span>New character</button>` : ''}
      </div>
    </div>`;
}

// ── Rendering: character sheet ─────────────────────────────────────────────

function panel(rec, key, cls, body, extraHead = '') {
  const hidden = rec.data.hidden.includes(key);
  if (hidden && !S.customize) return '';
  const editable = canEditArea(rec, key);
  const locked = rec.locked && LOCKABLE.includes(key);
  const toggle = S.customize
    ? `<button class="btn sm ghost" data-act="panel-toggle" data-k="${key}">${hidden ? 'Show' : 'Hide'}</button>` : '';
  return `
    <section class="panel ${cls}" style="${hidden ? 'opacity:.45' : ''}">
      <h2><span class="grow">${PANELS[key]}</span>${locked ? `<span class="lock-badge" title="Locked by the GM">${LOCK_SVG} Locked</span>` : ''}${extraHead}${toggle}</h2>
      <fieldset ${editable ? '' : 'disabled'}>${body}</fieldset>
    </section>`;
}

function field(label, path, data, attrs = '') {
  const v = getPath(data, path);
  return `<div class="field"><label>${label}</label><input data-bind="${path}" value="${esc(v)}" ${attrs}></div>`;
}
function selectField(label, path, data, options) {
  const v = getPath(data, path) || '';
  const opts = v && !options.includes(v) ? [...options, v] : options;
  return `<div class="field"><label>${label}</label>
    <select data-bind="${path}"><option value="" ${v ? '' : 'selected'}>—</option>
      ${opts.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select></div>`;
}

function lastRollFor(id) {
  let best = null;
  for (const r of S.rolls.values()) if (r.sheet_id === id && (!best || r.id > best.id)) best = r;
  return best;
}

function modbarHTML(rec) {
  const d = rec.data, ed = canEdit(rec);
  const last = lastRollFor(rec.id);
  const canReroll = ed && last && last.kind !== 'grit_session' && d.wear >= 1;
  return `
    <div class="modbar" id="modbar">
      <div class="row">
        <span class="lbl">Next roll</span>
        <button class="btn sm ${S.spec ? 'on' : ''}" data-act="toggle-spec" aria-pressed="${S.spec}" ${ed ? '' : 'disabled'}
          title="${esc(d.specialty ? 'Specialty: ' + d.specialty : 'No specialty written yet')}">
          Specialty +2${d.specialty ? `: <b>${esc(d.specialty)}</b>` : ''}</button>
        <span class="lbl">Bonus</span>
        <span class="stepper">
          <button data-act="bonus" data-d="-1" aria-label="Lower bonus" ${ed ? '' : 'disabled'}>−</button><b>${signed(S.bonus)}</b><button data-act="bonus" data-d="1" aria-label="Raise bonus" ${ed ? '' : 'disabled'}>+</button>
        </span>
      </div>
      <div class="row last-roll" id="last-roll">
        ${last ? `<span class="lbl">Last roll</span><span>${esc(last.label)} <b class="lr-total">${last.total}</b></span>` : '<span class="lbl">No rolls yet</span>'}
        <span class="wear-left" title="Wear banked">${REROLL_SVG} ${d.wear} Wear</span>
        ${last && ed ? `<button class="btn sm" data-act="reroll" data-id="${last.id}" ${canReroll ? '' : 'disabled'}
           title="${canReroll ? 'Spend 1 Wear to reroll' : 'No Wear to spend'}">${REROLL_SVG} Reroll · 1 Wear</button>` : ''}
      </div>
    </div>`;
}
function refreshLastRoll() {
  const rec = S.route.view === 'sheet' && S.sheets.get(S.route.id);
  const bar = $('#modbar');
  if (rec && bar) bar.outerHTML = modbarHTML(rec);
}

function sheetHTML(rec) {
  const d = rec.data, ed = canEdit(rec), gm = isGM();
  const idEd = canEditArea(rec, 'identity');
  const tab = S.tab === 'attr' ? 'attr' : 'bio';
  const banner = !ed
    ? `<div class="banner">Viewing ${esc(d.name)}’s sheet. Only ${esc(d.name)} and the GM can change it.</div>`
    : rec.locked
      ? `<div class="banner lock">${LOCK_SVG} The GM has locked identity, appearance, backstory and gear${gm ? ' for the player. You can still edit them.' : '.'}</div>`
      : '';
  const customBar = S.customize ? `
    <div class="hidden-bar">
      <b class="hl">Customizing</b>
      <span>Hide or show panels, rename and add your own sections and fields.</span>
      <span class="spacer"></span>
      <button class="btn sm brass" data-act="customize">Done</button>
    </div>` : '';

  return `
    <div class="wrap ${S.customize ? 'customizing' : ''}" data-sheet="${rec.id}" style="--accent:${esc(accentOf(rec))}">
      ${banner}
      <section class="panel">
        <div class="sheet-head">
          <button class="portrait-btn" data-act="portrait" aria-label="Change portrait" ${idEd ? '' : 'disabled'}>${avatarHTML(rec, 'lg')}${idEd ? '<span>Change</span>' : ''}</button>
          <div class="sheet-id">
            <input class="name-input" data-bind="name" value="${esc(d.name)}" aria-label="Character name" placeholder="Name" ${idEd ? '' : 'disabled'}>
            <div class="row">
              <input data-bind="player" value="${esc(d.player)}" placeholder="Player" aria-label="Player" style="max-width:220px" ${idEd ? '' : 'disabled'}>
              <span class="saving" id="saving"></span>
            </div>
          </div>
          <div class="sheet-tools">
            ${ed ? `<label class="row small dim" title="Sheet colour">Colour <input type="color" data-bind="accent" value="${esc(accentOf(rec))}"></label>
                    <button class="btn sm ${S.customize ? 'on' : ''}" data-act="customize">Customize</button>
                    <button class="btn sm ghost" data-act="export">Export</button>` : ''}
            ${gm ? `<button class="btn sm ${rec.locked ? 'on' : ''}" data-act="lock">${LOCK_SVG} ${rec.locked ? 'Unlock' : 'Lock'}</button>
                    <button class="btn sm ghost" data-act="duplicate">Duplicate</button>
                    <button class="btn sm danger" data-act="delete">Delete</button>` : ''}
          </div>
        </div>
      </section>
      <div class="tabs" role="tablist">
        <button role="tab" class="${tab === 'bio' ? 'on' : ''}" aria-selected="${tab === 'bio'}" data-act="tab" data-t="bio">Bio &amp; Info</button>
        <button role="tab" class="${tab === 'attr' ? 'on' : ''}" aria-selected="${tab === 'attr'}" data-act="tab" data-t="attr">Attributes &amp; Abilities</button>
      </div>
      ${customBar}
      ${tab === 'attr' ? modbarHTML(rec) : ''}
      <div class="grid">${tab === 'bio' ? bioTab(rec) : attrTab(rec)}</div>
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
      ${selectField('Vice', 'vice', d, VICES)}
      ${selectField('Virtue', 'virtue', d, VIRTUES)}
      <p class="note">Act on your Vice or Virtue: the crew gains +1 Grit (the GM adds it).</p>`),
    panel(rec, 'look', 's6', `
      ${field('Height', 'look.height', d)}
      ${field('Skin', 'look.skin', d)}
      ${field('Hair', 'look.hair', d)}
      ${field('Eyes', 'look.eyes', d)}
      ${field('Unique markings', 'look.markings', d)}`),
    panel(rec, 'money', 's5', `
      <p class="small dim" style="margin-top:-6px">Starting cash is 2d6 × $60.</p>
      <div class="field"><label>Starting $</label><input type="number" data-type="num" data-bind="money.rolled" value="${esc(d.money.rolled)}"></div>
      <div class="field"><label>Left $</label><input type="number" data-type="num" data-bind="money.left" value="${esc(d.money.left)}"></div>`),
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
  const trained = ALL_SKILLS.filter(s => +d.skills[s] > 0).map(s => +d.skills[s]);
  const skillsOK = (trained.length === 3 && trained.every(b => b === 1)) || (trained.length === 2 && trained.every(b => b === 2));

  const blocks = STATS.map(st => {
    const v = d.stats[st.k], m = statMod(d, st.k);
    const skills = SKILLS[st.k].map(sk => {
      const b = +d.skills[sk] || 0;
      return `
        <div class="skill-row ${b ? 'trained' : ''}">
          <span class="skill-name">${sk}</span>
          <select data-bind="skills.${sk}" data-type="num" aria-label="${sk} bonus">
            ${[0, 1, 2].map(n => `<option value="${n}" ${b === n ? 'selected' : ''}>${n ? '+' + n : '—'}</option>`).join('')}
          </select>
          <button class="roll-chip" data-act="roll-skill" data-sk="${esc(sk)}" title="2d6 + ${sk} only">${die(13)} ${signed(b)}</button>
          <button class="roll-chip both" data-act="roll-skill-stat" data-sk="${esc(sk)}" title="2d6 + ${st.n} + ${sk}">${die(13)} ${st.s} ${signed(m + b)}</button>
        </div>`;
    }).join('');
    return `
      <div class="stat-block">
        <div class="stat-row">
          <button class="stat-name" data-act="roll-stat" data-k="${st.k}" title="Roll 2d6 ${signed(m)}">${st.n}</button>
          <select data-bind="stats.${st.k}" data-type="num" aria-label="${st.n} score">
            <option value="" ${v == null ? 'selected' : ''}>—</option>
            ${[4, 3, 2, 1].map(n => `<option value="${n}" ${v === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
          <span class="mod-badge ${m > 0 ? 'pos' : m < 0 ? 'neg' : ''}" title="Modifier">${v == null ? '—' : signed(m)}</span>
          <button class="roll-btn" data-act="roll-stat" data-k="${st.k}" aria-label="Roll ${st.n}">${DIE_SVG}</button>
        </div>
        ${skills}
      </div>`;
  }).join('');

  const hp = d.hp, dying = hp.cur != null && hp.cur <= 0 && !(+hp.temp > 0);
  const de = d.death;
  const deathState = de.f >= 3 ? '<span class="warn">Dead.</span>'
    : de.stable ? '<span class="ok">Stable. Out, but you’ll live.</span>'
    : dying ? 'Dying. Roll again next round.' : 'Not dropping.';

  return [
    panel(rec, 'stats', 's12', `
      <p class="small dim" style="margin-top:-6px">Stats: assign 4, 3, 3, 2, 2, 1 (4 = +2 · 3 = +1 · 2 = +0 · 1 = −1).
        Skills: pick 3 at +1 or 2 at +2, from the stat each belongs to. Roll a skill on its own, or with its stat.</p>
      <div class="stat-grid">${blocks}</div>
      <div class="row between check-line">
        <span class="${spreadOK ? 'ok' : 'dim'}">${spreadOK ? '✓ Stats match 4, 3, 3, 2, 2, 1' : assigned.length ? 'Stats: ' + vals.map(x => x ?? '—').join(', ') + ' · should be 4, 3, 3, 2, 2, 1' : 'No stats assigned yet'}</span>
        <span class="${skillsOK ? 'ok' : 'dim'}">${skillsOK ? '✓ Skills fit the rules' : trained.length ? 'Skills: usually 3 at +1 or 2 at +2' : 'No skills picked yet'}</span>
      </div>`),
    panel(rec, 'hp', 's5', `
      <div class="hp-big">
        <label class="hp-cell"><span>Current</span><input type="number" data-type="num" data-bind="hp.cur" value="${esc(hp.cur)}"></label>
        <span class="of">/</span>
        <label class="hp-cell"><span>Max</span><input type="number" data-type="num" data-bind="hp.max" value="${esc(hp.max)}"></label>
        <label class="hp-cell temp"><span>Temp</span><input type="number" data-type="num" data-bind="hp.temp" value="${esc(hp.temp || 0)}" min="0"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" data-act="hp-step" data-d="-1" title="Uses temp HP first">−1 HP</button>
        <button class="btn sm" data-act="hp-step" data-d="1">+1 HP</button>
        <span class="stepper" title="Temporary HP">
          <button data-act="temp-step" data-d="-1" aria-label="Less temp HP">−</button><b>${+hp.temp || 0} temp</b><button data-act="temp-step" data-d="1" aria-label="More temp HP">+</button>
        </span>
        <span class="spacer"></span>
        <button class="btn sm" data-act="roll-hp">${die(14)} 2d6 + 6</button>
      </div>
      <p class="note">Damage comes off temp HP first. Rolling sets current and max.</p>`),
    panel(rec, 'dying', 's4 ' + (dying && !de.stable && de.f < 3 ? 'dying' : ''), `
      <button class="btn ${dying ? 'brass' : ''}" data-act="roll-death" style="width:100%">${die(16)} Roll 2d6 + Composure</button>
      <div class="row between" style="margin-top:12px"><span class="small dim">Successes</span>${pipsHTML(3, de.s, 'death-set', 'data-k="s"', 'green sm')}</div>
      <div class="row between" style="margin-top:8px"><span class="small dim">Fails</span>${pipsHTML(3, de.f, 'death-set', 'data-k="f"', 'red sm')}</div>
      <p class="small" style="margin:10px 0 0">${deathState}</p>
      <p class="note">10+ stable · 7–9 success · 6− fail. <button class="btn sm ghost" data-act="death-reset" style="margin-left:4px">Reset</button></p>`),
    panel(rec, 'wear', 's3', `
      ${pipsHTML(3, d.wear, 'wear-set', '', 'red big')}
      <p class="small" style="margin:12px 0 0"><b>${d.wear}</b> of 3 rerolls banked.</p>
      <p class="note">Roll doubles and the dice log offers 1 Wear. Spend 1 to reroll any of your rolls, HP included.</p>`),
    customSections(rec, 'attr'),
  ].join('');
}

function customSections(rec, tab) {
  const d = rec.data;
  const list = d.custom.map((sec, si) => ({ sec, si })).filter(x => (x.sec.tab || 'bio') === tab);
  const ed = canEdit(rec);
  const html = list.map(({ sec, si }) => S.customize && ed ? customEditHTML(rec, sec, si) : customViewHTML(rec, sec, si)).join('');
  const add = S.customize && ed
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
        return `<div class="cfield"><button class="btn" data-act="cf-roll" data-si="${si}" data-fi="${fi}">${die(16)} ${label} <span class="dim">${esc(f.formula || '')}</span></button></div>`;
      default:
        return `<div class="cfield"><span class="lbl">${label}</span><input data-bind="${p}" value="${esc(f.value)}" aria-label="${label}"></div>`;
    }
  }).join('');
  return `
    <section class="panel s6">
      <h2>${esc(sec.title || 'Untitled section')}</h2>
      <fieldset ${canEdit(rec) ? '' : 'disabled'}>${fields || '<p class="small dim">No fields yet. Use Customize to add some.</p>'}</fieldset>
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

// ── Rendering: rules ───────────────────────────────────────────────────────

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
        <section class="panel s3"><h2>HP</h2><div class="big-rule">2d6 + 6</div><p class="dim small">Grit may be used if you want. Temp HP is lost first.</p></section>
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
          <p>Starting cash is 2d6 × $60.</p>
          <h2 style="margin-top:18px">Wear: reroll, max 3</h2>
          <p>The job grinds you down. When you roll <span class="hl">doubles</span> you may mark 1 Wear. Spend 1 Wear to <span class="hl">reroll</span> any of your rolls. You can bank up to 3.</p>
        </section>
        <section class="panel s6">
          <h2>Grit: shared pool</h2>
          <p>Roll <span class="hl">1d6</span> at session start. Anyone can make that roll.</p>
          <p>Spend 1 Grit to roll <span class="hl">1d6</span> and add it to any roll that uses d6s, yours or anyone else’s. You can spend it after seeing the result. One Grit die per roll.</p>
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
          <p class="small"><span class="hl">Pick 3 at +1</span> or <span class="hl">pick 2 at +2</span>, your choice. Each skill belongs to one stat.</p>
          <div class="sk">${STATS.map(s => `<div><b>${s.n}</b>${SKILLS[s.k].join(', ')}</div>`).join('')}</div>
        </section>
      </div>
    </div>`;
}

// ── Rendering: GM page ─────────────────────────────────────────────────────

function gmHTML() {
  const deleted = S.deleted || [];
  const rows = orderedSheets().map(rec => `
    <div class="gm-row" data-sheet="${rec.id}">
      ${avatarHTML(rec, 'sm')}
      <a href="#/c/${rec.id}" class="gm-name">${esc(rec.data.name || 'Unnamed')}</a>
      <span class="tag ${rec.has_pass ? 'green' : 'red'}">${rec.has_pass ? 'Password set' : 'No password'}</span>
      <form class="row gm-pass" data-act-form="char-pass" data-id="${rec.id}">
        <input type="text" name="p" placeholder="${rec.has_pass ? 'New password' : 'Set a password'}" autocomplete="off" aria-label="Password for ${esc(rec.data.name)}" data-fk="pw-${rec.id}">
        <button class="btn sm" type="submit">Save</button>
      </form>
      <button class="btn sm ${rec.locked ? 'on' : ''}" data-act="lock">${LOCK_SVG} ${rec.locked ? 'Locked' : 'Lock'}</button>
    </div>`).join('');

  return `
    <div class="wrap">
      <h1 class="page-title">GM</h1>
      <div class="grid">
        <section class="panel s12">
          <h2>Characters &amp; logins</h2>
          <p class="small dim" style="margin-top:-6px">Players log in by picking their character and typing the password you give them. Saving a new password signs that player out. Lock freezes identity, appearance, backstory and gear for the player.</p>
          ${rows || '<p class="dim small">No characters yet.</p>'}
          <div class="row" style="margin-top:12px"><button class="btn sm" data-act="new-sheet">+ New character</button></div>
        </section>
        <section class="panel s8">
          <h2><span class="grow">GM notes</span><span class="saving" id="gm-saving"></span></h2>
          <textarea id="gm-notes" data-fk="gm-notes" rows="16" placeholder="Only the GM can see this." aria-label="GM notes">${esc(S.gmNotes === null ? '' : S.gmNotes)}</textarea>
          ${S.gmNotes === null ? '<p class="small dim">Loading…</p>' : ''}
        </section>
        <div class="s4" style="display:grid;gap:16px;align-content:start">
          <section class="panel">
            <h2>Session Grit roll</h2>
            <p class="small" style="margin-top:-4px">${S.gritOpen ? 'Open: anyone can roll it once.' : 'Closed: already rolled this session.'}</p>
            <button class="btn" data-act="grit-open" data-v="${S.gritOpen ? 0 : 1}">${S.gritOpen ? 'Close it' : 'Reopen for a new session'}</button>
          </section>
          <section class="panel">
            <h2>GM password</h2>
            <form class="row" data-act-form="gm-pass">
              <input type="text" name="p" placeholder="New GM password" autocomplete="off" aria-label="New GM password" data-fk="gm-pw">
              <button class="btn sm" type="submit">Change</button>
            </form>
          </section>
          <section class="panel">
            <h2>Dice log</h2>
            <button class="btn danger" data-act="gm-clear">Clear for everyone</button>
          </section>
          <section class="panel">
            <h2>Deleted characters</h2>
            ${deleted.length ? deleted.map(x => `
              <div class="row between" style="padding:6px 0;border-bottom:1px dashed var(--line)">
                <span>${esc(x.name || 'Unnamed')}</span>
                <button class="btn sm" data-act="gm-restore" data-id="${x.id}">Restore</button>
              </div>`).join('') : '<p class="small dim">None.</p>'}
          </section>
        </div>
      </div>
    </div>`;
}

async function loadGM() {
  try {
    const [notes, deleted] = await Promise.all([api('gm_get_notes'), api('gm_deleted_sheets')]);
    S.gmNotes = notes.body; S.deleted = deleted;
    if (S.route.view === 'gm') renderMain();
  } catch (err) { fail(err); }
}

// ── Rendering: scenes (GM) ─────────────────────────────────────────────────

function scenesHTML() {
  const list = S.scenes || [];
  const shownId = S.sceneShown && S.scene ? S.scene.id : null;
  const cards = list.map(sc => {
    const live = sc.id === shownId;
    const thumb = sc.kind === 'vault'
      ? `<div class="scene-thumb vault-thumb">${vaultMiniHTML()}</div>`
      : `<div class="scene-thumb" style="${sc.thumb ? `background-image:url('${esc(sc.thumb)}')` : ''}"></div>`;
    return `
      <section class="panel scene-card ${live ? 'live' : ''}" data-scene="${sc.id}">
        ${thumb}
        <div class="scene-card-body">
          <input data-scene-field="title" data-id="${sc.id}" data-fk="st-${sc.id}" value="${esc(sc.title)}" placeholder="Title" aria-label="Scene title" class="scene-title-input">
          ${sc.kind === 'vault' ? '<p class="small dim">Built-in. Players can mark boxes while it’s shown.</p>'
            : `<textarea data-scene-field="caption" data-id="${sc.id}" data-fk="sc-${sc.id}" rows="2" placeholder="Caption (optional)" aria-label="Scene caption">${esc(sc.caption)}</textarea>`}
          <div class="row">
            ${live ? '<span class="tag green">● Showing</span>' : `<button class="btn sm brass" data-act="scene-show" data-id="${sc.id}">Show to players</button>`}
            ${sc.kind === 'vault'
              ? `<button class="btn sm ghost" data-act="vault-reset">Clear all boxes</button>`
              : `<button class="btn sm ghost" data-act="scene-replace" data-id="${sc.id}">Replace image</button>
                 <button class="btn sm danger" data-act="scene-del" data-id="${sc.id}">Delete</button>`}
          </div>
        </div>
      </section>`;
  }).join('');
  return `
    <div class="wrap">
      <div class="row between">
        <h1 class="page-title" style="margin:0">Scenes</h1>
        <div class="row">
          ${shownId ? `<span class="small dim">Players see <b style="color:var(--paper)">${esc(S.scene.title || 'Untitled')}</b></span>
                       <button class="btn sm" data-act="scene-show" data-id="">Hide from players</button>`
                    : '<span class="small dim">Nothing is showing.</span>'}
          <button class="btn brass" data-act="scene-new">+ Upload a scene</button>
        </div>
      </div>
      <p class="small dim">Upload a map or picture, then show it. It pops up in a floating window for everyone. Only one scene shows at a time.</p>
      <div class="scene-grid">${S.scenes === null ? '<p class="dim">Loading…</p>' : cards}</div>
      ${S.vaultLoaded ? `<section class="panel" style="margin-top:18px"><h2>Vault editor</h2>
        <p class="small dim" style="margin-top:-6px">You can mark boxes here any time. Players can only when the Vault is showing.</p>
        ${vaultHTML()}</section>` : ''}
    </div>`;
}

function vaultMiniHTML() {
  const col = letters => `<div class="vm-col">${letters.map(l => `<div class="vm-row">${[1, 2, 3, 4].map(n => {
    const b = S.vault.get(l + n); return `<i class="${b ? 's-' + (b.state || 'none') : 's-none'}"></i>`;
  }).join('')}</div>`).join('')}</div>`;
  return `<div class="vault-mini">${col(VAULT_LEFT)}${col(VAULT_MID)}${col(VAULT_RIGHT)}</div>`;
}

// ── Rendering: the Vault ───────────────────────────────────────────────────

function vaultHTML() {
  const rows = letters => letters.map(l => `
    <div class="v-row">
      <span class="v-letter">${l}</span>
      ${[1, 2, 3, 4].map(n => {
        const code = l + n, b = S.vault.get(code) || { state: '' };
        const st = b.state || '';
        return `<button class="v-box s-${st || 'none'} ${S.vaultMenu === code ? 'menu-open' : ''}" data-act="vault-box" data-code="${code}"
                  title="${code} · ${VAULT_STATES[st]}${b.by && st ? ' · by ' + esc(b.by) : ''}">${code}</button>`;
      }).join('')}
    </div>`).join('');
  const counts = { open: 0, progress: 0, complete: 0 };
  for (const b of S.vault.values()) if (counts[b.state] != null) counts[b.state]++;
  const menu = S.vaultMenu ? `
    <div class="v-menu" role="menu" aria-label="Mark ${S.vaultMenu}">
      <b>${S.vaultMenu}</b>
      ${Object.entries(VAULT_STATES).map(([k, v]) => `<button class="btn sm v-opt s-${k || 'none'}" data-act="vault-set" data-code="${S.vaultMenu}" data-state="${k}">${k ? '' : '× '}${v}</button>`).join('')}
    </div>` : '';
  return `
    <div class="vault-wrap">
      <div class="vault">
        <div class="v-block">${rows(VAULT_LEFT)}</div>
        <div class="v-block mid"><div class="v-title">VAULT</div>${rows(VAULT_MID)}</div>
        <div class="v-block">${rows(VAULT_RIGHT)}</div>
      </div>
      ${menu}
      <div class="v-legend">
        <span><i class="s-open"></i> Open ${counts.open}</span>
        <span><i class="s-progress"></i> In progress ${counts.progress}</span>
        <span><i class="s-complete"></i> Complete ${counts.complete}</span>
        <span class="dim">Click a box to mark it</span>
      </div>
    </div>`;
}

// ── Rendering: floating scene window ───────────────────────────────────────

async function sceneImage(sc) {
  const key = sc.updated_at;
  const hit = S.images.get(sc.id);
  if (hit && hit.key === key) return hit.src;
  const src = await api('get_scene_image', { p_id: sc.id });
  S.images.set(sc.id, { key, src });
  return src;
}

function renderScene() {
  const root = $('#scene-root');
  if (!root) return;
  const sc = S.sceneShown ? S.scene : null;
  if (!sc) { root.innerHTML = ''; return; }
  const w = S.win;

  if (w.min) {
    root.innerHTML = `
      <button class="scene-pill ${w.fresh ? 'fresh' : ''}" data-act="win-restore">
        <span class="live-dot"></span> Scene: <b>${esc(sc.title || 'Untitled')}</b>
      </button>`;
    return;
  }
  const pos = w.full ? '' : `left:${w.x ?? 16}px;top:${w.y ?? 80}px;width:${w.w ?? 560}px;height:${w.h ?? 470}px`;
  root.innerHTML = `
    <div class="scene-win ${w.full ? 'full' : ''}" id="scene-win" style="${pos}" role="dialog" aria-label="Scene: ${esc(sc.title)}">
      <header class="scene-bar" id="scene-bar">
        <span class="live-dot"></span>
        <b class="scene-name">${esc(sc.title || 'Untitled')}</b>
        ${isGM() ? '<span class="tag green">Live</span>' : ''}
        <span class="spacer"></span>
        <button class="icon-btn" data-act="win-full" aria-label="${w.full ? 'Exit full screen' : 'Full screen'}" title="${w.full ? 'Exit full screen' : 'Full screen'}">${w.full ? '⤡' : '⤢'}</button>
        <button class="icon-btn" data-act="win-min" aria-label="Minimise" title="Minimise">–</button>
      </header>
      <div class="scene-body" id="scene-body">${sc.kind === 'vault' ? vaultHTML() : '<div class="scene-loading dim">Loading…</div>'}</div>
      ${sc.caption ? `<footer class="scene-caption">${esc(sc.caption)}</footer>` : ''}
    </div>`;
  w.fresh = false;

  if (sc.kind !== 'vault') {
    sceneImage(sc).then(src => {
      const body = $('#scene-body');
      if (body && S.scene && S.scene.id === sc.id) {
        body.innerHTML = src ? `<img src="${esc(src)}" alt="${esc(sc.title)}" class="scene-img" data-act="win-full">` : '<p class="dim">No image.</p>';
      }
    }).catch(() => { const body = $('#scene-body'); if (body) body.innerHTML = '<p class="dim">Couldn’t load the scene.</p>'; });
  }
  wireSceneWindow();
}

// Drag by the title bar; remember position and size.
function wireSceneWindow() {
  const win = $('#scene-win'), bar = $('#scene-bar');
  if (!win || S.win.full || window.matchMedia('(max-width: 640px)').matches) return;
  bar.onpointerdown = e => {
    if (e.target.closest('button')) return;
    const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId);
    bar.onpointermove = ev => {
      const x = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      win.style.left = x + 'px'; win.style.top = y + 'px';
      S.win.x = x; S.win.y = y;
    };
    bar.onpointerup = () => { bar.onpointermove = null; saveWin(); };
  };
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (S.win.full) return;
      const r = win.getBoundingClientRect();
      if (r.width && r.height) { S.win.w = Math.round(r.width); S.win.h = Math.round(r.height); clearTimeout(win._t); win._t = setTimeout(saveWin, 300); }
    }).observe(win);
  }
}

// ── Rendering: dice log ────────────────────────────────────────────────────

function rollerAvatar(r) {
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  return rec ? avatarHTML(rec, 'xs') : '<span class="avatar xs gm-av">GM</span>';
}

function breakdownHTML(r) {
  const rows = [];
  const purpose = r.kind === 'grit_session' ? 'Session Grit' : r.kind === 'hp' ? 'HP' : r.kind === 'death' ? 'Dropping' : 'Dice';
  const sum = r.dice.reduce((a, b) => a + b, 0);
  rows.push(`<div class="bd-row"><span>${purpose} · ${r.dice.length}d${r.sides} rolled ${r.dice.join(', ')}</span><b>${sum}</b></div>`);
  for (const p of r.parts || []) rows.push(`<div class="bd-row"><span>${esc(p.label)}</span><b>${signed(+p.value)}</b></div>`);
  if (!(r.parts || []).length && r.modifier) rows.push(`<div class="bd-row"><span>Modifier</span><b>${signed(r.modifier)}</b></div>`);
  for (const e of r.extras || []) rows.push(`<div class="bd-row grit"><span>Grit from ${esc(e.who)} · 1d6 rolled ${e.die}</span><b>+${e.die}</b></div>`);
  if (r.mult > 1) rows.push(`<div class="bd-row"><span>× ${r.mult}</span><b></b></div>`);
  for (const h of r.history || []) rows.push(`<div class="bd-row wear"><span>${REROLL_SVG} Rerolled with 1 Wear by ${esc(h.who)} · was ${(h.dice || []).join(', ')}</span><b></b></div>`);
  rows.push(`<div class="bd-row bd-total"><span>Total</span><b>${r.total.toLocaleString()}</b></div>`);
  return `<div class="breakdown">${rows.join('')}</div>`;
}

function entryHTML(r) {
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  const accent = rec ? accentOf(rec) : 'var(--line)';
  const dbl = isDoubles(r) && r.kind !== 'grit_session';
  const dice = r.dice.map(v => `<span class="die ${dbl ? 'dbl' : ''}">${v}</span>`).join('');
  const grit = (r.extras || []).map(e => `<span class="die grit" title="Grit from ${esc(e.who)}">${e.die}</span>`).join('');

  const tags = [];
  if (dbl) tags.push('<span class="tag red">Doubles</span>');
  if (r.wear_marked) tags.push('<span class="tag red">+1 Wear taken</span>');
  if (r.kind === 'death') tags.push(r.total >= 10 ? '<span class="tag green">Stable</span>' : r.total >= 7 ? '<span class="tag green">Success</span>' : '<span class="tag red">Fail</span>');
  if (r.kind === 'grit_session') tags.push('<span class="tag brass">Grit pool set</span>');

  const ed = rec && canEdit(rec);
  const canGrit = r.sides === 6 && r.kind !== 'grit_session' && !(r.extras || []).length && S.grit > 0;
  const canWear = ed && dbl && !r.wear_marked && rec.data.wear < 3;
  const canReroll = ed && r.kind !== 'grit_session' && rec.data.wear >= 1;
  const actions = (canGrit || canWear || canReroll) ? `
    <div class="entry-actions">
      ${canWear ? `<button class="btn" data-act="mark-wear" data-id="${r.id}" title="Doubles: bank 1 Wear">+1 Wear</button>` : ''}
      ${canGrit ? `<button class="btn" data-act="spend-grit" data-id="${r.id}" title="Spend 1 Grit to add 1d6">+ Grit 1d6</button>` : ''}
      ${canReroll ? `<button class="btn" data-act="reroll" data-id="${r.id}" title="Spend 1 Wear to reroll">${REROLL_SVG} Reroll · 1 Wear</button>` : ''}
    </div>` : '';

  const fresh = S.ready && !S.seenRolls.has(r.id) ? 'fresh' : '';
  S.seenRolls.add(r.id);
  return `
    <article class="entry ${fresh}" style="--accent:${esc(accent)}">
      <div class="entry-top">
        ${rollerAvatar(r)}
        <div class="entry-who"><b>${esc(r.who || 'GM')}</b><span class="entry-label">${esc(r.label || 'Roll')}</span></div>
        <span class="total">${r.total.toLocaleString()}</span>
      </div>
      <div class="entry-body">${dice}${grit}<span class="spacer"></span><span class="entry-time" title="${esc(new Date(Date.parse(trimTs(r.created_at))).toLocaleString())}">${relTime(r.created_at)}</span></div>
      ${breakdownHTML(r)}
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
  const keep = id => ($('#' + id) ? $('#' + id).value : '');
  const draft = keep('free-input'), label = keep('mr-label');
  const focusId = document.activeElement && document.activeElement.id;
  const mr = S.mr;
  log.className = 'log' + (S.logOpen ? ' open' : '');
  log.innerHTML = `
    <div class="log-head">
      <h2><span class="grow">Dice</span><span class="tag brass" title="Shared Grit pool">Grit ${S.grit}/10</span>
        <button class="icon-btn log-close" data-act="log-toggle" aria-label="Close dice">×</button></h2>
      <div class="roller">
        <div class="roller-row">
          <span class="lbl">Dice</span>
          <span class="stepper"><button data-act="mr-n" data-d="-1" aria-label="Fewer dice">−</button><b>${mr.n}</b><button data-act="mr-n" data-d="1" aria-label="More dice">+</button></span>
          <span class="lbl">Mod</span>
          <span class="stepper"><button data-act="mr-mod" data-d="-1" aria-label="Lower modifier">−</button><b>${signed(mr.mod)}</b><button data-act="mr-mod" data-d="1" aria-label="Raise modifier">+</button></span>
        </div>
        <div class="die-types" role="radiogroup" aria-label="Die type">
          ${DICE_TYPES.map(t => `<button class="btn ${mr.sides === t ? 'on' : ''}" data-act="mr-sides" data-v="${t}" role="radio" aria-checked="${mr.sides === t}">d${t}</button>`).join('')}
        </div>
        <div class="roller-row">
          <input id="mr-label" placeholder="What’s it for? (optional)" aria-label="Roll label" autocomplete="off">
          <button class="btn brass" data-act="mr-roll">${die(15)} Roll ${mr.n}d${mr.sides}${mr.mod ? signed(mr.mod).replace('−', '-') : ''}</button>
        </div>
        <form class="free-roll" id="free-form">
          <input id="free-input" placeholder="or type: 2d6+wits+1" aria-label="Dice formula" autocomplete="off">
          <button class="btn" type="submit">Roll</button>
        </form>
      </div>
      <div class="small dim">Rolling as <b style="color:var(--paper)">${esc(myName())}</b></div>
    </div>
    <div class="log-list" id="log-list">
      ${rolls.length ? rolls.map(entryHTML).join('') : '<p class="log-empty">No rolls yet. Click a stat on your sheet or roll here.</p>'}
    </div>`;
  $('#log-list').scrollTop = scroll;
  $('#free-input').value = draft;
  $('#mr-label').value = label;
  if (focusId === 'free-input' || focusId === 'mr-label') $('#' + focusId).focus();
  $('#free-form').onsubmit = e => { e.preventDefault(); freeRoll($('#free-input').value); };
  const fab = $('#fab-last');
  if (fab) fab.textContent = rolls[0] ? rolls[0].total : '';
}

function freeRoll(text) {
  const rec = S.sheets.get(mine());
  const f = parseFormula(text, rec && rec.data);
  if (!f) {
    toast(rec || !/[a-z]{3}/i.test(String(text).replace(/d\d+/gi, ''))
      ? 'Try something like 2d6+1 or 1d20.'
      : 'Stats in a formula only work when you’re logged in as a character.', true);
    return;
  }
  roll({ sheetId: rec ? rec.id : null, label: String(text).trim(), kind: 'free', ...f });
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

// ── Images ─────────────────────────────────────────────────────────────────

// Scale to fit `max` px on the long side (or centre-crop to a square).
async function shrinkImage(file, max, quality, square) {
  const bmp = await createImageBitmap(file);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
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
  if (el.dataset.sceneField) return sceneFieldChanged(el);
  if (!el.dataset.bind || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') return;
  const rec = currentSheet(el);
  if (!rec || !canEdit(rec)) return;
  const v = readValue(el);
  setLocal(rec.id, el.dataset.bind, v);
  queuePatch(rec.id, el.dataset.bind, v);
  if (el.dataset.bind === 'name') renderNav();
});

document.addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset.bind) return;
  const rec = currentSheet(el);
  if (!rec || !canEdit(rec)) return;
  const path = el.dataset.bind;
  const v = readValue(el);
  setLocal(rec.id, path, v);
  // Skills save as one object: older sheets stored them as a list.
  if (path.startsWith('skills.')) commit(rec.id, 'skills', rec.data.skills);
  else queuePatch(rec.id, path, v, 0);
  if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') {
    renderMain();
    if (el.type === 'color') renderNav();
  }
});

document.addEventListener('submit', async e => {
  const form = e.target;
  const kind = form.dataset.actForm;
  if (!kind) return;
  e.preventDefault();
  const input = form.querySelector('input[name="p"]');
  const value = input.value;
  try {
    if (kind === 'char-pass') {
      if (!value.trim()) { toast('Type a password first.', true); return; }
      await api('gm_set_char_password', { p_id: form.dataset.id, p_plain: value });
      const rec = S.sheets.get(form.dataset.id);
      toast(`Password for ${rec ? rec.data.name : 'character'} saved. Share it with them.`);
    } else if (kind === 'gm-pass') {
      await api('gm_set_gm_password', { p_plain: value });
      toast('GM password changed.');
    }
    input.value = '';
    S.since = null; sync();
  } catch (err) { fail(err); }
});

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) {
    // Clicking away closes the vault menu.
    if (S.vaultMenu && !e.target.closest('.v-menu')) { S.vaultMenu = null; renderVaultViews(); }
    return;
  }
  const act = el.dataset.act;
  const rec = currentSheet(el);
  const d = rec && rec.data;
  const n = +el.dataset.n, dd = +el.dataset.d, i = +el.dataset.i, si = +el.dataset.si, fi = +el.dataset.fi;
  if (el.tagName === 'A') e.preventDefault();

  switch (act) {
    // Shell
    case 'logout': signOut(); break;
    case 'log-toggle': S.logOpen = !S.logOpen; $('#log').classList.toggle('open', S.logOpen); break;
    case 'tab': S.tab = el.dataset.t; lsSet('debt.tab', S.tab); renderMain(); break;
    case 'customize': S.customize = !S.customize; renderMain(); break;
    case 'toggle-spec': S.spec = !S.spec; refreshLastRoll(); break;
    case 'bonus': S.bonus = Math.max(-10, Math.min(10, S.bonus + dd)); refreshLastRoll(); break;

    // Sheets (GM)
    case 'new-sheet': {
      try {
        const id = await api('create_sheet', { p_data: blankSheet('New Character') });
        ping(); await sync();
        S.tab = 'bio';
        location.hash = '#/c/' + id;
      } catch (err) { fail(err); }
      break;
    }
    case 'duplicate': {
      try {
        const copy = clone(d); copy.name = (d.name || 'Unnamed') + ' (copy)'; copy.accent = '';
        const id = await api('create_sheet', { p_data: copy });
        ping(); await sync();
        location.hash = '#/c/' + id;
        toast('Duplicated. Set a password for it on the GM page.');
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
      if (!confirm(`Delete ${d.name || 'this character'}? You can restore it from the GM page.`)) break;
      try {
        await api('delete_sheet', { p_id: rec.id });
        S.sheets.delete(rec.id);
        ping();
        location.hash = '#/crew';
        renderNav();
        sync();
      } catch (err) { fail(err); }
      break;
    }
    case 'lock': {
      try { await api('gm_set_lock', { p_id: rec.id, p_locked: !rec.locked }); rec.locked = !rec.locked; ping(); renderMain(); renderNav(); sync(); }
      catch (err) { fail(err); }
      break;
    }
    case 'portrait': $('#file-portrait').dataset.sheet = rec.id; $('#file-portrait').click(); break;
    case 'panel-toggle': {
      const k = el.dataset.k;
      const hidden = d.hidden.includes(k) ? d.hidden.filter(x => x !== k) : [...d.hidden, k];
      commit(rec.id, 'hidden', hidden); renderMain(); break;
    }

    // Sheet values
    case 'hp-step': commit(rec.id, 'hp', hpStep(d.hp, dd)); renderMain(); break;
    case 'temp-step': commit(rec.id, 'hp.temp', Math.max(0, (+d.hp.temp || 0) + dd)); renderMain(); break;
    case 'wear-set': commit(rec.id, 'wear', d.wear >= n ? n - 1 : n); renderMain(); renderLog(); break;
    case 'death-set': {
      const k = el.dataset.k, death = { ...d.death };
      death[k] = death[k] >= n ? n - 1 : n;
      death.stable = death.s >= 3 || (death.stable && k !== 's');
      commit(rec.id, 'death', death); renderMain(); break;
    }
    case 'death-reset': commit(rec.id, 'death', { s: 0, f: 0, stable: false }); renderMain(); break;
    case 'gear-add': commit(rec.id, 'gear', [...d.gear, '']); renderMain(); break;
    case 'gear-del': commit(rec.id, 'gear', d.gear.filter((_, j) => j !== i)); renderMain(); break;

    // Rolls from the sheet
    case 'roll-stat': {
      const st = STATS.find(s => s.k === el.dataset.k);
      roll({ sheetId: rec.id, label: st.n, kind: 'stat', parts: [statPart(d, st.k), ...nextRollParts(d)] });
      resetNextRoll(); break;
    }
    case 'roll-skill': case 'roll-skill-stat': {
      const sk = el.dataset.sk, st = STATS.find(s => s.k === statOf(sk));
      const skillPart = { label: `${sk} skill`, value: +d.skills[sk] || 0 };
      const withStat = act === 'roll-skill-stat';
      roll({
        sheetId: rec.id, kind: 'skill',
        label: withStat ? `${sk} + ${st.n}` : sk,
        parts: [...(withStat ? [statPart(d, st.k)] : []), skillPart, ...nextRollParts(d)],
      });
      resetNextRoll(); break;
    }
    case 'roll-hp': {
      if (d.hp.max != null && !confirm('Roll new HP? This replaces current and max HP.')) break;
      const r = await roll({ sheetId: rec.id, label: 'HP', kind: 'hp', parts: [{ label: 'Base HP', value: 6 }] });
      if (r) { await commit(rec.id, 'hp', { ...S.sheets.get(rec.id).data.hp, cur: r.total, max: r.total }); renderMain(); }
      break;
    }
    case 'roll-death': {
      const r = await roll({ sheetId: rec.id, label: 'Dropping', kind: 'death', parts: [statPart(d, 'composure')] });
      if (!r) break;
      await commit(rec.id, 'death', applyDeath(S.sheets.get(rec.id).data.death, deathOutcome(r.total), +1));
      renderMain();
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
      roll({ sheetId: rec.id, label: f.label || 'Roll', kind: 'check', n: parsed.n, sides: parsed.sides, parts: [...parsed.parts, ...nextRollParts(d)] });
      resetNextRoll(); break;
    }

    // Crew-wide
    case 'grit-set': setGrit(S.grit >= n ? n - 1 : n); break;
    case 'grit-adj': adjustGrit(dd); break;
    case 'grit-vv': adjustGrit(1, `${el.dataset.name || 'Someone'} acted on their Vice or Virtue: +1 Grit.`); break;
    case 'grit-session': roll({ sheetId: isGM() ? null : mine(), label: 'Session Grit', kind: 'grit_session', n: 1, sides: 6 }); break;
    case 'grit-open': {
      try { await api('gm_set_grit_open', { p_open: el.dataset.v === '1' }); S.gritOpen = el.dataset.v === '1'; ping(); renderMain(); }
      catch (err) { fail(err); }
      break;
    }

    // Dice log
    case 'mr-n': S.mr.n = Math.max(1, Math.min(20, S.mr.n + dd)); renderLog(); break;
    case 'mr-mod': S.mr.mod = Math.max(-20, Math.min(20, S.mr.mod + dd)); renderLog(); break;
    case 'mr-sides': S.mr.sides = +el.dataset.v; renderLog(); break;
    case 'mr-roll': {
      const recMe = S.sheets.get(mine());
      const lbl = ($('#mr-label').value || '').trim();
      const formula = `${S.mr.n}d${S.mr.sides}${S.mr.mod ? signed(S.mr.mod).replace('−', '-') : ''}`;
      roll({ sheetId: recMe ? recMe.id : null, label: lbl || formula, kind: 'free', n: S.mr.n, sides: S.mr.sides,
             parts: S.mr.mod ? [{ label: 'Modifier', value: S.mr.mod }] : [] });
      $('#mr-label').value = '';
      break;
    }
    case 'spend-grit': {
      el.disabled = true;
      try {
        const r = await api('spend_grit', { p_roll: +el.dataset.id });
        applyRoll(r); S.grit = Math.max(0, S.grit - 1); ping(); renderLog(); refreshMain(new Set(), true); sync();
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }
    case 'reroll': {
      el.disabled = true;
      try {
        const before = S.rolls.get(+el.dataset.id);
        const r = await api('reroll', { p_roll: +el.dataset.id });
        applyRoll(r); ping();
        if (before) await afterReroll(before, r);
        renderLog(); await sync(); refreshLastRoll();
        toast(`Rerolled with 1 Wear: ${r.total}`);
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }
    case 'mark-wear': {
      el.disabled = true;
      try { const r = await api('mark_wear', { p_roll: +el.dataset.id }); applyRoll(r); ping(); await sync(); renderLog(); toast('+1 Wear banked.'); }
      catch (err) { fail(err); el.disabled = false; }
      break;
    }

    // Scene window
    case 'win-min': S.win.min = true; S.win.full = false; saveWin(); renderScene(); break;
    case 'win-restore': S.win.min = false; saveWin(); renderScene(); break;
    case 'win-full': S.win.full = !S.win.full; renderScene(); break;

    // Vault
    case 'vault-box': {
      const code = el.dataset.code;
      S.vaultMenu = S.vaultMenu === code ? null : code;
      renderVaultViews();
      break;
    }
    case 'vault-set': {
      const code = el.dataset.code, state = el.dataset.state;
      const prev = S.vault.get(code);
      S.vault.set(code, { code, state, by: myName() });
      S.vaultMenu = null;
      renderVaultViews();
      try { await api('vault_set', { p_code: code, p_state: state }); ping(); }
      catch (err) { if (prev) S.vault.set(code, prev); renderVaultViews(); fail(err); }
      break;
    }
    case 'vault-reset': {
      if (!confirm('Clear every box in the Vault?')) break;
      try { await api('gm_vault_reset'); for (const b of S.vault.values()) b.state = ''; ping(); renderVaultViews(); }
      catch (err) { fail(err); }
      break;
    }

    // Scenes (GM)
    case 'scene-new': $('#file-scene').dataset.id = ''; $('#file-scene').click(); break;
    case 'scene-replace': $('#file-scene').dataset.id = el.dataset.id; $('#file-scene').click(); break;
    case 'scene-show': {
      try {
        await api('gm_scene_show', { p_id: el.dataset.id || null });
        ping(); await sync(); renderMain();
      } catch (err) { fail(err); }
      break;
    }
    case 'scene-del': {
      const sc = (S.scenes || []).find(x => x.id === el.dataset.id);
      if (!confirm(`Delete the scene “${sc ? sc.title || 'Untitled' : ''}”?`)) break;
      try { await api('gm_scene_delete', { p_id: el.dataset.id }); ping(); await loadScenes(); sync(); }
      catch (err) { fail(err); }
      break;
    }

    // GM
    case 'gm-clear': {
      if (!confirm('Clear the dice log for everyone?')) break;
      try { await api('gm_clear_rolls'); S.rolls.clear(); ping(); renderLog(); toast('Dice log cleared.'); } catch (err) { fail(err); }
      break;
    }
    case 'gm-restore': {
      try {
        await api('gm_restore_sheet', { p_id: el.dataset.id });
        S.deleted = S.deleted.filter(x => x.id !== el.dataset.id);
        ping(); await sync(); renderMain(); toast('Restored.');
      } catch (err) { fail(err); }
      break;
    }
  }
});

function renderVaultViews() {
  if (S.route.view === 'scenes') renderMain();
  const body = $('#scene-body');
  if (body && S.scene && S.scene.kind === 'vault') body.innerHTML = vaultHTML();
}

async function setGrit(v) {
  try { S.grit = await api('set_grit', { p_value: v }); ping(); refreshMain(new Set(), true); renderLog(); }
  catch (err) { fail(err); }
}
async function adjustGrit(delta, msg) {
  try {
    S.grit = await api('adjust_grit', { p_delta: delta });
    ping(); refreshMain(new Set(), true); renderLog();
    if (msg) toast(msg);
  } catch (err) { fail(err); }
}

let gmTimer = null;
function gmNotesChanged(value) {
  S.gmNotes = value;
  const s = $('#gm-saving'); if (s) s.textContent = 'Saving…';
  clearTimeout(gmTimer);
  gmTimer = setTimeout(async () => {
    try { await api('gm_set_notes', { p_body: value }); const el = $('#gm-saving'); if (el) el.textContent = 'Saved'; }
    catch (err) { fail(err); }
  }, 700);
}

const sceneTimers = {};
function sceneFieldChanged(el) {
  const id = el.dataset.id, sc = (S.scenes || []).find(x => x.id === id);
  if (!sc) return;
  sc[el.dataset.sceneField] = el.value;
  clearTimeout(sceneTimers[id]);
  sceneTimers[id] = setTimeout(async () => {
    try { await api('gm_scene_save', { p_id: id, p_title: sc.title, p_caption: sc.caption, p_image: null, p_thumb: null }); ping(); }
    catch (err) { fail(err); }
  }, 600);
}

document.addEventListener('change', async e => {
  const input = e.target;
  if (!['file-portrait', 'file-import', 'file-scene'].includes(input.id)) return;
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  if (input.id === 'file-portrait') {
    const id = input.dataset.sheet;
    try {
      await commit(id, 'portrait', await shrinkImage(file, 320, 0.82, true));
      renderMain(); renderNav();
    } catch { toast('Couldn’t read that image.', true); }
  } else if (input.id === 'file-import') {
    try {
      const data = JSON.parse(await file.text());
      if (!isObj(data)) throw new Error('bad');
      const id = await api('create_sheet', { p_data: normalize(data) });
      ping(); await sync();
      location.hash = '#/c/' + id;
      toast(`Imported ${data.name || 'character'}. Set a password for it on the GM page.`);
    } catch { toast('That file isn’t a Debt character.', true); }
  } else {
    const id = input.dataset.id || null;
    toast('Uploading scene…');
    try {
      const [image, thumb] = await Promise.all([shrinkImage(file, 1800, 0.85), shrinkImage(file, 360, 0.75)]);
      const title = id ? undefined : file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      const sc = id && (S.scenes || []).find(x => x.id === id);
      await api('gm_scene_save', { p_id: id, p_title: sc ? sc.title : title, p_caption: sc ? sc.caption : '', p_image: image, p_thumb: thumb });
      ping(); await loadScenes(); sync();
      toast(id ? 'Image replaced.' : 'Scene added. Press “Show to players” when you’re ready.');
    } catch (err) { if (err.code) fail(err); else toast('Couldn’t read that image.', true); }
  }
});

// ── Routing & boot ─────────────────────────────────────────────────────────

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, id] = h.split('/');
  if (view === 'c' && id) return { view: 'sheet', id };
  if (['rules', 'gm', 'scenes'].includes(view)) return { view };
  return { view: 'crew' };
}

window.addEventListener('hashchange', () => {
  const prev = S.route;
  S.route = parseRoute();
  if (prev.view !== S.route.view || prev.id !== S.route.id) { S.customize = false; S.vaultMenu = null; window.scrollTo(0, 0); }
  if (S.route.view === 'gm') S.gmNotes = null;
  if (S.logOpen && window.matchMedia('(max-width: 1100px)').matches) S.logOpen = false;
  if (!S.ready) return;
  renderNav(); renderMain(); renderLog();
});

function boot() {
  S.route = parseRoute();
  app.innerHTML = '<div class="gate"><p class="dim">Loading the crew…</p></div>';
  connectRealtime();
  sync();
  startPolling();
  setInterval(() => { if (S.ready && !document.hidden) renderLogTimes(); }, 30000);
}
function renderLogTimes() {
  const rolls = [...S.rolls.values()].sort((a, b) => b.id - a.id);
  document.querySelectorAll('.entry-time').forEach((el, j) => { if (rolls[j]) el.textContent = relTime(rolls[j].created_at); });
}

// v1 kept a shared password in the browser; drop it.
lsSet('beacon.pass', null); lsSet('beacon.gm', null); lsSet('beacon.who', null);
if (S.token) boot(); else renderLogin();
