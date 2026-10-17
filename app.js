/* Debt — crew portal.
 *
 * Plain browser JS, no build step. Data lives in Supabase and is reached only
 * through RPC functions (supabase/schema.sql + supabase/v3.sql) that check a
 * session token; the key below is the public "publishable" key and grants
 * nothing on its own.
 *
 * Roles: the GM sees and edits everything. A player logs in as one character
 * and edits only that sheet.
 *
 * Sync model: every client polls `sync` with the server time it last saw and
 * merges what changed. A Realtime broadcast "ping" after each write makes the
 * others sync straight away; the same channel carries live pen strokes and
 * location pings, which never touch the database. Sheet edits are small
 * per-field patches (lists are saved whole).
 */
'use strict';

const SB_URL  = 'https://kposvtazbuizognblzbb.supabase.co';
const SB_KEY  = 'sb_publishable_4IWxzlBAecz36z68OyukgA_fCaTjbX4';
const POLL_MS = 2500;
const GM_COLOR = '#f1e7c9';

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
const skillKey = s => s.toLowerCase().replace(/[^a-z]/g, '');
const VICES   = ['Greed', 'Pride', 'Wrath', 'Fear', 'Lust', 'Envy', 'Gluttony', 'Sloth'];
const VIRTUES = ['Loyalty', 'Mercy', 'Honesty', 'Fortitude', 'Hope', 'Charity', 'Humility', 'Diligence'];
const MOD = { 4: 2, 3: 1, 2: 0, 1: -1 };
const STAT_SPREAD = '4,3,3,2,2,1';
const PALETTE = ['#c9a24b', '#5fa8d3', '#d9776b', '#8fbf6a', '#b48ad6', '#e0a458', '#4fb3a9', '#d68fb0'];
const DICE_TYPES = [4, 6, 8, 10, 12, 20, 100];
const WEAPON_DIE = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const PEN_WIDTHS = [2, 3, 5, 8, 13];
// Text sizes (stored in the stroke's width field; see textPx).
const TEXT_SIZES = [[2, 'S'], [5, 'M'], [8, 'L'], [13, 'XL'], [20, 'XXL']];

const PANELS = {
  identity: 'Identity', look: 'Appearance', money: 'Money', gear: 'Gear', kit: 'Kit',
  backstory: 'Backstory', notes: 'Notes',
  stats: 'Stats & skills', hp: 'HP', dying: 'Dropping', wear: 'Wear',
};
const FIELD_TYPES = {
  text: 'Short text', long: 'Long text', number: 'Number',
  check: 'Checkbox', track: 'Tracker boxes', roll: 'Roll button',
};
// Sheet lists are always saved whole, so a missing list can never be
// recreated as an object by a nested patch (the v2 "blank page" bug).
const LIST_KEYS = ['gear', 'kit', 'custom', 'hidden'];

// The Vault, laid out like the sketch: A–J left, K–O centre top, P–Y right.
const VAULT_LEFT  = 'ABCDEFGHIJ'.split('');
const VAULT_MID   = 'KLMNO'.split('');
const VAULT_RIGHT = 'PQRSTUVWXY'.split('');
const VAULT_STATES = { '': 'Unmarked', open: 'Open', progress: 'In progress', complete: 'Complete' };

const blankGear = (kind = 'item') => ({ name: '', kind, dice: 1, die: 6, stat: 'strength', bonus: 0, effect: '' });
const blankKit = (kind = 'apparel') => ({ name: '', kind, durability: 0, reduction: 0 });

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
    gear: [blankGear(), blankGear(), blankGear()],
    kit: [],               // [{ name, kind: 'apparel'|'armor', durability, reduction }]
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
const stat = k => STATS.find(s => s.k === k) || STATS[0];

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }
function lsJSON(k, fallback) { try { return JSON.parse(lsGet(k)) || fallback; } catch { return fallback; } }

// Fill in anything the template has that the stored data is missing.
function withDefaults(tpl, data) {
  if (isObj(tpl)) {
    const out = isObj(data) ? { ...data } : {};
    for (const k of Object.keys(tpl)) out[k] = withDefaults(tpl[k], out[k]);
    return out;
  }
  if (Array.isArray(tpl)) {
    if (Array.isArray(data)) return data;
    // A list that was saved as {"0": …}: put it back in order.
    if (isObj(data)) return Object.keys(data).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b).map(k => data[k]);
    return clone(tpl);
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
  const out = withDefaults(blankSheet(), d);
  // Gear used to be plain strings; now each slot is an item or a weapon.
  out.gear = out.gear.map(g => (isObj(g) ? { ...blankGear(), ...g } : { ...blankGear(), name: String(g ?? '') }));
  out.kit = out.kit.map(k => (isObj(k) ? { ...blankKit(), ...k } : { ...blankKit(), name: String(k ?? '') }));
  return out;
}
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
function statMod(data, k) {
  const v = data.stats && data.stats[k];
  return v == null ? 0 : (MOD[v] ?? 0);
}
function statPart(data, k) {
  if (!k) return { label: 'No stat', value: 0 };
  const v = data.stats[k];
  return { label: `${stat(k).n}${v == null ? '' : ' (' + v + ')'}`, value: statMod(data, k) };
}
const wearMax = d => Math.max(1, Math.min(10, +d.wear_max || 3));
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
const REROLL_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>';
const EYE_OFF_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-5.9"/><path d="M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2"/><path d="M1 1l22 22"/></svg>';
const WARN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 15h-2v2h2v-2zm0-7h-2v5h2v-5z"/></svg>';

// ── State ──────────────────────────────────────────────────────────────────

const S = {
  token: lsGet('debt.token') || '',
  me: null,              // { role: 'gm'|'player', sheet_id }
  tab: lsGet('debt.tab') || 'bio',
  sheets: new Map(),     // id -> { id, data, sort, has_pass, updated_at }
  rolls: new Map(),      // id -> roll row
  anim: new Set(),       // "rollId:dice" / "rollId:grit" to animate on next render
  grit: 0,
  gritOpen: true,
  settings: {},
  rulesNote: '',
  live: [],              // scenes everyone can see: active ones + the Drawing Board
  liveKnown: null,       // ids seen so far (to pop new scenes open)
  scenesSig: null,
  scenes: null,          // GM: every scene
  vault: new Map(),      // code -> { state, by, danger }
  vaultLoaded: false,
  strokes: new Map(),    // scene id -> Map(stroke id -> stroke)
  strokesLoaded: new Set(),
  drafts: new Map(),     // live strokes from others: did -> { scene, color, width, points, t }
  images: new Map(),     // scene id -> { key, src }
  wins: lsJSON('debt.wins', {}),  // scene id -> { x, y, w, h, min, full }
  chat: [],
  chatDraft: '',
  chatPrivate: false,    // player: send privately to the GM
  chatTo: '',            // GM: '' = everyone, or a character id for a private message
  penWidth: +lsGet('debt.pen') || 3,
  textSize: +lsGet('debt.textsize') || 5,
  gmColor: lsGet('debt.gmcolor') || GM_COLOR,
  rulesTab: 'crew',
  gmSessions: null,
  since: null,
  ready: false,
  syncing: false,
  route: { view: 'crew' },
  customize: false,
  spec: false,           // next roll: add Specialty +2
  bonus: 0,              // next roll: extra modifier
  private: lsGet('debt.private') === '1',
  mr: { n: 2, sides: 6, mod: 0 },
  tool: 'pen',
  drawing: false,
  logOpen: false,
  seenRolls: new Set(),
  deferRender: false,
  gmNotes: null,
  deleted: null,
  vaultMenu: null,
  z: 40,
};
const pending = new Map(); // `${id}|${path}` -> { id, path, value, timer }

const isGM = () => !!S.me && S.me.role === 'gm';
const mine = () => S.me && S.me.sheet_id;
const canEdit = rec => !!rec && (isGM() || rec.id === mine());
const myName = () => (isGM() ? 'GM' : (S.sheets.get(mine()) || { data: { name: 'Player' } }).data.name);
const myColor = () => { if (isGM()) return S.gmColor; const r = S.sheets.get(mine()); return r ? accentOf(r) : GM_COLOR; };
const saveWins = () => lsSet('debt.wins', JSON.stringify(S.wins));

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
  no_wear: 'No Wear to spend. You bank it by rolling doubles.',
  cant_reroll: 'That roll can’t be rerolled.',
  not_yours: 'That isn’t your character.',
  gm_only: 'Only the GM can do that.',
  not_shown: 'That scene isn’t live right now.',
  too_big: 'That is too big to save. Try a smaller picture.',
  too_short: 'Use at least 4 characters.',
  not_found: 'That no longer exists. It may have been deleted.',
  empty: 'Type something first.',
  pick_player: 'Pick who the private message is for.',
};
function fail(err) {
  if (err && err.code === '28P01') return signOut('You were signed out. Log in again.');
  toast(ERRORS[err && err.message] || (err && err.message) || 'Something went wrong.', true);
}

// ── Realtime: sync pings, live strokes, location pings ─────────────────────

let channel = null;
function connectRealtime() {
  try {
    if (channel || !window.supabase) return;
    const client = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
    channel = client.channel('debt-crew', { config: { broadcast: { self: false } } });
    let t = null;
    channel.on('broadcast', { event: 'ping' }, () => { clearTimeout(t); t = setTimeout(sync, 120); });
    channel.on('broadcast', { event: 'draft' }, ({ payload: p }) => {
      if (!p || !p.did) return;
      let d = S.drafts.get(p.did);
      if (!d) { d = { scene: p.scene, color: p.color, width: p.width, points: [] }; S.drafts.set(p.did, d); }
      if (p.from === d.points.length) d.points.push(...p.pts);
      d.t = Date.now();
      redrawScene(p.scene);
    });
    channel.on('broadcast', { event: 'draft-end' }, ({ payload: p }) => {
      // Keep the live line until the saved stroke arrives.
      sync().then(() => { S.drafts.delete(p.did); redrawScene(p.scene); });
    });
    channel.on('broadcast', { event: 'loc' }, ({ payload: p }) => showLocPing(p));
    channel.subscribe();
  } catch { channel = null; /* polling still works */ }
}
function send(event, payload) {
  try { if (channel) channel.send({ type: 'broadcast', event, payload }); } catch { /* ignore */ }
}
const ping = () => send('ping', {});
setInterval(() => {
  const now = Date.now();
  for (const [k, d] of S.drafts) if (now - d.t > 8000) { S.drafts.delete(k); redrawScene(d.scene); }
}, 4000);

// ── Sync ───────────────────────────────────────────────────────────────────

function sheetRecord(rec) {
  const data = normalize(rec.data);
  // Keep what the user typed but hasn't been saved yet.
  for (const p of pending.values()) if (p.id === rec.id) setPath(data, p.path, clone(p.value));
  return { id: rec.id, data, sort: rec.sort, has_pass: rec.has_pass, updated_at: rec.updated_at, _json: JSON.stringify(data) };
}

function applySheet(rec) {
  const cur = S.sheets.get(rec.id);
  if (rec.deleted) { if (cur) { S.sheets.delete(rec.id); return true; } return false; }
  if (cur && cur.updated_at >= rec.updated_at) return false;
  const next = sheetRecord(rec);
  S.sheets.set(rec.id, next);
  return !cur || cur._json !== next._json || cur.sort !== next.sort || cur.has_pass !== next.has_pass;
}

// Remember which dice changed, so the log can animate just those.
function applyRoll(r) {
  const cur = S.rolls.get(r.id);
  if (cur && cur.updated_at === r.updated_at) return false;
  if (S.ready) {
    if (!cur) { S.anim.add(r.id + ':dice'); if ((r.extras || []).length) S.anim.add(r.id + ':grit'); }
    else {
      if (cur.dice.join() !== r.dice.join() || (cur.history || []).length !== (r.history || []).length) S.anim.add(r.id + ':dice');
      if (JSON.stringify(cur.extras) !== JSON.stringify(r.extras)) S.anim.add(r.id + ':grit');
    }
  }
  S.rolls.set(r.id, r);
  return true;
}

function applyStroke(st) {
  let m = S.strokes.get(st.scene_id);
  if (!m) { m = new Map(); S.strokes.set(st.scene_id, m); }
  if (st.deleted) return m.delete(st.id);
  const had = m.has(st.id);
  m.set(st.id, st);
  return !had;
}

async function sync() {
  if (S.syncing || !S.token) return;
  S.syncing = true;
  try {
    const since = S.since ? new Date(Date.parse(trimTs(S.since)) - 5000).toISOString() : null;
    const r = await api('sync', { p_since: since });
    S.since = r.now;
    S.me = r.me;
    const changed = new Set(), dirtyScenes = new Set();
    let rollsChanged = false, crewChanged = false, liveChanged = false, vaultChanged = false, chatChanged = false, rulesChanged = false;

    if (r.grit !== S.grit || r.grit_open !== S.gritOpen || JSON.stringify(r.settings) !== JSON.stringify(S.settings)) {
      S.grit = r.grit; S.gritOpen = r.grit_open; S.settings = r.settings || {}; crewChanged = true;
    }
    if (r.rules_note !== S.rulesNote) { S.rulesNote = r.rules_note || ''; rulesChanged = true; }
    for (const rec of r.sheets) if (applySheet(rec)) changed.add(rec.id);
    for (const roll of r.rolls) if (applyRoll(roll)) rollsChanged = true;
    for (const id of [...S.rolls.keys()]) {
      if (r.roll_min == null || id < r.roll_min) { S.rolls.delete(id); rollsChanged = true; }
    }
    if (S.rolls.size > 150) {
      [...S.rolls.keys()].sort((a, b) => a - b).slice(0, S.rolls.size - 150).forEach(k => S.rolls.delete(k));
    }
    for (const m of r.chat) if (!S.chat.some(x => x.id === m.id)) { S.chat.push(m); chatChanged = true; }
    if (S.chat.length > 200) S.chat = S.chat.slice(-200);

    // Live scenes: new ones pop open for everyone.
    const liveJson = JSON.stringify(r.scenes_live);
    if (liveJson !== JSON.stringify(S.live)) {
      const known = S.liveKnown;
      for (const sc of r.scenes_live) {
        if (sc.kind === 'board') continue;
        if (known && !known.has(sc.id)) { S.wins[sc.id] = { ...(S.wins[sc.id] || {}), min: false }; }
      }
      S.live = r.scenes_live;
      S.liveKnown = new Set(r.scenes_live.map(s => s.id));
      saveWins();
      liveChanged = true;
    } else if (!S.liveKnown) S.liveKnown = new Set(r.scenes_live.map(s => s.id));

    for (const st of r.strokes) { applyStroke(st); dirtyScenes.add(st.scene_id); }
    for (const sc of S.live) {
      if (!S.strokesLoaded.has(sc.id)) { S.strokesLoaded.add(sc.id); if (S.ready) loadStrokes(sc.id); }
    }
    for (const id of [...S.strokesLoaded]) if (!S.live.some(s => s.id === id) && !isGM()) S.strokesLoaded.delete(id);

    const vaultVisible = S.live.some(s => s.kind === 'vault');
    if (r.vault) for (const b of r.vault) { S.vault.set(b.code, b); vaultChanged = true; }
    if (!vaultVisible && !isGM()) S.vaultLoaded = false;
    if ((vaultVisible || isGM()) && !S.vaultLoaded) { await loadVault(); vaultChanged = true; }

    if (isGM() && r.scenes_sig !== S.scenesSig) { S.scenesSig = r.scenes_sig; loadScenes(); }

    if (!S.ready) { S.ready = true; renderApp(); return; }
    if (changed.size) renderNav();
    if (changed.size || crewChanged || (vaultChanged && S.route.view === 'scenes') || (liveChanged && S.route.view === 'scenes')) refreshMain(changed, crewChanged);
    if (rulesChanged && S.route.view === 'rules') refreshMain(new Set(), true);
    if (rollsChanged || crewChanged || changed.size) renderLog();
    if (chatChanged) renderChat();
    if (liveChanged || vaultChanged || changed.size) renderScenes();
    else if (vaultChanged) renderVaultViews();
    for (const id of dirtyScenes) redrawScene(id);
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
  } catch { /* not live any more */ }
}

async function loadStrokes(sceneId) {
  try {
    const rows = await api('get_strokes', { p_scene: sceneId });
    S.strokes.set(sceneId, new Map(rows.map(st => [st.id, st])));
    redrawScene(sceneId);
  } catch { S.strokesLoaded.delete(sceneId); }
}

async function loadScenes() {
  try {
    S.scenes = await api('gm_scenes');
    if (S.route.view === 'scenes') refreshMain(new Set(), true);
    renderTurnsViews();
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
// Paths inside a list save the whole list.
function savePath(rec, path) {
  const top = path.split('.')[0];
  return LIST_KEYS.includes(top) || top === 'skills' ? top : path;
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
  const bar = $('#modbar'), rec = S.route.view === 'sheet' && S.sheets.get(S.route.id);
  if (bar && rec) bar.outerHTML = modbarHTML(rec);
}

async function roll({ sheetId = null, label, kind = 'free', n = 2, sides = 6, parts = [] }) {
  try {
    const r = await api('roll', {
      p_sheet: sheetId, p_label: label, p_kind: kind, p_n: n, p_sides: sides,
      p_parts: parts, p_private: S.private,
    });
    applyRoll(r);
    S.anim.add(r.id + ':dice');
    ping();
    renderLog();
    if (r.wear_marked === 1) toast(`Doubles! ${r.who} banks 1 Wear.`);
    else if (window.matchMedia('(max-width: 1100px)').matches && !S.logOpen) {
      toast(`${r.who} · ${r.label}: ${r.total}${isDoubles(r) ? ' · doubles!' : ''}`);
    }
    sync();
    return r;
  } catch (err) { fail(err); return null; }
}

// Doubles = exactly two dice showing the same face, on any die type.
const isDoubles = r => r.dice.length === 2 && r.dice[0] === r.dice[1];

// "2d6+wits+perception+2" -> { n, sides, parts }. Stat and skill names need a sheet.
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
    const sk = ALL_SKILLS.find(x => skillKey(x) === t || skillKey(x).startsWith(t) && t.length >= 4);
    if (sk && data) { parts.push({ label: `${sk} skill`, value: sign * (+data.skills[sk] || 0) }); continue; }
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
      <span class="avatar xl" style="${o.portrait ? `background-image:url('${esc(o.portrait)}')` : ''}">${o.portrait ? '' : esc((o.name || '?').charAt(0).toUpperCase())}</span>
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
            <span class="avatar xl">GM</span><span class="who-name">Game Master</span>
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
  S.live = []; S.liveKnown = null; S.scenes = null; S.scenesSig = null;
  S.strokes.clear(); S.strokesLoaded.clear(); S.chat = [];
  S.gmNotes = null; S.deleted = null; S.customize = false;
  canvases.clear(); winEls.clear();
  if (tok && !msg) { try { await rpc('logout', { p_token: tok }); } catch { /* already gone */ } }
  location.hash = '#/crew';
  renderLogin(msg);
}

// ── Rendering: shell ───────────────────────────────────────────────────────

function renderApp() {
  canvases.clear(); winEls.clear();
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
    <div id="scene-root"><div class="pill-bar" id="pill-bar"></div></div>
    <button class="log-fab" id="log-fab" data-act="log-toggle" aria-label="Open dice">${die(22)}<span id="fab-last"></span></button>
    <input type="file" id="file-portrait" accept="image/*" hidden>
    <input type="file" id="file-import" accept="application/json,.json" hidden>
    <input type="file" id="file-scene" accept="image/*" hidden>`;
  renderNav();
  renderMain();
  renderLog();
  renderScenes();
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
  // Players: Crew, Rules, their own sheet, then everyone else's.
  const sheets = orderedSheets().sort((a, b) => (b.id === mine()) - (a.id === mine()));
  const liveCount = S.live.filter(s => s.kind !== 'board').length;
  nav.innerHTML = [
    `<a href="#/crew" class="${r.view === 'crew' ? 'on' : ''}">Crew</a>`,
    `<a href="#/rules" class="${r.view === 'rules' ? 'on' : ''}">Rules</a>`,
    ...sheets.map(rec =>
      `<a href="#/c/${rec.id}" class="${r.view === 'sheet' && r.id === rec.id ? 'on' : ''} ${rec.id === mine() ? 'mine' : ''}">
         <span class="sw" style="background:${esc(accentOf(rec))}"></span>${esc(rec.data.name || 'Unnamed')}${rec.id === mine() ? ' <small class="you">you</small>' : ''}</a>`),
    ...(isGM() ? [
      `<a href="#/scenes" class="gm-link ${r.view === 'scenes' ? 'on' : ''}">Scenes${liveCount ? ` <small class="live-count">${liveCount} live</small>` : ''}</a>`,
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
  if (S.drawing) { S.deferRender = true; return; }
  const a = document.activeElement;
  const key = a && main.contains(a) && (a.dataset.bind || a.dataset.fk);
  let s0 = null, s1 = null;
  try { s0 = a.selectionStart; s1 = a.selectionEnd; } catch { /* not a text field */ }

  const r = S.route;
  if (r.view === 'sheet' && S.sheets.has(r.id)) main.innerHTML = sheetHTML(S.sheets.get(r.id));
  else if (r.view === 'rules') main.innerHTML = rulesHTML();
  else if (r.view === 'gm' && isGM()) { main.innerHTML = gmHTML(); if (S.gmNotes === null) loadGM(); }
  else if (r.view === 'scenes' && isGM()) { main.innerHTML = scenesHTML(); renderTurnsViews(); }
  else { main.innerHTML = crewHTML(); mountBoard(); renderChat(true); }
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
  } else {
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
        <div class="line"><span class="k">Wear</span>${pipsHTML(wearMax(d), d.wear, 'wear-set', '', 'red sm', !ed)}</div>
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

  const canSession = S.gritOpen || gm;
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
              <button class="btn brass" data-act="grit-session" ${canSession ? '' : 'disabled'}>${die(16)} Session roll 1d6</button>
            </div>
          </div>
          <div style="margin-top:14px">${pipsHTML(10, S.grit, 'grit-set', '', 'big')}</div>
          <div class="row between note">
            <span>${S.gritOpen ? 'Session roll is open: anyone can roll it once at the start of the session.' : 'Session roll used. The GM reopens it next session.'}</span>
            ${gm ? `<button class="btn sm" data-act="grit-open" data-v="${S.gritOpen ? 0 : 1}">${S.gritOpen ? 'Close session roll' : 'Reopen session roll'}</button>` : ''}
          </div>
          <p class="small dim" style="margin:8px 0 0">Spend 1 Grit to add 1d6 to any d6 roll, yours or anyone else’s, even after seeing it. Use <b>+ Grit</b> on a roll in the dice log. Max 1 per roll.</p>
        </section>
        <section class="panel s5 chat-panel">
          <h2>Chat</h2>
          <div class="chat-list" id="chat-list"></div>
          <form class="chat-form" id="chat-form">
            ${isGM()
              ? `<select id="chat-to" aria-label="Send to"><option value="">To everyone</option>${orderedSheets().map(r => `<option value="${r.id}" ${S.chatTo === r.id ? 'selected' : ''}>Private to ${esc(r.data.name)}</option>`).join('')}</select>`
              : `<button type="button" class="btn sm chat-priv ${S.chatPrivate ? 'on' : ''}" data-act="chat-priv" aria-pressed="${S.chatPrivate}" title="Only the GM sees it">${EYE_OFF_SVG} GM only</button>`}
            <input id="chat-input" data-fk="chat-input" placeholder="${chatPlaceholder()}" autocomplete="off" maxlength="1000" value="${esc(S.chatDraft)}" aria-label="Chat message">
            <button class="btn brass" type="submit">Send</button>
          </form>
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
      <section class="panel board-panel" style="margin-top:22px">
        <h2><span class="grow">Drawing board</span><span class="small dim" style="font-family:var(--type)">Shared with everyone</span></h2>
        <div id="board-slot"></div>
      </section>
    </div>`;
}

function chatPlaceholder() {
  if (isGM()) { const r = S.sheets.get(S.chatTo); return r ? `Private message to ${r.data.name}…` : 'Say something to the crew…'; }
  return S.chatPrivate ? 'Private message to the GM…' : 'Say something to the crew…';
}

function renderChat(force) {
  const list = $('#chat-list');
  if (!list) return;
  const nearBottom = force || list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const nameOf = id => { const r = S.sheets.get(id); return r ? r.data.name : 'a player'; };
  list.innerHTML = S.chat.length ? S.chat.map(m => {
    const rec = m.sheet_id && S.sheets.get(m.sheet_id);
    const color = rec ? accentOf(rec) : GM_COLOR;
    let tag = '';
    if (m.private) {
      const fromMe = isGM() ? !m.sheet_id : m.sheet_id === mine();
      tag = isGM()
        ? (m.sheet_id ? `Private from ${esc(m.who)}` : `Private to ${esc(nameOf(m.to_sheet))}`)
        : (fromMe ? 'Private to the GM' : 'Private from the GM');
      tag = `<span class="tag private">${EYE_OFF_SVG} ${tag}</span>`;
      if (isGM() && m.sheet_id && !fromMe) tag += ` <button class="btn sm ghost chat-reply" data-act="chat-reply" data-id="${m.sheet_id}">Reply privately</button>`;
    }
    return `
      <div class="chat-msg ${m.private ? 'private' : ''}">
        ${rec ? avatarHTML(rec, 'xs') : '<span class="avatar xs gm-av">GM</span>'}
        <div><b style="color:${esc(color)}">${esc(m.who)}</b> <span class="chat-time">${relTime(m.created_at)}</span> ${tag}
          <div class="chat-body">${esc(m.body)}</div></div>
      </div>`;
  }).join('') : '<p class="small dim" style="margin:auto">No messages yet.</p>';
  if (nearBottom) list.scrollTop = list.scrollHeight;
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
      <fieldset ${canEdit(rec) ? '' : 'disabled'}>${body}</fieldset>
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

function modbarHTML(rec) {
  const d = rec.data, ed = canEdit(rec);
  return `
    <div class="modbar" id="modbar">
      <span class="lbl">Next roll</span>
      <button class="btn sm ${S.spec ? 'on' : ''}" data-act="toggle-spec" aria-pressed="${S.spec}" ${ed ? '' : 'disabled'}
        title="${esc(d.specialty ? 'Specialty: ' + d.specialty : 'No specialty written yet')}">
        Specialty +2${d.specialty ? `: <b>${esc(d.specialty)}</b>` : ''}</button>
      <span class="lbl">Bonus</span>
      <span class="stepper">
        <button data-act="bonus" data-d="-1" aria-label="Lower bonus" ${ed ? '' : 'disabled'}>−</button><b>${signed(S.bonus)}</b><button data-act="bonus" data-d="1" aria-label="Raise bonus" ${ed ? '' : 'disabled'}>+</button>
      </span>
      <span class="spacer"></span>
      <span class="small dim">${S.private ? `${EYE_OFF_SVG} Rolling privately` : 'Click a stat to roll 2d6 + stat'}</span>
    </div>`;
}

function sheetHTML(rec) {
  const d = rec.data, ed = canEdit(rec), gm = isGM();
  const tab = S.tab === 'attr' ? 'attr' : 'bio';
  const banner = !ed ? `<div class="banner">Viewing ${esc(d.name)}’s sheet. Only ${esc(d.name)} and the GM can change it.</div>` : '';
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
          <label class="portrait-btn ${ed ? '' : 'ro'}" title="${ed ? 'Change portrait' : ''}">
            ${avatarHTML(rec, 'lg')}${ed ? '<span class="chg">Change</span><input type="file" accept="image/*" class="portrait-input" data-sheet-file="' + rec.id + '">' : ''}
          </label>
          <div class="sheet-id">
            <input class="name-input" data-bind="name" value="${esc(d.name)}" aria-label="Character name" placeholder="Name" ${ed ? '' : 'disabled'}>
            <div class="row">
              <input data-bind="player" value="${esc(d.player)}" placeholder="Player" aria-label="Player" style="max-width:220px" ${ed ? '' : 'disabled'}>
              <span class="saving" id="saving"></span>
            </div>
          </div>
          <div class="sheet-tools">
            ${ed ? `<label class="row small dim" title="Sheet colour">Colour <input type="color" data-bind="accent" value="${esc(accentOf(rec))}"></label>
                    <button class="btn sm ${S.customize ? 'on' : ''}" data-act="customize">Customize</button>
                    <button class="btn sm ghost" data-act="export">Export</button>` : ''}
            ${ed && d.portrait ? `<button class="btn sm ghost" data-act="portrait-clear">Remove picture</button>` : ''}
            ${gm ? `<button class="btn sm ghost" data-act="duplicate">Duplicate</button>
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

function gearRow(d, g, i) {
  const weapon = g.kind === 'weapon';
  const m = statMod(d, g.stat) + (+g.bonus || 0);
  return `
    <div class="gear-item ${weapon ? 'weapon' : ''}">
      <div class="gear-row">
        <span class="n">${i + 1}.</span>
        <select data-bind="gear.${i}.kind" aria-label="Item or weapon" class="gear-kind">
          <option value="item" ${weapon ? '' : 'selected'}>Item</option>
          <option value="weapon" ${weapon ? 'selected' : ''}>Weapon</option>
        </select>
        <input data-bind="gear.${i}.name" value="${esc(g.name)}" placeholder="${weapon ? 'Weapon name' : 'Item'}" aria-label="Gear slot ${i + 1}">
        ${weapon ? `<button class="roll-btn" data-act="roll-weapon" data-i="${i}" title="Roll damage: ${g.dice || 1}d${g.die || 6} ${signed(m)}" aria-label="Roll ${esc(g.name || 'weapon')} damage">${DIE_SVG}</button>` : ''}
        <button class="icon-btn" data-act="gear-del" data-i="${i}" aria-label="Remove slot ${i + 1}">×</button>
      </div>
      ${weapon ? `
        <div class="weapon-row">
          <label class="wfield"><span>Damage</span>
            <span class="row" style="gap:4px;flex-wrap:nowrap">
              <input type="number" min="1" max="20" data-type="num" data-bind="gear.${i}.dice" value="${esc(g.dice || 1)}" aria-label="Number of damage dice">
              <select data-bind="gear.${i}.die" data-type="num" aria-label="Damage die">${WEAPON_DIE.map(n => `<option value="${n}" ${(+g.die || 6) === n ? 'selected' : ''}>d${n}</option>`).join('')}</select>
            </span></label>
          <label class="wfield"><span>+ Stat</span>
            <select data-bind="gear.${i}.stat" aria-label="Damage stat">
              <option value="" ${g.stat ? '' : 'selected'}>No stat (+0)</option>
              ${STATS.map(s => `<option value="${s.k}" ${g.stat === s.k ? 'selected' : ''}>${s.n}</option>`).join('')}
            </select></label>
          <label class="wfield"><span>+ Bonus</span>
            <input type="number" data-type="num" data-bind="gear.${i}.bonus" value="${esc(g.bonus || 0)}" aria-label="Permanent damage bonus"></label>
          <label class="wfield grow"><span>Effect</span>
            <input data-bind="gear.${i}.effect" value="${esc(g.effect || '')}" placeholder="e.g. Bleed, Knockdown" aria-label="Weapon effect"></label>
        </div>` : ''}
    </div>`;
}

function kitRow(k, i) {
  const armor = k.kind === 'armor';
  return `
    <div class="gear-item ${armor ? 'armor' : ''}">
      <div class="gear-row">
        <span class="n">${i + 1}.</span>
        <select data-bind="kit.${i}.kind" aria-label="Apparel or armor" class="gear-kind">
          <option value="apparel" ${armor ? '' : 'selected'}>Apparel</option>
          <option value="armor" ${armor ? 'selected' : ''}>Armor</option>
        </select>
        <input data-bind="kit.${i}.name" value="${esc(k.name)}" placeholder="${armor ? 'Armor name' : 'What you’re wearing'}" aria-label="Kit ${i + 1}">
        <button class="icon-btn" data-act="kit-del" data-i="${i}" aria-label="Remove kit ${i + 1}">×</button>
      </div>
      ${armor ? `
        <div class="weapon-row">
          <label class="wfield"><span>Durability</span><input type="number" data-type="num" data-bind="kit.${i}.durability" value="${esc(k.durability ?? 0)}" aria-label="Durability"></label>
          <label class="wfield"><span>Damage reduction</span><input type="number" data-type="num" data-bind="kit.${i}.reduction" value="${esc(k.reduction ?? 0)}" aria-label="Damage reduction"></label>
        </div>` : ''}
    </div>`;
}

function bioTab(rec) {
  const d = rec.data;
  return [
    panel(rec, 'identity', 's6', `
      ${field('Job', 'job', d)}
      ${field('Specialty (+2)', 'specialty', d, 'placeholder="The one thing you’re known for"')}
      ${selectField('Vice', 'vice', d, VICES)}
      ${selectField('Virtue', 'virtue', d, VIRTUES)}
      <p class="note">Act on your Vice or Virtue: the crew gains +1 Grit.</p>`),
    panel(rec, 'look', 's6', `
      ${field('Height', 'look.height', d)}
      ${field('Skin', 'look.skin', d)}
      ${field('Hair', 'look.hair', d)}
      ${field('Eyes', 'look.eyes', d)}
      ${field('Unique markings', 'look.markings', d)}`),
    panel(rec, 'money', 's4', `
      <p class="small dim" style="margin-top:-6px">Starting cash is 2d6 × $60.</p>
      <div class="field"><label>Starting $</label><input type="number" data-type="num" data-bind="money.rolled" value="${esc(d.money.rolled)}"></div>
      <div class="field"><label>Left $</label><input type="number" data-type="num" data-bind="money.left" value="${esc(d.money.left)}"></div>`),
    panel(rec, 'gear', 's8', `
      <p class="small dim" style="margin-top:-6px">${d.gear.length} slots · 3 to start, more can be earned. A weapon rolls its damage dice + a stat + a permanent bonus.</p>
      ${d.gear.map((g, i) => gearRow(d, g, i)).join('')}
      <div class="row" style="margin-top:8px">
        <button class="btn sm" data-act="gear-add" data-kind="item">+ Item</button>
        <button class="btn sm" data-act="gear-add" data-kind="weapon">+ Weapon</button>
      </div>`),
    panel(rec, 'kit', 's12', `
      <p class="small dim" style="margin-top:-6px">Apparel is anything you wear. Armor has Durability and Damage Reduction.</p>
      ${d.kit.length ? d.kit.map(kitRow).join('') : '<p class="small dim">Nothing yet.</p>'}
      <div class="row" style="margin-top:8px">
        <button class="btn sm" data-act="kit-add" data-kind="apparel">+ Apparel</button>
        <button class="btn sm" data-act="kit-add" data-kind="armor">+ Armor</button>
      </div>`),
    panel(rec, 'backstory', 's12', `
      <p class="small dim" style="margin-top:-6px">This is how you earn a Specialty.</p>
      <textarea data-bind="backstory" rows="6" aria-label="Backstory">${esc(d.backstory)}</textarea>`),
    panel(rec, 'notes', 's12', `<textarea data-bind="notes" rows="5" aria-label="Notes">${esc(d.notes)}</textarea>`),
    customSections(rec, 'bio'),
  ].join('');
}

function attrTab(rec) {
  const d = rec.data, gm = isGM();
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
          <button class="roll-chip both" data-act="roll-skill" data-sk="${esc(sk)}" title="2d6 + ${st.n} + ${sk}">${die(13)} ${st.s} + ${sk.split(' ')[0]} ${signed(m + b)}</button>
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
  const de = d.death, wm = wearMax(d);
  const deathState = de.f >= 3 ? '<span class="warn">Dead.</span>'
    : de.stable ? '<span class="ok">Stable. Out, but you’ll live.</span>'
    : dying ? 'Dying. Roll again next round.' : 'Not dropping.';

  return [
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
      ${pipsHTML(wm, d.wear, 'wear-set', '', 'red big')}
      <p class="small" style="margin:12px 0 0"><b>${d.wear}</b> of ${wm} rerolls banked.</p>
      <p class="note">Doubles bank 1 Wear automatically. Spend 1 to reroll any of your rolls from the dice log.</p>`,
      gm ? `<span class="stepper gm-step" title="GM: Wear boxes for this character"><button data-act="wear-max" data-d="-1" aria-label="Fewer Wear boxes">−</button><b>${wm} boxes</b><button data-act="wear-max" data-d="1" aria-label="More Wear boxes">+</button></span>` : ''),
    panel(rec, 'stats', 's12', `
      <p class="small dim" style="margin-top:-6px">Stats: assign 4, 3, 3, 2, 2, 1 (4 = +2 · 3 = +1 · 2 = +0 · 1 = −1).
        Skills: pick 3 at +1 or 2 at +2, from the stat each belongs to. Roll a stat on its own, or a stat with one of its skills.</p>
      <div class="stat-grid">${blocks}</div>
      <div class="row between check-line">
        <span class="${spreadOK ? 'ok' : 'dim'}">${spreadOK ? '✓ Stats match 4, 3, 3, 2, 2, 1' : assigned.length ? 'Stats: ' + vals.map(x => x ?? '—').join(', ') + ' · should be 4, 3, 3, 2, 2, 1' : 'No stats assigned yet'}</span>
        <span class="${skillsOK ? 'ok' : 'dim'}">${skillsOK ? '✓ Skills fit the rules' : trained.length ? 'Skills: usually 3 at +1 or 2 at +2' : 'No skills picked yet'}</span>
      </div>`),
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
        ? `<input data-bind="${base}.formula" value="${esc(f.formula || '')}" placeholder="e.g. 2d6+dex+stealth" aria-label="Roll formula">`
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
      <p class="note">Roll formulas: dice plus numbers, stats or skills, like <b>2d6+wits+perception</b>, <b>1d20+2</b>, <b>2d6+dex+spec</b>.</p>
    </section>`;
}

// ── Rendering: rules ───────────────────────────────────────────────────────

function rulesHTML() {
  const gm = isGM(), combatOn = !!S.settings.combat_visible;
  const canCombat = gm || combatOn;
  const tab = canCombat && S.rulesTab === 'combat' ? 'combat' : 'crew';
  return `
    <div class="wrap rules">
      <h1 class="page-title">Rules</h1>
      <div class="tabs" role="tablist">
        <button role="tab" class="${tab === 'crew' ? 'on' : ''}" aria-selected="${tab === 'crew'}" data-act="rules-tab" data-t="crew">Crew rules</button>
        ${canCombat ? `<button role="tab" class="${tab === 'combat' ? 'on' : ''}" aria-selected="${tab === 'combat'}" data-act="rules-tab" data-t="combat">Combat rules${gm && !combatOn ? ' <small class="hidden-tag">hidden from players</small>' : ''}</button>` : ''}
      </div>
      ${tab === 'combat' ? combatRulesHTML() : crewRulesHTML()}
    </div>`;
}

function crewRulesHTML() {
  const gm = isGM();
  return `
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
          <p>The job grinds you down. Roll <span class="hl">doubles</span> and you bank 1 Wear automatically. Spend 1 Wear to <span class="hl">reroll</span> any of your rolls. You can bank up to 3 (the GM can grant more).</p>
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
          <p class="small"><span class="hl">Pick 3 at +1</span> or <span class="hl">pick 2 at +2</span>, your choice. Each skill belongs to one stat and is always rolled with it.</p>
          <div class="sk">${STATS.map(s => `<div><b>${s.n}</b>${SKILLS[s.k].join(', ')}</div>`).join('')}</div>
        </section>
        ${gm || S.rulesNote ? `
        <section class="panel s12">
          <h2><span class="grow">From the GM</span>${gm ? '<span class="saving" id="rules-saving"></span>' : ''}</h2>
          ${gm ? `<textarea id="rules-note" data-fk="rules-note" rows="8" placeholder="House rules, clarifications, anything the crew should read. Players see this but can’t edit it.">${esc(S.rulesNote)}</textarea>`
               : `<div class="rules-note">${esc(S.rulesNote)}</div>`}
        </section>` : ''}
      </div>`;
}

// Combat rules, from the GM's "Crew Rules: Combat" sheet. Reference only:
// nothing else in the app uses these numbers.
const COMBAT_WEAPONS = [
  ['Punch', '1d3', '—'], ['Kick', '1d3', '—'], ['Knife', '1d4+2', 'Bleed'], ['Baseball bat', '1d4+1', 'Knockdown'],
  ['Brass knuckles', '1d4+1', '—'], ['Baton', 'None', 'Disarm'], ['Taser', '1d2+1', 'Stun'],
  ['Pepper spray', '1d2+1', 'Blind'], ['Pistol', '1d5', '—'], ['Shotgun', '1d8+1', 'Knockdown'],
];
const COMBAT_ARMOR = [
  ['Thick coat', 1, '2 hits'], ['Work boots', 1, '2 hits'], ['Motorcycle helmet', 1, '2 hits'],
  ['Kevlar vest', 2, '4 hits'], ['Ballistic plate', 3, '6 hits'],
];
const COMBAT_STATUS = [
  ['Bleed', 'Lose 2 HP at the start of each turn until bandaged. Bandaging takes 1 action, and anyone can do it.', 'Stopped by: bandages or healing'],
  ['Knockdown', 'Fall prone. Standing up costs 1 action.', 'Resist: 2d6 + Dexterity or Strength'],
  ['Disarm', 'Drop your weapon. Picking it up costs 1 action, or is free if you roll Dexterity 8+.', 'Resist: 2d6 + Dexterity or Strength'],
  ['Pinned', 'Can’t move. Can still act, but can’t leave. Each turn you can spend 1 action to try to break free.', 'Resist: 2d6 + Dexterity or Strength'],
  ['Silenced', 'Can’t call for help. Can’t shout. Each turn you can spend 1 action to try to break free.', 'Resist: 2d6 + Dexterity or Strength'],
  ['Deafened', 'Can’t hear. Miss verbal cues. Can’t coordinate. −2 to Wits or Composure rolls for one round.', 'Resist: 2d6 + Wits or Composure'],
  ['Shaken', '−2 to your next roll.', 'Resist: 2d6 + Wits or Composure'],
  ['Stunned', 'Lose 1 action on your next turn, and −2 to your next roll.', 'Resist: 2d6 + Wits or Composure'],
  ['Blinded', 'Can’t see for one round. −2 to all rolls.', 'Resist: 2d6 + Wits or Composure'],
];
const COMBAT_ACTIONS = [
  ['Attack', 'Hit someone (only one attack per turn)'],
  ['Move', 'Cross a room, reach cover, climb a ladder'],
  ['Help', 'Bandage someone, use painkillers or adrenaline, shove, pick a lock'],
  ['Stand or recover', 'Stand up, pick up a dropped weapon'],
];

function combatRulesHTML() {
  const gm = isGM(), on = !!S.settings.combat_visible;
  return `
      ${gm ? `<div class="banner ${on ? '' : 'lock'}">
        ${on ? 'Players can see this tab.' : `${EYE_OFF_SVG} Hidden from players. Only you can see it.`}
        <span class="spacer"></span>
        <button class="btn sm ${on ? '' : 'brass'}" data-act="combat-show" data-v="${on ? 0 : 1}">${on ? 'Hide from players' : 'Show to players'}</button>
      </div>` : ''}
      <div class="grid combat">
        <div class="s6" style="display:grid;gap:16px;align-content:start">
          <section class="panel">
            <h2>Turns</h2>
            <p><span class="hl">Order.</span> At the start of a fight, everyone rolls 2d6 + Dexterity or Wits. Highest goes first, then down the order, and it stays the same every round. Ties go to the higher modifier, then to the players.</p>
            <p><span class="hl">Your turn.</span> You get 2 actions. You can spend them on anything, and you can do the same thing twice.</p>
            <table class="rtable"><thead><tr><th>Action</th><th>Examples</th></tr></thead>
              <tbody>${COMBAT_ACTIONS.map(a => `<tr><td>${a[0]}</td><td>${a[1]}</td></tr>`).join('')}</tbody></table>
            <p style="margin-top:10px"><span class="hl">Free.</span> Talking, shouting, dropping something, and spending Grit don’t cost an action.</p>
            <p><span class="hl">Gear.</span> Bandages, painkillers, adrenaline and a medkit each take 1 action in a fight. Outside a fight, a medkit takes a minute.</p>
          </section>
          <section class="panel">
            <h2>HP and dropping to 0</h2>
            <p>When you hit 0 HP, you don’t act. You drop and roll 2d6 + Composure.</p>
            <div class="tiers">
              <div><b>10+</b><span>You’re stable. You’re out, but you’ll live.</span></div>
              <div><b>7–9</b><span>Mark a success. Roll again next round.</span></div>
              <div><b>6−</b><span>Mark a fail. Roll again next round.</span></div>
            </div>
            <p>Three successes and you stabilize. You’re unconscious but alive.</p>
            <p class="warn">Three fails and you’re dead.</p>
          </section>
        </div>
        <div class="s6" style="display:grid;gap:16px;align-content:start">
          <section class="panel">
            <h2>Attacking</h2>
            <p>When you attack, roll 2d6 plus a stat.</p>
            <p><span class="hl">Dexterity</span> for aimed weapons: pistol, shotgun, taser, pepper spray, knife.</p>
            <p><span class="hl">Strength</span> for swung weapons and fists: punch, kick, bat, brass knuckles, baton.</p>
            <h3>When you hit, choose one</h3>
            <p><span class="hl">Damage.</span> Roll damage. They take it. Armor reduces it.</p>
            <p><span class="hl">Effect.</span> They resist. If they fail, they get the effect. No damage.</p>
          </section>
          <section class="panel">
            <h2>Weapons</h2>
            <table class="rtable"><thead><tr><th>Weapon</th><th>Damage</th><th>Effect</th></tr></thead>
              <tbody>${COMBAT_WEAPONS.map(w => `<tr><td>${w[0]}</td><td>${w[1]}</td><td>${w[2]}</td></tr>`).join('')}</tbody></table>
          </section>
          <section class="panel">
            <h2>Armor</h2>
            <table class="rtable"><thead><tr><th>Armor</th><th>Reduces</th><th>Breaks after</th></tr></thead>
              <tbody>${COMBAT_ARMOR.map(a => `<tr><td>${a[0]}</td><td>${a[1]}</td><td>${a[2]}</td></tr>`).join('')}</tbody></table>
            <p class="dim small" style="margin-top:10px">You can wear multiple pieces.</p>
          </section>
        </div>
        <section class="panel s12">
          <h2>Status effects</h2>
          <div class="st">${COMBAT_STATUS.map(x => `<div><b>${x[0]}</b>${x[1]}<i>${x[2]}</i></div>`).join('')}</div>
        </section>
      </div>`;
}

// ── Rendering: GM page ─────────────────────────────────────────────────────

function gmHTML() {
  const deleted = S.deleted || [];
  const notes = S.gmNotes || { body: '', session: '' };
  const rows = orderedSheets().map(rec => `
    <div class="gm-row" data-sheet="${rec.id}">
      ${avatarHTML(rec, 'sm')}
      <a href="#/c/${rec.id}" class="gm-name">${esc(rec.data.name || 'Unnamed')}</a>
      <span class="tag ${rec.has_pass ? 'green' : 'red'}">${rec.has_pass ? 'Password set' : 'No password'}</span>
      <form class="row gm-pass" data-act-form="char-pass" data-id="${rec.id}">
        <input type="text" name="p" placeholder="${rec.has_pass ? 'New password' : 'Set a password'}" autocomplete="off" aria-label="Password for ${esc(rec.data.name)}" data-fk="pw-${rec.id}">
        <button class="btn sm" type="submit">Save</button>
      </form>
      <span class="stepper" title="Wear boxes"><button data-act="wear-max" data-d="-1" aria-label="Fewer Wear boxes">−</button><b>${wearMax(rec.data)} Wear</b><button data-act="wear-max" data-d="1" aria-label="More Wear boxes">+</button></span>
    </div>`).join('');

  return `
    <div class="wrap">
      <h1 class="page-title">GM</h1>
      <div class="grid">
        <section class="panel s12">
          <h2>Characters &amp; logins</h2>
          <p class="small dim" style="margin-top:-6px">Players log in by picking their character and typing the password you give them. Saving a new password signs that player out. Wear boxes are 3 by default; raise them for anyone you like.</p>
          ${rows || '<p class="dim small">No characters yet.</p>'}
          <div class="row" style="margin-top:12px"><button class="btn sm" data-act="new-sheet">+ New character</button></div>
        </section>
        <section class="panel s6">
          <h2><span class="grow">GM Session Notes</span><button class="btn sm brass" data-act="session-add">+ New session</button></h2>
          ${sessionsHTML()}
        </section>
        <section class="panel s6">
          <h2><span class="grow">GM Notes</span><span class="saving" id="gm-saving-body"></span></h2>
          <textarea id="gm-notes-body" data-fk="gm-notes-body" rows="14" placeholder="Secrets, plans, NPCs. Only the GM can see this.">${esc(notes.body)}</textarea>
        </section>
        <section class="panel s4">
          <h2>Settings</h2>
          ${settingToggle('reroll_grit', 'Wear rerolls the Grit die too', 'Off: a Wear reroll only rerolls the original dice and the Grit die stays.')}
          ${settingToggle('combat_visible', 'Show Combat rules to players', 'Off: only you can see the Combat rules tab.')}
        </section>
        <section class="panel s4">
          <h2>Session Grit roll</h2>
          <p class="small" style="margin-top:-4px">${S.gritOpen ? 'Open: anyone can roll it once.' : 'Closed: already rolled this session.'}</p>
          <button class="btn" data-act="grit-open" data-v="${S.gritOpen ? 0 : 1}">${S.gritOpen ? 'Close it' : 'Reopen for a new session'}</button>
        </section>
        <section class="panel s4">
          <h2>GM password</h2>
          <form class="row" data-act-form="gm-pass">
            <input type="text" name="p" placeholder="New GM password" autocomplete="off" aria-label="New GM password" data-fk="gm-pw">
            <button class="btn sm" type="submit">Change</button>
          </form>
          <h2 style="margin-top:18px">Dice log</h2>
          <button class="btn danger" data-act="gm-clear">Clear for everyone</button>
        </section>
        <section class="panel s12">
          <h2>Deleted characters</h2>
          ${deleted.length ? deleted.map(x => `
            <div class="row between" style="padding:6px 0;border-bottom:1px dashed var(--line)">
              <span>${esc(x.name || 'Unnamed')}</span>
              <span class="row">
                <button class="btn sm" data-act="gm-restore" data-id="${x.id}">Restore</button>
                <button class="btn sm danger" data-act="gm-purge" data-id="${x.id}" data-name="${esc(x.name || 'Unnamed')}">Delete forever</button>
              </span>
            </div>`).join('') : '<p class="small dim">None.</p>'}
        </section>
      </div>
    </div>`;
}

function settingToggle(key, title, desc) {
  const on = !!S.settings[key];
  return `
    <label class="setting-row">
      <span class="setting-text"><b>${title}</b><small>${desc}</small></span>
      <span class="switch"><input type="checkbox" role="switch" data-setting="${key}" ${on ? 'checked' : ''} aria-checked="${on}"><i></i></span>
    </label>`;
}

function sortedSessions() {
  return [...(S.gmSessions || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
}
// Session #1 is the earliest; the newest is shown first.
function sessionsHTML() {
  if (S.gmSessions === null) return '<p class="small dim">Loading…</p>';
  const list = sortedSessions();
  if (!list.length) return '<p class="small dim">No session notes yet. Start one for today.</p>';
  return `<div class="sessions">${list.map((g, i) => ({ g, n: i + 1 })).reverse().map(({ g, n }) => `
    <div class="session-note">
      <div class="row">
        <b class="session-num">Session #${n}</b>
        <input type="date" data-session-date="${g.id}" value="${esc(g.date)}" aria-label="Date of session ${n}">
        <span class="saving" id="ss-${g.id}"></span>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="session-del" data-id="${g.id}" aria-label="Delete session ${n} notes">×</button>
      </div>
      <textarea data-session-body="${g.id}" data-fk="sb-${g.id}" rows="5" placeholder="What happened in session ${n}…" aria-label="Notes for session ${n}">${esc(g.body)}</textarea>
    </div>`).join('')}</div>`;
}

async function loadGM() {
  try {
    const [notes, deleted, sessions] = await Promise.all([api('gm_get_notes'), api('gm_deleted_sheets'), api('gm_sessions')]);
    S.gmNotes = notes; S.deleted = deleted; S.gmSessions = sessions;
    if (S.route.view === 'gm') renderMain();
  } catch (err) { fail(err); }
}

// ── Rendering: scenes page (GM) ────────────────────────────────────────────

function scenesHTML() {
  const list = (S.scenes || []).filter(s => s.kind !== 'board');
  const liveList = list.filter(s => s.active);
  const cards = list.map(sc => {
    const thumb = sc.kind === 'vault'
      ? `<div class="scene-thumb vault-thumb">${vaultMiniHTML()}</div>`
      : sc.kind === 'turns'
      ? `<div class="scene-thumb turns-thumb">${normTurns(sc.state).entries.slice(0, 5).map((e, i) => `<span>${i + 1}. ${esc(e.name)}</span>`).join('') || '<span class="dim">Empty</span>'}</div>`
      : `<div class="scene-thumb" style="${sc.thumb ? `background-image:url('${esc(sc.thumb)}')` : ''}"></div>`;
    return `
      <section class="panel scene-card ${sc.active ? 'live' : ''}" data-scene="${sc.id}">
        ${sc.active ? '<span class="live-ribbon"><span class="live-dot"></span> LIVE</span>' : ''}
        ${thumb}
        <div class="scene-card-body">
          <input data-scene-field="title" data-id="${sc.id}" data-fk="st-${sc.id}" value="${esc(sc.title)}" placeholder="Title" aria-label="Scene title" class="scene-title-input">
          ${sc.kind === 'turns' ? '<p class="small dim">Built-in. Only you control it; players just watch. Edit it below or in its window.</p>'
            : sc.kind === 'vault' ? '<p class="small dim">Built-in. Players can mark boxes while it’s live. Mark DANGER boxes from its box menu.</p>'
            : `<textarea data-scene-field="caption" data-id="${sc.id}" data-fk="sc-${sc.id}" rows="2" placeholder="Caption (optional)" aria-label="Scene caption">${esc(sc.caption)}</textarea>`}
          <div class="row">
            <button class="btn sm ${sc.active ? '' : 'brass'}" data-act="scene-live" data-id="${sc.id}" data-v="${sc.active ? 0 : 1}">${sc.active ? 'Hide from players' : 'Show to players'}</button>
            ${sc.kind === 'turns' ? ''
              : sc.kind === 'vault'
              ? `<button class="btn sm ghost" data-act="vault-reset">Clear all boxes</button>`
              : `<button class="btn sm ghost" data-act="scene-clear" data-id="${sc.id}">Clear markings</button>
                 <button class="btn sm ghost" data-act="scene-replace" data-id="${sc.id}">Replace image</button>
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
          <span class="small ${liveList.length ? '' : 'dim'}">${liveList.length ? `<span class="live-dot"></span> Live now: <b style="color:var(--paper)">${liveList.map(s => esc(s.title || 'Untitled')).join(', ')}</b>` : 'Nothing is live.'}</span>
          <button class="btn brass" data-act="scene-new">+ Upload a scene</button>
        </div>
      </div>
      <p class="small dim">Upload a map or picture, then show it. Each live scene pops up in its own window for everyone, and several can be live at once. Everyone can draw, erase and ping on picture scenes.</p>
      <div class="scene-grid">${S.scenes === null ? '<p class="dim">Loading…</p>' : cards}</div>
      ${turnsScene() ? `<section class="panel" style="margin-top:18px"><h2>Turn Order</h2><div class="turns-host"></div></section>` : ''}
      ${S.vaultLoaded ? `<section class="panel" style="margin-top:18px"><h2>Vault editor</h2>
        <p class="small dim" style="margin-top:-6px">Mark boxes and DANGER here any time. DANGER stays hidden from players until a box is opened.</p>
        <div class="vault-host">${vaultHTML()}</div></section>` : ''}
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
  const gm = isGM();
  const rows = letters => letters.map(l => `
    <div class="v-row">
      <span class="v-letter">${l}</span>
      ${[1, 2, 3, 4].map(n => {
        const code = l + n, b = S.vault.get(code) || { state: '' };
        const st = b.state || '';
        // Players only learn about danger once the box is opened.
        const danger = b.danger && (gm || st);
        return `<button class="v-box s-${st || 'none'} ${danger ? (st ? 'danger' : 'danger-hidden') : ''} ${S.vaultMenu === code ? 'menu-open' : ''}" data-act="vault-box" data-code="${code}"
                  title="${code} · ${VAULT_STATES[st]}${danger ? ' · DANGER' : ''}${b.by && st ? ' · by ' + esc(b.by) : ''}">${danger ? WARN_SVG : ''}${code}</button>`;
      }).join('')}
    </div>`).join('');
  const counts = { open: 0, progress: 0, complete: 0 };
  for (const b of S.vault.values()) if (counts[b.state] != null) counts[b.state]++;
  const mb = S.vaultMenu && (S.vault.get(S.vaultMenu) || {});
  const menu = S.vaultMenu ? `
    <div class="v-menu" role="menu" aria-label="Mark ${S.vaultMenu}">
      <b>${S.vaultMenu}</b>
      ${Object.entries(VAULT_STATES).map(([k, v]) => `<button class="btn sm v-opt s-${k || 'none'}" data-act="vault-set" data-code="${S.vaultMenu}" data-state="${k}">${k ? '' : '× '}${v}</button>`).join('')}
      ${gm ? `<button class="btn sm danger" data-act="vault-danger" data-code="${S.vaultMenu}" data-v="${mb.danger ? 0 : 1}">${WARN_SVG} ${mb.danger ? 'Clear DANGER' : 'Mark DANGER'}</button>` : ''}
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
        <span><i class="danger-key"></i> Danger</span>
      </div>
    </div>`;
}

// ── Rendering: Turn Order (GM-controlled, read-only for players) ──────────

function turnsScene() {
  return (isGM() && S.scenes && S.scenes.find(x => x.kind === 'turns')) || S.live.find(x => x.kind === 'turns') || null;
}
function normTurns(st) {
  const t = isObj(st) ? st : {};
  const entries = Array.isArray(t.entries) ? t.entries : [];
  return { entries, current: Math.max(0, Math.min(entries.length - 1, +t.current || 0)), round: Math.max(1, +t.round || 1) };
}

function turnsHTML(sc) {
  const gm = isGM(), st = normTurns(sc && sc.state);
  const cur = st.entries[st.current];
  const rows = st.entries.map((e, i) => {
    const rec = e.sheet_id && S.sheets.get(e.sheet_id);
    const color = rec ? accentOf(rec) : (e.color || '#9aa3a6');
    const av = rec ? avatarHTML(rec, 'sm') : `<span class="avatar sm" style="--accent:${esc(color)}">${esc((e.name || '?').charAt(0).toUpperCase())}</span>`;
    return `
      <div class="turn-row ${i === st.current ? 'current' : ''}" style="--accent:${esc(color)}">
        <span class="turn-pos">${i === st.current ? '▶' : i + 1}</span>
        ${av}
        <span class="turn-name">${esc(rec ? rec.data.name : e.name)}${rec ? '' : ' <small class="dim">extra</small>'}</span>
        ${gm ? `<input type="number" class="turn-init" data-turn-init="${esc(e.id)}" value="${e.init ?? ''}" placeholder="Init" aria-label="Initiative for ${esc(e.name)}">`
             : (e.init != null && e.init !== '' ? `<span class="turn-init-ro" title="Initiative">${esc(e.init)}</span>` : '')}
        ${gm ? `<span class="row" style="gap:2px">
          <button class="icon-btn" data-act="turn-move" data-id="${esc(e.id)}" data-d="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-act="turn-move" data-id="${esc(e.id)}" data-d="1" aria-label="Move down" ${i === st.entries.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn" data-act="turn-del" data-id="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">×</button></span>` : ''}
      </div>`;
  }).join('');
  const inList = new Set(st.entries.map(e => e.sheet_id).filter(Boolean));
  const free = orderedSheets().filter(r => !inList.has(r.id));
  return `
    <div class="turns">
      <div class="turn-head">
        <span class="turn-round">Round ${st.round}</span>
        <span class="turn-now">${cur ? `<b>${esc(cur.sheet_id && S.sheets.get(cur.sheet_id) ? S.sheets.get(cur.sheet_id).data.name : cur.name)}</b>’s turn` : 'No one in the order yet'}</span>
      </div>
      ${gm ? `
      <div class="row turn-ctrl">
        <button class="btn sm" data-act="turn-step" data-d="-1" ${st.entries.length ? '' : 'disabled'}>◀ Back</button>
        <button class="btn sm brass" data-act="turn-step" data-d="1" ${st.entries.length ? '' : 'disabled'}>Next turn ▶</button>
        <span class="spacer"></span>
        <button class="btn sm ghost" data-act="turn-sort" ${st.entries.length > 1 ? '' : 'disabled'} title="Highest initiative first">Sort by initiative</button>
        <button class="btn sm ghost" data-act="turn-reset" ${st.entries.length ? '' : 'disabled'}>New fight</button>
      </div>` : ''}
      <div class="turn-list">${rows || '<p class="small dim" style="text-align:center;margin:18px 0">The GM hasn’t set up the order yet.</p>'}</div>
      ${gm ? `
      <div class="turn-add">
        <form class="row" data-act-form="turn-add-sheet">
          <select name="sheet" aria-label="Add a character"><option value="">Add a character…</option>${free.map(r => `<option value="${r.id}">${esc(r.data.name)}</option>`).join('')}</select>
          <button class="btn sm" type="submit" ${free.length ? '' : 'disabled'}>Add</button>
        </form>
        <form class="row" data-act-form="turn-add-name">
          <input name="name" placeholder="Add an extra (NPC, enemy…)" maxlength="40" aria-label="Name of an extra" autocomplete="off">
          <button class="btn sm" type="submit">Add</button>
        </form>
        ${st.entries.length ? '<button class="btn sm danger" data-act="turn-clear">Clear the order</button>' : ''}
      </div>` : ''}
    </div>`;
}

// Re-render every place the Turn Order shows, unless the GM is typing in it.
function renderTurnsViews() {
  const sc = turnsScene();
  if (!sc) return;
  const html = turnsHTML(sc);
  document.querySelectorAll('.turns-host').forEach(host => {
    if (host.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
  });
}

async function saveTurns(mutate) {
  const sc = turnsScene();
  if (!sc) return;
  const st = normTurns(clone(sc.state));
  mutate(st);
  st.current = Math.max(0, Math.min(st.entries.length - 1, st.current));
  for (const list of [S.scenes || [], S.live]) { const x = list.find(y => y.id === sc.id); if (x) x.state = clone(st); }
  renderTurnsViews();
  try { await api('gm_scene_state', { p_id: sc.id, p_state: st }); ping(); }
  catch (err) { fail(err); S.since = null; }
}

function renderVaultViews() {
  if (S.route.view === 'scenes') { const h = $('#main .vault-host'); if (h) h.innerHTML = vaultHTML(); }
  for (const [id, w] of winEls) {
    const sc = S.live.find(s => s.id === id);
    if (sc && sc.kind === 'vault') w.querySelector('.scene-body').innerHTML = vaultHTML();
  }
}

// ── Drawing: pen, eraser, ping on image scenes and the Drawing Board ───────

const canvases = new Map(); // scene id -> component

function canvasFor(sc) {
  let c = canvases.get(sc.id);
  if (!c) { c = makeCanvas(sc); canvases.set(sc.id, c); }
  return c;
}

function toolsHTML(sc) {
  const gm = isGM();
  const names = { pen: '✎ Pen', erase: '⌫ Erase', text: 'T Text', select: '✥ Move text', ping: '◎ Ping' };
  return `
    <div class="draw-tools">
      ${Object.keys(names).map(t => `<button class="tool ${S.tool === t ? 'on' : ''}" data-tool="${t}">${names[t]}</button>`).join('')}
      <span class="widths pen-only" role="radiogroup" aria-label="Pen width">${PEN_WIDTHS.map(w => `<button class="wbtn ${S.penWidth === w ? 'on' : ''}" data-width="${w}" role="radio" aria-checked="${S.penWidth === w}" aria-label="Pen width ${w}" title="Pen width ${w}"><i style="width:${Math.min(15, w + 2)}px;height:${Math.min(15, w + 2)}px"></i></button>`).join('')}</span>
      <span class="tsizes text-only" role="radiogroup" aria-label="Text size">${TEXT_SIZES.map(([w, l], i) => `<button class="tsbtn ${S.textSize === w ? 'on' : ''}" data-tsize="${w}" role="radio" aria-checked="${S.textSize === w}" title="Text size ${l}" style="font-size:${10 + i * 2.5}px">${l}</button>`).join('')}</span>
      ${gm ? `<label class="swatch gm-swatch" title="Your pen colour (GM only)" style="background:${esc(myColor())}"><input type="color" value="${esc(myColor())}" data-gm-color aria-label="Pen colour"></label>`
           : `<span class="swatch" style="background:${esc(myColor())}" title="Your colour"></span>`}
      <span class="spacer"></span>
      ${gm ? `<button class="btn sm ghost" data-clear="${sc.id}">Clear all</button>` : ''}
    </div>`;
}

// Text size on the scene, in CSS px for a box `boxW` wide.
const textPx = (w, boxW) => (12 + w * 2.2) * (boxW / 900);

function openTextInput(c, x, y) {
  c.box.querySelectorAll('.text-entry').forEach(n => n.remove());
  const inp = document.createElement('input');
  inp.className = 'text-entry';
  inp.maxLength = 300;
  inp.placeholder = 'Type, then Enter';
  inp.style.left = (x * 100) + '%'; inp.style.top = (y * 100) + '%';
  inp.style.color = myColor();
  inp.style.fontSize = Math.max(11, textPx(S.textSize, c.box.clientWidth)) + 'px';
  c.box.appendChild(inp);
  setTimeout(() => inp.focus(), 0);
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const text = inp.value.trim();
    inp.remove();
    if (!save || !text) return;
    try {
      const st = await api('add_stroke', { p_scene: c.id, p_color: myColor(), p_width: S.textSize, p_points: [x, y], p_text: text });
      applyStroke(st); redraw(c); ping();
    } catch (err) { fail(err); }
  };
  inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', ev => ev.stopPropagation());
}

function makeCanvas(sc) {
  const el = document.createElement('div');
  el.className = 'draw ' + sc.kind;
  el.dataset.tool = S.tool;
  el.innerHTML = `${toolsHTML(sc)}
    <div class="draw-stage"><div class="draw-box">${sc.kind === 'image' ? '<img class="draw-img" alt="" draggable="false">' : ''}<canvas></canvas><div class="pings"></div></div></div>`;
  const c = { id: sc.id, kind: sc.kind, el, stage: el.querySelector('.draw-stage'), box: el.querySelector('.draw-box'),
              canvas: el.querySelector('canvas'), img: el.querySelector('.draw-img'),
              aspect: sc.kind === 'board' ? 16 / 7 : 16 / 10, imgKey: null, cur: null, erase: null };

  el.addEventListener('click', e => {
    const t = e.target.closest('.tool[data-tool]');   // the .draw wrapper carries data-tool too
    if (t) {
      S.tool = t.dataset.tool;
      document.querySelectorAll('.draw-tools .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === S.tool));
      document.querySelectorAll('.draw-box, .draw').forEach(b => { b.dataset.tool = S.tool; });
      return;
    }
    const ts = e.target.closest('[data-tsize]');
    if (ts) {
      S.textSize = +ts.dataset.tsize; lsSet('debt.textsize', String(S.textSize));
      document.querySelectorAll('.tsbtn').forEach(b => { const on = +b.dataset.tsize === S.textSize; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
      return;
    }
    const wb = e.target.closest('[data-width]');
    if (wb) {
      S.penWidth = +wb.dataset.width; lsSet('debt.pen', String(S.penWidth));
      document.querySelectorAll('.wbtn').forEach(b => { const on = +b.dataset.width === S.penWidth; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
      return;
    }
    const clr = e.target.closest('[data-clear]');
    if (clr && confirm('Clear every marking on this scene for everyone?')) {
      api('gm_clear_strokes', { p_scene: c.id }).then(() => { const m = S.strokes.get(c.id); if (m) m.clear(); redrawScene(c.id); ping(); }).catch(fail);
    }
  });

  const box = c.box;
  box.dataset.tool = S.tool;
  const norm = e => {
    const r = box.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 10000) / 10000,
            Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 10000) / 10000];
  };
  let lastSend = 0;
  box.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const [x, y] = norm(e);
    if (S.tool === 'ping') { const p = { scene: c.id, x, y, color: myColor(), who: myName() }; showLocPing(p); send('loc', p); return; }
    if (S.tool === 'text') { e.preventDefault(); openTextInput(c, x, y); return; }
    if (S.tool === 'select') {
      const h = hitText(c, e);
      if (!h) return;
      e.preventDefault();
      try { box.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      S.drawing = true;
      c.drag = { id: h.id, dx: x - h.points[0], dy: y - h.points[1] };
      return;
    }
    e.preventDefault();
    try { box.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ }
    S.drawing = true;
    if (S.tool === 'pen') c.cur = { did: uid(), color: myColor(), width: S.penWidth, points: [x, y], sent: 0 };
    else { c.erase = new Set(); eraseAt(c, e); }
  });
  box.addEventListener('pointermove', e => {
    if (c.drag) {
      const st = (S.strokes.get(c.id) || new Map()).get(c.drag.id);
      if (!st) return;
      const [x, y] = norm(e);
      const r4 = v => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
      st.points = [r4(x - c.drag.dx), r4(y - c.drag.dy)];
      redraw(c);
      return;
    }
    if (c.cur) {
      const [x, y] = norm(e), p = c.cur.points;
      const dx = x - p[p.length - 2], dy = y - p[p.length - 1];
      if (dx * dx + dy * dy < 0.000004) return;
      p.push(x, y);
      redraw(c);
      if (Date.now() - lastSend > 70) {
        lastSend = Date.now();
        send('draft', { scene: c.id, did: c.cur.did, color: c.cur.color, width: c.cur.width, from: c.cur.sent, pts: p.slice(c.cur.sent) });
        c.cur.sent = p.length;
      }
    } else if (c.erase) eraseAt(c, e);
  });
  const end = async () => {
    S.drawing = false;
    if (c.drag) {
      const drag = c.drag, st = (S.strokes.get(c.id) || new Map()).get(drag.id);
      c.drag = null;
      if (st) {
        try { applyStroke(await api('move_stroke', { p_id: drag.id, p_points: st.points })); ping(); }
        catch (err) { fail(err); S.since = null; }
      }
      if (S.deferRender) renderMain();
      return;
    }
    const cur = c.cur, er = c.erase;
    c.cur = null; c.erase = null;
    if (cur && cur.points.length >= 4) {
      send('draft', { scene: c.id, did: cur.did, color: cur.color, width: cur.width, from: cur.sent, pts: cur.points.slice(cur.sent) });
      S.drafts.set(cur.did, { scene: c.id, color: cur.color, width: cur.width, points: cur.points, t: Date.now() + 20000 });
      try {
        const st = await api('add_stroke', { p_scene: c.id, p_color: cur.color, p_width: cur.width, p_points: cur.points });
        applyStroke(st);
      } catch (err) { fail(err); }
      S.drafts.delete(cur.did);
      send('draft-end', { scene: c.id, did: cur.did });
      ping();
      redraw(c);
    }
    if (er && er.size) {
      try { await api('erase_strokes', { p_ids: [...er] }); ping(); } catch (err) { fail(err); S.since = null; }
    }
    if (S.deferRender) renderMain();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  if (window.ResizeObserver) new ResizeObserver(() => layout(c)).observe(c.stage);
  return c;
}

// Fit the drawing box to its stage at the scene's aspect ratio.
function layout(c) {
  const W = c.stage.clientWidth, H = c.stage.clientHeight;
  if (!W) return;
  let w = W, h = W / c.aspect;
  if (c.kind === 'image' && H && h > H) { h = H; w = H * c.aspect; }
  c.box.style.width = Math.round(w) + 'px';
  c.box.style.height = Math.round(h) + 'px';
  const dpr = window.devicePixelRatio || 1;
  c.canvas.width = Math.round(w * dpr); c.canvas.height = Math.round(h * dpr);
  redraw(c);
}

function strokePath(ctx, pts, W, H) {
  ctx.beginPath();
  ctx.moveTo(pts[0] * W, pts[1] * H);
  if (pts.length === 2) ctx.lineTo(pts[0] * W + 0.1, pts[1] * H);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * W, pts[i + 1] * H);
}

function redraw(c) {
  const ctx = c.canvas.getContext('2d'), W = c.canvas.width, H = c.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const scale = W / 900;
  const draw = s => {
    if (s.text) {
      ctx.fillStyle = s.color;
      ctx.font = `${Math.round((12 + s.width * 2.2) * scale)}px "Special Elite", "Courier New", monospace`;
      ctx.textBaseline = 'middle';
      ctx.fillText(s.text, s.points[0] * W, s.points[1] * H);
      return;
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(1.5, s.width * scale); strokePath(ctx, s.points, W, H); ctx.stroke();
  };
  for (const s of (S.strokes.get(c.id) || new Map()).values()) draw(s);
  for (const d of S.drafts.values()) if (d.scene === c.id && d.points.length >= 2) draw(d);
  if (c.cur) draw(c.cur);
}
function redrawScene(id) { const c = canvases.get(id); if (c) redraw(c); }

// Select tool: the topmost text label under the pointer.
function hitText(c, e) {
  const r = c.box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const ctx = c.canvas.getContext('2d');
  let hit = null;
  for (const s of (S.strokes.get(c.id) || new Map()).values()) {
    if (!s.text) continue;
    const fs = textPx(s.width, r.width);
    ctx.font = `${fs}px "Special Elite", "Courier New", monospace`;
    const tw = ctx.measureText(s.text).width, x0 = s.points[0] * r.width, yc = s.points[1] * r.height;
    if (px > x0 - 8 && px < x0 + tw + 8 && Math.abs(py - yc) < fs / 2 + 8) hit = s;
  }
  return hit;
}

// Eraser: rub out whole strokes that pass under the pointer.
function eraseAt(c, e) {
  const r = c.box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, R = 12;
  const m = S.strokes.get(c.id);
  if (!m) return;
  let hit = false;
  for (const [id, s] of m) {
    const p = s.points;
    if (s.text) {
      const fs = textPx(s.width, r.width), x0 = p[0] * r.width, yc = p[1] * r.height;
      if (px > x0 - R && px < x0 + s.text.length * fs * 0.62 + R && Math.abs(py - yc) < fs / 2 + R) { c.erase.add(id); m.delete(id); hit = true; }
      continue;
    }
    for (let i = 0; i < p.length - 2; i += 2) {
      if (segDist(px, py, p[i] * r.width, p[i + 1] * r.height, p[i + 2] * r.width, p[i + 3] * r.height) < R) {
        c.erase.add(id); m.delete(id); hit = true; break;
      }
    }
    if (p.length === 2 && Math.hypot(px - p[0] * r.width, py - p[1] * r.height) < R) { c.erase.add(id); m.delete(id); hit = true; }
  }
  if (hit) redraw(c);
}
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function showLocPing(p) {
  const c = canvases.get(p.scene);
  if (!c) return;
  const host = c.el.querySelector('.pings');
  const dot = document.createElement('div');
  dot.className = 'loc-ping';
  dot.style.left = (p.x * 100) + '%'; dot.style.top = (p.y * 100) + '%';
  dot.style.setProperty('--c', p.color || GM_COLOR);
  dot.innerHTML = `<i></i><i></i><span>${esc(p.who || '')}</span>`;
  host.appendChild(dot);
  setTimeout(() => dot.remove(), 1400);
}

function mountBoard() {
  const slot = $('#board-slot');
  const sc = S.live.find(s => s.kind === 'board');
  if (!slot || !sc) return;
  const c = canvasFor(sc);
  slot.appendChild(c.el);
  layout(c);
}

// ── Floating scene windows (one per live scene) ────────────────────────────

const winEls = new Map(); // scene id -> window element

async function sceneImage(sc) {
  const hit = S.images.get(sc.id);
  if (hit && hit.key === sc.updated_at) return hit.src;
  const src = await api('get_scene_image', { p_id: sc.id });
  S.images.set(sc.id, { key: sc.updated_at, src });
  return src;
}

// New windows cascade into the first spot no other live window is using.
function winState(id) {
  const w = S.wins[id] || (S.wins[id] = {});
  if (w.x == null) {
    const taken = S.live.filter(s => s.id !== id && S.wins[s.id] && S.wins[s.id].x != null).map(s => S.wins[s.id].x + ',' + S.wins[s.id].y);
    let k = 0;
    while (taken.includes((24 + k * 36) + ',' + (84 + k * 36))) k++;
    w.x = 24 + k * 36; w.y = 84 + k * 36; w.w = 600; w.h = 480;
  }
  return w;
}

function renderScenes() {
  const root = $('#scene-root');
  if (!root) return;
  const live = S.live.filter(s => s.kind !== 'board');
  for (const [id, w] of winEls) if (!live.some(s => s.id === id)) { w.remove(); winEls.delete(id); }
  live.forEach(sc => {
    const st = winState(sc.id);
    let w = winEls.get(sc.id);
    if (!w) { w = buildWindow(sc); root.appendChild(w); winEls.set(sc.id, w); }
    w.classList.toggle('min', !!st.min);
    w.classList.toggle('full', !!st.full);
    if (!st.full) Object.assign(w.style, { left: st.x + 'px', top: st.y + 'px', width: st.w + 'px', height: st.h + 'px' });
    w.querySelector('.scene-name').textContent = sc.title || 'Untitled';
    const cap = w.querySelector('.scene-caption');
    cap.textContent = sc.caption || ''; cap.hidden = !sc.caption;
    w.querySelector('[data-win="full"]').textContent = st.full ? '⤡' : '⤢';
    const body = w.querySelector('.scene-body');
    if (sc.kind === 'turns') {
      if (!body.querySelector('.turns-host')) body.innerHTML = '<div class="turns-host"></div>';
    } else if (sc.kind === 'vault') {
      if (!body.querySelector('.vault-wrap') || !st.min) body.innerHTML = vaultHTML();
    } else {
      const c = canvasFor(sc);
      if (c.el.parentNode !== body) { body.innerHTML = ''; body.appendChild(c.el); }
      if (c.imgKey !== sc.updated_at) {
        c.imgKey = sc.updated_at;
        sceneImage(sc).then(src => {
          if (!src) return;
          c.img.onload = () => { c.aspect = c.img.naturalWidth / c.img.naturalHeight || c.aspect; layout(c); };
          c.img.src = src;
        }).catch(() => { body.insertAdjacentHTML('afterbegin', '<p class="dim small">Couldn’t load the picture.</p>'); });
      }
      layout(c);
    }
  });
  renderTurnsViews();
  const bar = $('#pill-bar');
  bar.innerHTML = live.filter(sc => S.wins[sc.id] && S.wins[sc.id].min).map(sc =>
    `<button class="scene-pill" data-act="win-restore" data-id="${sc.id}"><span class="live-dot"></span><b>${esc(sc.title || 'Untitled')}</b></button>`).join('');
  saveWins();
}

function buildWindow(sc) {
  const w = document.createElement('div');
  w.className = 'scene-win';
  w.dataset.id = sc.id;
  w.setAttribute('role', 'dialog');
  w.innerHTML = `
    <header class="scene-bar">
      <span class="live-dot"></span>
      <b class="scene-name"></b>
      ${isGM() ? '<span class="tag green">Live</span>' : ''}
      <span class="spacer"></span>
      <button class="icon-btn" data-win="full" aria-label="Full screen" title="Full screen">⤢</button>
      <button class="icon-btn" data-win="min" aria-label="Minimise" title="Minimise">–</button>
    </header>
    <div class="scene-body"></div>
    <footer class="scene-caption" hidden></footer>`;
  const st = () => S.wins[sc.id];
  w.style.zIndex = ++S.z;
  w.addEventListener('pointerdown', () => { w.style.zIndex = ++S.z; }, true);
  w.querySelector('[data-win="min"]').onclick = () => { st().min = true; st().full = false; renderScenes(); };
  w.querySelector('[data-win="full"]').onclick = () => { st().full = !st().full; renderScenes(); };

  const bar = w.querySelector('.scene-bar');
  bar.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || st().full || window.matchMedia('(max-width: 640px)').matches) return;
    const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    bar.onpointermove = ev => {
      st().x = Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx));
      st().y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
      w.style.left = st().x + 'px'; w.style.top = st().y + 'px';
    };
    bar.onpointerup = () => { bar.onpointermove = null; saveWins(); };
  });
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      if (st().full || st().min) return;
      const r = w.getBoundingClientRect();
      if (r.width > 100 && r.height > 100) { st().w = Math.round(r.width); st().h = Math.round(r.height); clearTimeout(w._t); w._t = setTimeout(saveWins, 300); }
    }).observe(w);
  }
  return w;
}

// ── Rendering: dice log ────────────────────────────────────────────────────

function rollerAvatar(r) {
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  return rec ? avatarHTML(rec, 'md') : '<span class="avatar md gm-av">GM</span>';
}

function breakdownHTML(r) {
  const rows = [];
  const purpose = { grit_session: 'Session Grit', hp: 'HP', death: 'Dropping', damage: 'Damage' }[r.kind] || 'Dice';
  const sum = r.dice.reduce((a, b) => a + b, 0);
  rows.push(`<div class="bd-row"><span>${purpose} · ${r.dice.length}d${r.sides} rolled ${r.dice.join(', ')}</span><b>${sum}</b></div>`);
  for (const p of r.parts || []) rows.push(`<div class="bd-row ${+p.value ? '' : 'zero'}"><span>${esc(p.label)}</span><b>${signed(+p.value)}</b></div>`);
  if (!(r.parts || []).length && r.modifier) rows.push(`<div class="bd-row"><span>Modifier</span><b>${signed(r.modifier)}</b></div>`);
  for (const e of r.extras || []) rows.push(`<div class="bd-row grit"><span>Grit from ${esc(e.who)} · 1d6 rolled ${e.die}</span><b>+${e.die}</b></div>`);
  if (r.mult > 1) rows.push(`<div class="bd-row"><span>× ${r.mult}</span><b></b></div>`);
  for (const h of r.history || []) rows.push(`<div class="bd-row wear"><span>${REROLL_SVG} Rerolled with 1 Wear by ${esc(h.who)} · was ${(h.dice || []).join(', ')}${h.grit != null ? ` (Grit ${h.grit})` : ''}</span><b></b></div>`);
  rows.push(`<div class="bd-row bd-total"><span>Total</span><b>${r.total.toLocaleString()}</b></div>`);
  return `<div class="breakdown">${rows.join('')}</div>`;
}

function entryHTML(r) {
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  const accent = rec ? accentOf(rec) : 'var(--line)';
  const dbl = isDoubles(r) && r.kind !== 'grit_session';
  const animDice = S.anim.has(r.id + ':dice'), animGrit = S.anim.has(r.id + ':grit');
  // A 1 is red, the top face (6 on a d6) is green.
  const face = (v, sides) => (v === 1 ? 'one' : v === sides ? 'max' : '');
  const dice = r.dice.map((v, i) => `<span class="die ${face(v, r.sides)} ${dbl ? 'dbl' : ''} ${animDice ? 'tumble' : ''}" style="--i:${i}">${v}</span>`).join('');
  const grit = (r.extras || []).map(e => `<span class="die grit ${face(e.die, 6)} ${animGrit ? 'tumble' : ''}" title="Grit from ${esc(e.who)}">${e.die}</span>`).join('');
  const mods = (r.parts || []).map(p => `<span class="mod-inline" title="${esc(p.label)}">${signed(+p.value)}</span>`).join('');

  const tags = [];
  if (r.private) tags.push(`<span class="tag private">${EYE_OFF_SVG} Private${isGM() && r.who !== 'GM' ? ' · only you and ' + esc(r.who) : isGM() ? ' · only you' : ' · you and the GM'}</span>`);
  if (dbl) {
    const wm = rec ? wearMax(rec.data) : 3;
    tags.push(r.wear_marked === 1 ? '<span class="tag red">Doubles · +1 Wear banked</span>'
      : r.wear_marked === -1 ? `<span class="tag red">Doubles · already at max Wear (${wm}/${wm})</span>`
      : '<span class="tag red">Doubles</span>');
  }
  if (r.kind === 'death') tags.push(r.total >= 10 ? '<span class="tag green">Stable</span>' : r.total >= 7 ? '<span class="tag green">Success</span>' : '<span class="tag red">Fail</span>');
  if (r.kind === 'grit_session') tags.push('<span class="tag brass">Grit pool set</span>');

  const ed = rec && canEdit(rec);
  const canGrit = r.sides === 6 && r.kind !== 'grit_session' && !(r.extras || []).length && S.grit > 0;
  const canReroll = ed && r.kind !== 'grit_session' && rec.data.wear >= 1;
  const actions = (canGrit || canReroll) ? `
    <div class="entry-actions">
      ${canGrit ? `<button class="btn" data-act="spend-grit" data-id="${r.id}" title="Spend 1 Grit to add 1d6">+ Grit 1d6</button>` : ''}
      ${canReroll ? `<button class="btn" data-act="reroll" data-id="${r.id}" title="Spend 1 Wear to reroll">${REROLL_SVG} Reroll · 1 Wear (${rec.data.wear} left)</button>` : ''}
    </div>` : '';

  const fresh = S.ready && !S.seenRolls.has(r.id) ? 'fresh' : '';
  S.seenRolls.add(r.id);
  return `
    <article class="entry ${fresh} ${r.private ? 'is-private' : ''}" style="--accent:${esc(accent)}">
      <div class="entry-top">
        ${rollerAvatar(r)}
        <div class="entry-who"><b>${esc(r.who || 'GM')}</b><span class="entry-label">${esc(r.label || 'Roll')}</span></div>
        <span class="total">${r.total.toLocaleString()}</span>
      </div>
      <div class="entry-body">${dice}${grit}${mods}<span class="spacer"></span><span class="entry-time" title="${esc(new Date(Date.parse(trimTs(r.created_at))).toLocaleString())}">${relTime(r.created_at)}</span></div>
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
  const label = keep('mr-label');
  const focusId = document.activeElement && document.activeElement.id;
  const mr = S.mr;
  log.className = 'log' + (S.logOpen ? ' open' : '');
  log.innerHTML = `
    <div class="log-head">
      <h2><span class="grow">Dice</span><span class="tag brass" title="Shared Grit pool">Grit ${S.grit}/10</span>
        <button class="icon-btn log-close" data-act="log-toggle" aria-label="Close dice">×</button></h2>
      <div class="vis-toggle" role="radiogroup" aria-label="Who sees your rolls">
        <button class="${S.private ? '' : 'on'}" data-act="vis" data-v="0" role="radio" aria-checked="${!S.private}">Public</button>
        <button class="${S.private ? 'on' : ''}" data-act="vis" data-v="1" role="radio" aria-checked="${S.private}">${EYE_OFF_SVG} ${isGM() ? 'Private (only you)' : 'Private (GM only)'}</button>
      </div>
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
        <form class="roller-row" id="mr-form">
          <input id="mr-label" placeholder="Label, or a formula: 2d6+wits+perception" aria-label="Roll label or formula" autocomplete="off">
          <button class="btn brass" type="submit">${die(15)} Roll</button>
        </form>
        <div class="small dim" id="mr-hint">${mrHint('')}</div>
      </div>
      <div class="small dim">Rolling as <b style="color:var(--paper)">${esc(myName())}</b>${S.private ? ' · <span class="warn">private</span>' : ''}</div>
    </div>
    <div class="log-list" id="log-list">
      ${rolls.length ? rolls.map(entryHTML).join('') : '<p class="log-empty">No rolls yet. Click a stat on your sheet or roll here.</p>'}
    </div>`;
  S.anim.clear();
  $('#log-list').scrollTop = scroll;
  $('#mr-label').value = label;
  $('#mr-hint').innerHTML = mrHint(label);
  if (focusId === 'mr-label') $('#mr-label').focus();
  $('#mr-form').onsubmit = e => { e.preventDefault(); rollerSubmit($('#mr-label').value); };
  const fab = $('#fab-last');
  if (fab) fab.textContent = rolls[0] ? rolls[0].total : '';
}

// The roller input is either a formula ("2d6+wits+perception") or a label
// for the dice picked with the steppers above it.
const looksLikeFormula = t => /^\s*\d*\s*d\s*\d+/i.test(t);
function mrDice() { return `${S.mr.n}d${S.mr.sides}${S.mr.mod ? signed(S.mr.mod).replace('−', '-') : ''}`; }
function mrHint(text) {
  if (looksLikeFormula(text)) {
    const rec = S.sheets.get(mine());
    const f = parseFormula(text, rec && rec.data);
    return f ? `Rolls <b>${esc(text.trim())}</b>${f.parts.length ? ' · ' + f.parts.map(p => `${esc(p.label)} ${signed(p.value)}`).join(', ') : ''}`
             : `<span class="warn">Can’t read that formula yet</span>`;
  }
  return `Rolls <b>${mrDice()}</b>${text.trim() ? ` as “${esc(text.trim())}”` : ''}`;
}

function rollerSubmit(text) {
  const rec = S.sheets.get(mine());
  const t = String(text || '').trim();
  if (looksLikeFormula(t)) {
    const f = parseFormula(t, rec && rec.data);
    if (!f) {
      toast(rec || !/[a-z]{3}/i.test(t.replace(/d\d+/gi, ''))
        ? 'Try something like 2d6+1, 1d20 or 2d6+wits+perception.'
        : 'Stats and skills in a formula only work when you’re logged in as a character.', true);
      return;
    }
    roll({ sheetId: rec ? rec.id : null, label: t, kind: 'free', ...f });
  } else {
    roll({ sheetId: rec ? rec.id : null, label: t || mrDice(), kind: 'free', n: S.mr.n, sides: S.mr.sides,
           parts: S.mr.mod ? [{ label: 'Modifier', value: S.mr.mod }] : [] });
  }
  $('#mr-label').value = '';
  $('#mr-hint').innerHTML = mrHint('');
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
// Falls back to an <img> decode for formats createImageBitmap can't read.
async function shrinkImage(file, max, quality, square) {
  let src;
  try { src = await createImageBitmap(file); }
  catch {
    src = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const iw = src.width || src.naturalWidth, ih = src.height || src.naturalHeight;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (square) { const s = Math.min(sw, sh); sx = (sw - s) / 2; sy = (sh - s) / 2; sw = sh = s; }
  const scale = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function setPortrait(id, file) {
  try {
    const url = await shrinkImage(file, 320, 0.82, true);
    await commit(id, 'portrait', url);
    renderMain(); renderNav(); renderLog();
    toast('Picture updated.');
  } catch (err) { if (err && err.code) fail(err); else toast('Couldn’t read that image. Try a JPG or PNG.', true); }
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
function saveField(rec, path, v, delay) {
  setLocal(rec.id, path, v);
  const sp = savePath(rec, path);
  queuePatch(rec.id, sp, sp === path ? v : rec.data[sp], delay);
}

const noteTimers = {};
function debouncedSave(key, fn, statusId) {
  const s = $('#' + statusId); if (s) s.textContent = 'Saving…';
  clearTimeout(noteTimers[key]);
  noteTimers[key] = setTimeout(async () => {
    try { await fn(); const el = $('#' + statusId); if (el) el.textContent = 'Saved'; ping(); }
    catch (err) { fail(err); }
  }, 700);
}

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'gm-notes-session' || el.id === 'gm-notes-body') {
    const which = el.id === 'gm-notes-session' ? 'session' : 'body';
    S.gmNotes = { ...(S.gmNotes || {}), [which]: el.value };
    return debouncedSave('gm-' + which, () => api('gm_set_notes', { p_which: which, p_body: el.value }), 'gm-saving-' + which);
  }
  if (el.id === 'rules-note') {
    S.rulesNote = el.value;
    return debouncedSave('rules', () => api('gm_set_rules_note', { p_body: el.value }), 'rules-saving');
  }
  if (el.id === 'chat-input') { S.chatDraft = el.value; return; }
  if (el.id === 'mr-label') { $('#mr-hint').innerHTML = mrHint(el.value); return; }
  if (el.dataset.gmColor !== undefined) {
    S.gmColor = el.value; lsSet('debt.gmcolor', el.value);
    document.querySelectorAll('.gm-swatch').forEach(sw => { sw.style.background = el.value; });
    return;
  }
  if (el.dataset.sessionBody) {
    const id = el.dataset.sessionBody, g = (S.gmSessions || []).find(x => String(x.id) === id);
    if (g) g.body = el.value;
    return debouncedSave('ss-' + id, () => api('gm_session_save', { p_id: +id, p_date: null, p_body: el.value }), 'ss-' + id);
  }
  if (el.dataset.sceneField) return sceneFieldChanged(el);
  if (!el.dataset.bind || el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') return;
  const rec = currentSheet(el);
  if (!rec || !canEdit(rec)) return;
  saveField(rec, el.dataset.bind, readValue(el));
  if (el.dataset.bind === 'name') renderNav();
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.sheetFile) {
    const file = el.files[0]; el.value = '';
    if (file) setPortrait(el.dataset.sheetFile, file);
    return;
  }
  if (el.dataset.turnInit) {
    const v = el.value === '' ? null : Number(el.value);
    saveTurns(st => { const x = st.entries.find(y => y.id === el.dataset.turnInit); if (x) x.init = v; });
    return;
  }
  if (el.id === 'chat-to') { S.chatTo = el.value; $('#chat-input').placeholder = chatPlaceholder(); return; }
  if (el.dataset.sessionDate) {
    const id = el.dataset.sessionDate, g = (S.gmSessions || []).find(x => String(x.id) === id);
    try { const saved = await api('gm_session_save', { p_id: +id, p_date: el.value || null, p_body: null }); if (g) g.date = saved.date; renderMain(); }
    catch (err) { fail(err); }
    return;
  }
  if (el.dataset.setting) {
    el.setAttribute('aria-checked', el.checked);
    try { S.settings = await api('gm_set_settings', { p_settings: { [el.dataset.setting]: el.checked } }); ping(); toast('Setting saved.'); }
    catch (err) { fail(err); }
    return;
  }
  if (!el.dataset.bind) return;
  const rec = currentSheet(el);
  if (!rec || !canEdit(rec)) return;
  saveField(rec, el.dataset.bind, readValue(el), 0);
  if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') {
    renderMain();
    if (el.type === 'color') { renderNav(); renderLog(); }
  }
});

document.addEventListener('submit', async e => {
  const form = e.target;
  if (form.id === 'chat-form') {
    e.preventDefault();
    const body = S.chatDraft.trim();
    if (!body) return;
    try {
      const priv = isGM() ? !!S.chatTo : S.chatPrivate;
      const m = await api('chat_send', { p_body: body, p_private: priv, p_to: isGM() ? (S.chatTo || null) : null });
      S.chatDraft = ''; $('#chat-input').value = '';
      if (!S.chat.some(x => x.id === m.id)) S.chat.push(m);
      renderChat(true); ping();
    } catch (err) { fail(err); }
    return;
  }
  const kind = form.dataset.actForm;
  if (!kind) return;
  e.preventDefault();
  if (kind === 'turn-add-sheet') {
    const id = form.elements.sheet.value, rec = S.sheets.get(id);
    if (rec) saveTurns(st => { st.entries.push({ id: uid(), sheet_id: id, name: rec.data.name, init: null }); });
    return;
  }
  if (kind === 'turn-add-name') {
    const name = form.elements.name.value.trim();
    if (name) saveTurns(st => { st.entries.push({ id: uid(), sheet_id: null, name, init: null }); });
    return;
  }
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
    case 'toggle-spec': S.spec = !S.spec; $('#modbar').outerHTML = modbarHTML(rec); break;
    case 'bonus': S.bonus = Math.max(-10, Math.min(10, S.bonus + dd)); $('#modbar').outerHTML = modbarHTML(rec); break;
    case 'vis': S.private = el.dataset.v === '1'; lsSet('debt.private', S.private ? '1' : null); renderLog(); { const b = $('#modbar'), r = S.sheets.get(S.route.id); if (b && r) b.outerHTML = modbarHTML(r); } break;

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
    case 'portrait-clear': commit(rec.id, 'portrait', ''); renderMain(); renderNav(); break;
    case 'panel-toggle': {
      const k = el.dataset.k;
      const hidden = d.hidden.includes(k) ? d.hidden.filter(x => x !== k) : [...d.hidden, k];
      commit(rec.id, 'hidden', hidden); renderMain(); break;
    }
    case 'wear-max': {
      try { await api('gm_set_wear_max', { p_id: rec.id, p_max: wearMax(d) + dd }); ping(); S.since = null; await sync(); renderMain(); }
      catch (err) { fail(err); }
      break;
    }

    // Sheet values
    case 'hp-step': commit(rec.id, 'hp', hpStep(d.hp, dd)); renderMain(); break;
    case 'temp-step': commit(rec.id, 'hp.temp', Math.max(0, (+d.hp.temp || 0) + dd)); renderMain(); break;
    case 'wear-set': commit(rec.id, 'wear', Math.min(wearMax(d), d.wear >= n ? n - 1 : n)); renderMain(); renderLog(); break;
    case 'death-set': {
      const k = el.dataset.k, death = { ...d.death };
      death[k] = death[k] >= n ? n - 1 : n;
      death.stable = death.s >= 3 || (death.stable && k !== 's');
      commit(rec.id, 'death', death); renderMain(); break;
    }
    case 'death-reset': commit(rec.id, 'death', { s: 0, f: 0, stable: false }); renderMain(); break;
    case 'gear-add': commit(rec.id, 'gear', [...d.gear, blankGear(el.dataset.kind)]); renderMain(); break;
    case 'gear-del': commit(rec.id, 'gear', d.gear.filter((_, j) => j !== i)); renderMain(); break;

    // Rolls from the sheet
    case 'roll-stat': {
      const st = stat(el.dataset.k);
      roll({ sheetId: rec.id, label: st.n, kind: 'stat', parts: [statPart(d, st.k), ...nextRollParts(d)] });
      resetNextRoll(); break;
    }
    case 'roll-skill': {
      const sk = el.dataset.sk, st = stat(statOf(sk));
      roll({ sheetId: rec.id, kind: 'skill', label: `${st.n} + ${sk}`,
             parts: [statPart(d, st.k), { label: `${sk} skill`, value: +d.skills[sk] || 0 }, ...nextRollParts(d)] });
      resetNextRoll(); break;
    }
    case 'roll-weapon': {
      const g = d.gear[i];
      const parts = [statPart(d, g.stat), { label: `${g.name || 'Weapon'} bonus`, value: +g.bonus || 0 }];
      roll({ sheetId: rec.id, kind: 'damage', label: `${g.name || 'Weapon'} damage${g.effect ? ' · ' + g.effect : ''}`,
             n: Math.max(1, Math.min(20, +g.dice || 1)), sides: Math.max(2, Math.min(10, +g.die || 6)), parts });
      break;
    }
    case 'turn-step': saveTurns(st => {
      if (!st.entries.length) return;
      st.current += dd;
      if (st.current >= st.entries.length) { st.current = 0; st.round += 1; }
      if (st.current < 0) { st.current = st.entries.length - 1; st.round = Math.max(1, st.round - 1); }
    }); break;
    case 'turn-sort': saveTurns(st => {
      const n = v => (v === '' || v == null || isNaN(+v) ? -Infinity : +v);
      st.entries.sort((a, b) => n(b.init) - n(a.init)); st.current = 0;
    }); break;
    case 'turn-reset': saveTurns(st => { st.current = 0; st.round = 1; }); break;
    case 'turn-clear': if (confirm('Clear the whole turn order?')) saveTurns(st => { st.entries = []; st.current = 0; st.round = 1; }); break;
    case 'turn-move': saveTurns(st => {
      const k = st.entries.findIndex(x => x.id === el.dataset.id), j = k + dd;
      if (k < 0 || j < 0 || j >= st.entries.length) return;
      const curId = st.entries[st.current] && st.entries[st.current].id;
      [st.entries[k], st.entries[j]] = [st.entries[j], st.entries[k]];
      st.current = Math.max(0, st.entries.findIndex(x => x.id === curId));   // the highlight follows whoever's turn it is
    }); break;
    case 'turn-del': saveTurns(st => {
      const k = st.entries.findIndex(x => x.id === el.dataset.id);
      if (k < 0) return;
      st.entries.splice(k, 1);
      if (k < st.current) st.current -= 1;
    }); break;
    case 'kit-add': commit(rec.id, 'kit', [...d.kit, blankKit(el.dataset.kind)]); renderMain(); break;
    case 'kit-del': commit(rec.id, 'kit', d.kit.filter((_, j) => j !== i)); renderMain(); break;
    case 'rules-tab': S.rulesTab = el.dataset.t; renderMain(); break;
    case 'combat-show': {
      try { S.settings = await api('gm_set_settings', { p_settings: { combat_visible: el.dataset.v === '1' } }); ping(); renderMain(); }
      catch (err) { fail(err); }
      break;
    }
    case 'chat-priv': S.chatPrivate = !S.chatPrivate; el.classList.toggle('on', S.chatPrivate); el.setAttribute('aria-pressed', S.chatPrivate); $('#chat-input').placeholder = chatPlaceholder(); break;
    case 'chat-reply': S.chatTo = el.dataset.id; { const sel = $('#chat-to'); if (sel) sel.value = S.chatTo; } $('#chat-input').placeholder = chatPlaceholder(); $('#chat-input').focus(); break;
    case 'session-add': {
      try {
        const g = await api('gm_session_save', { p_id: null, p_date: new Date().toLocaleDateString('en-CA'), p_body: '' });
        S.gmSessions = [...(S.gmSessions || []), g];
        renderMain();
        const ta = $(`[data-session-body="${g.id}"]`); if (ta) ta.focus();
      } catch (err) { fail(err); }
      break;
    }
    case 'session-del': {
      const list = sortedSessions(), n = list.findIndex(x => String(x.id) === el.dataset.id) + 1;
      if (!confirm(`Delete Session #${n}’s notes?`)) break;
      try { await api('gm_session_delete', { p_id: +el.dataset.id }); S.gmSessions = S.gmSessions.filter(x => String(x.id) !== el.dataset.id); renderMain(); }
      catch (err) { fail(err); }
      break;
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
      const c = clone(d.custom), f = c[si].fields[fi];
      f.value = (+f.value || 0) + dd;
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-track': {
      const c = clone(d.custom), f = c[si].fields[fi], cur = +f.value || 0;
      f.value = cur >= n ? n - 1 : n;
      commit(rec.id, 'custom', c); renderMain(); break;
    }
    case 'cf-roll': {
      const f = d.custom[si].fields[fi];
      const parsed = parseFormula(f.formula, d);
      if (!parsed) { toast(`“${f.formula || ''}” isn’t a roll. Try 2d6+wits or 2d6+dex+stealth.`, true); break; }
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
    case 'spend-grit': {
      el.disabled = true;
      try {
        const r = await api('spend_grit', { p_roll: +el.dataset.id });
        applyRoll(r); S.anim.add(r.id + ':grit'); S.grit = Math.max(0, S.grit - 1);
        ping(); renderLog(); refreshMain(new Set(), true); sync();
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }
    case 'reroll': {
      el.disabled = true;
      try {
        const before = S.rolls.get(+el.dataset.id);
        const r = await api('reroll', { p_roll: +el.dataset.id });
        applyRoll(r); S.anim.add(r.id + ':dice'); if (S.settings.reroll_grit && (r.extras || []).length) S.anim.add(r.id + ':grit');
        ping();
        if (before) await afterReroll(before, r);
        renderLog(); await sync();
        toast(`Rerolled with 1 Wear: ${r.total}${r.wear_marked === 1 && isDoubles(r) ? ' · doubles, +1 Wear banked' : ''}`);
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }

    // Scene windows
    case 'win-restore': { const st = S.wins[el.dataset.id]; if (st) st.min = false; renderScenes(); break; }

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
      S.vault.set(code, { ...(prev || {}), code, state, by: myName() });
      S.vaultMenu = null;
      renderVaultViews();
      try { const b = await api('vault_set', { p_code: code, p_state: state }); S.vault.set(code, b); renderVaultViews(); ping(); }
      catch (err) { if (prev) S.vault.set(code, prev); renderVaultViews(); fail(err); }
      break;
    }
    case 'vault-danger': {
      const code = el.dataset.code, on = el.dataset.v === '1';
      S.vault.set(code, { ...(S.vault.get(code) || { code, state: '' }), danger: on });
      S.vaultMenu = null; renderVaultViews();
      try { await api('gm_vault_danger', { p_code: code, p_danger: on }); ping(); } catch (err) { fail(err); }
      break;
    }
    case 'vault-reset': {
      if (!confirm('Clear the state of every box in the Vault? DANGER marks stay.')) break;
      try { await api('gm_vault_reset'); for (const b of S.vault.values()) b.state = ''; ping(); renderVaultViews(); }
      catch (err) { fail(err); }
      break;
    }

    // Scenes (GM)
    case 'scene-new': $('#file-scene').dataset.id = ''; $('#file-scene').click(); break;
    case 'scene-replace': $('#file-scene').dataset.id = el.dataset.id; $('#file-scene').click(); break;
    case 'scene-live': {
      try {
        await api('gm_scene_active', { p_id: el.dataset.id, p_active: el.dataset.v === '1' });
        ping(); await loadScenes(); await sync(); renderNav();
      } catch (err) { fail(err); }
      break;
    }
    case 'scene-clear': {
      if (!confirm('Clear every marking on this scene for everyone?')) break;
      try { await api('gm_clear_strokes', { p_scene: el.dataset.id }); const m = S.strokes.get(el.dataset.id); if (m) m.clear(); redrawScene(el.dataset.id); ping(); toast('Markings cleared.'); }
      catch (err) { fail(err); }
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
    case 'gm-purge': {
      if (!confirm(`Delete ${el.dataset.name} forever? This can’t be undone.`)) break;
      try {
        await api('gm_purge_sheet', { p_id: el.dataset.id });
        S.deleted = S.deleted.filter(x => x.id !== el.dataset.id);
        renderMain(); toast(`${el.dataset.name} deleted for good.`);
      } catch (err) { fail(err); }
      break;
    }
  }
});

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
  if (!['file-import', 'file-scene'].includes(input.id)) return;
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  if (input.id === 'file-import') {
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
  if (S.route.view === 'gm') { S.gmNotes = null; S.gmSessions = null; }
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
  setInterval(() => { if (S.ready && !document.hidden) { renderLogTimes(); if (S.route.view === 'crew') renderChat(); } }, 30000);
}
function renderLogTimes() {
  const rolls = [...S.rolls.values()].sort((a, b) => b.id - a.id);
  document.querySelectorAll('.entry-time').forEach((el, j) => { if (rolls[j]) el.textContent = relTime(rolls[j].created_at); });
}

// v1 kept a shared password in the browser; drop it.
lsSet('beacon.pass', null); lsSet('beacon.gm', null); lsSet('beacon.who', null); lsSet('debt.win', null);
if (S.token) boot(); else renderLogin();
