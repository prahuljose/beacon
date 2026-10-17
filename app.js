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
  tokenPick: lsGet('debt.tokpick') || '',  // 'gm' | 'sheet:<id>' | 'npc'
  npcName: '',
  stats: { rows: null, loading: false, range: 'all', sel: null, sort: 'rolls', at: 0 },
  sound: lsGet('debt.sound') !== '0',
  net: 'ok',             // connection banner: 'ok' | 'down' | 'back'
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
  if (isNetErr(err)) { netDown(); return toast('You’re offline. Try that again once you’re back.', true); }
  toast(ERRORS[err && err.message] || (err && err.message) || 'Something went wrong.', true);
}

// ── Connection banner ──────────────────────────────────────────────────────
// fetch() rejects with a TypeError when the network is gone; our own errors
// carry a code. Sheet edits made while offline wait in `pending` and save
// once a sync gets through again.

const isNetErr = err => err instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false && !(err && err.code));
let netFails = 0, netTimer = null;
function netDown() {
  if (S.net === 'down') return renderNet();
  S.net = 'down';
  renderNet();
}
function netUp() {
  netFails = 0;
  if (S.net !== 'down') return;
  S.net = 'back';
  renderNet();
  for (const [key, p] of pending) if (p.waiting) { p.waiting = false; flushPatch(key, p); }
  clearTimeout(netTimer);
  netTimer = setTimeout(() => { if (S.net === 'back') { S.net = 'ok'; renderNet(); } }, 2600);
}
function renderNet() {
  const el = $('#net');
  if (!el) return;
  const waiting = [...pending.values()].filter(p => p.waiting).length;
  const edits = waiting ? ` ${waiting} edit${waiting === 1 ? '' : 's'} will save when you’re back.` : ' Edits will save when you’re back.';
  if (S.net === 'down') {
    const off = navigator.onLine === false;
    el.className = 'net-banner down';
    el.innerHTML = `<span class="net-spin" aria-hidden="true"></span><b>${off ? 'You’re offline.' : 'Reconnecting…'}</b><span>${esc(edits.trim())}</span>`;
  } else if (S.net === 'back') {
    el.className = 'net-banner back';
    el.innerHTML = '<span class="net-ok" aria-hidden="true">✓</span><b>Back online.</b><span>Everything is up to date.</span>';
  } else { el.className = 'net-banner'; el.innerHTML = ''; }
}
window.addEventListener('offline', () => { if (S.ready) netDown(); });
window.addEventListener('online', () => { if (S.ready) sync(); });

// ── Realtime: sync pings, live strokes, location pings ─────────────────────

let channel = null, rtClient = null, rtDownSince = 0;
function connectRealtime() {
  try {
    if (channel || !window.supabase) return;
    const client = rtClient || (rtClient = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }));
    // Local testing uses its own channel, so test logins never show as "online" to the real crew.
    const name = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? 'debt-crew-dev' : 'debt-crew';
    channel = client.channel(name, { config: { broadcast: { self: false }, presence: { key: TAB_ID } } });
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
    channel.on('broadcast', { event: 'tokmove' }, ({ payload: p }) => {
      const st = p && (S.strokes.get(p.scene) || new Map()).get(p.id);
      if (!st || !Array.isArray(p.points) || p.points.length !== 2) return;
      st.points = p.points;
      redrawScene(p.scene);
    });
    const ch = channel;   // callbacks from a replaced channel are ignored
    channel.on('presence', { event: 'sync' }, () => { if (ch !== channel) return; S.presence = channel.presenceState(); S.rtLive = true; renderOnline(); renderLoginStatus(); });
    channel.subscribe(status => {
      if (ch !== channel) return;
      S.rtLive = status === 'SUBSCRIBED';
      if (S.rtLive) { if (S.me) trackPresence(); else trackViewer(); }
      renderOnline();
    });
  } catch { channel = null; /* polling still works */ }
}
// Watchdog: the chip follows the channel's real state, our own presence entry
// is put back if it's missing or stale (e.g. still the login-page viewer), and
// a channel that stays down for 12 s is replaced with a fresh one.
setInterval(() => {
  if (!channel) { if (S.token || $('.login')) connectRealtime(); return; }
  const live = channel.state === 'joined';
  if (live !== S.rtLive) { S.rtLive = live; renderOnline(); }
  if (live) {
    rtDownSince = 0;
    const meta = ((S.presence || {})[TAB_ID] || [])[0];
    if (S.me) {
      if (!meta || meta.role !== S.me.role || (meta.sheet_id || null) !== (S.me.sheet_id || null)) trackPresence();
    } else if (!meta && $('.login')) trackViewer();
  } else if (!document.hidden) {
    rtDownSince = rtDownSince || Date.now();
    if (Date.now() - rtDownSince > 12000) {
      const old = channel;
      channel = null; rtDownSince = 0;
      try { rtClient.removeChannel(old); } catch { /* already gone */ }
      connectRealtime();
    }
  }
}, 3000);

// ── Who's online (Realtime Presence) ───────────────────────────────────────
// Each open tab announces who it's logged in as and whether it's in the
// foreground. Closing the tab removes it; a dropped connection times out.

const TAB_ID = Math.random().toString(36).slice(2, 12);
function trackPresence() {
  if (!channel || !S.rtLive || !S.me) return;
  try { channel.track({ role: S.me.role, sheet_id: S.me.sheet_id || null, away: document.hidden }); } catch { /* not joined yet */ }
}
// The login page has to track something to be sent presence at all. A viewer
// has no role or character, so presenceMap() skips it and no one sees it.
function trackViewer() {
  if (!channel || !S.rtLive || S.me || !$('.login')) return;
  try { channel.track({ role: 'viewer' }); } catch { /* ignore */ }
}
function untrackPresence() { try { if (channel) channel.untrack(); } catch { /* ignore */ } }

// id ('gm' or a sheet id) -> 'online' | 'away'. Any foreground tab wins.
function presenceMap() {
  const m = new Map();
  for (const metas of Object.values(S.presence || {})) {
    for (const p of metas || []) {
      const id = p.role === 'gm' ? 'gm' : p.sheet_id;
      if (!id) continue;
      if (m.get(id) !== 'online') m.set(id, p.away ? 'away' : 'online');
    }
  }
  return m;
}
function statusOf(id, pm) {
  if (id !== 'gm') { const r = S.sheets.get(id); if (r && r.has_pass === false) return 'nologin'; }
  return pm.get(id) || 'offline';
}
const STATUS_LABEL = { online: 'Online', away: 'Away', offline: 'Offline', nologin: 'No login yet' };

function renderOnline() {
  const host = $('#online');
  if (!host) return;
  const pm = presenceMap(), sheets = orderedSheets();
  const here = sheets.filter(r => ['online', 'away'].includes(statusOf(r.id, pm)));
  const faces = here.slice(0, 4).map(r => avatarHTML(r, 'xs')).join('');
  const rows = [{ id: 'gm', name: 'Game Master', rec: null }, ...sheets.map(r => ({ id: r.id, name: r.data.name || 'Unnamed', rec: r }))].map(x => {
    const st = statusOf(x.id, pm);
    return `
      <div class="ol-row ${st}">
        ${x.rec ? avatarHTML(x.rec, 'xs') : '<span class="avatar xs gm-av">GM</span>'}
        <span class="ol-name">${esc(x.name)}${(x.id === 'gm' && isGM()) || x.id === mine() ? ' <small class="you">you</small>' : ''}</span>
        <span class="ol-status"><i class="ol-dot"></i>${STATUS_LABEL[st]}</span>
      </div>`;
  }).join('');
  host.innerHTML = `
    <button class="online-chip ${S.rtLive ? '' : 'unknown'}" data-act="online-toggle" aria-expanded="${!!S.onlineOpen}"
      title="${S.rtLive ? 'Who’s online right now' : 'Connecting to live status…'}">
      <span class="oc-faces">${faces || '<i class="ol-dot"></i>'}</span>
      <span class="oc-count">${S.rtLive ? `${here.length} / ${sheets.filter(r => r.has_pass !== false).length}` : '…'}</span><span class="oc-label">online</span>
    </button>
    ${S.onlineOpen ? `
    <div class="online-pop" role="dialog" aria-label="Who’s online">
      <div class="op-head"><b>Who’s here</b><span class="small dim">${S.rtLive ? 'Live' : 'Connecting…'}</span></div>
      ${rows}
      <p class="op-key small dim"><i class="ol-dot k-online"></i>Online <i class="ol-dot k-away"></i>Away (tab in background) <i class="ol-dot k-offline"></i>Offline</p>
    </div>` : ''}`;
}

function send(event, payload) {
  try { if (channel) channel.send({ type: 'broadcast', event, payload }); } catch { /* ignore */ }
}
const ping = () => send('ping', {});
setInterval(() => {
  const now = Date.now();
  for (const [k, d] of S.drafts) if (now - d.t > 8000) { S.drafts.delete(k); redrawScene(d.scene); }
}, 4000);

// ── Dice tray ──────────────────────────────────────────────────────────────
// A felt tray in the dice panel. New rolls, Grit dice and Wear rerolls tumble
// across it first; the log entry waits (TRAY.hold) and then "lands": d6s show
// pips that fade into numbers and the total counts up (TRAY.settle).

const TRAY = { q: [], busy: false, hold: new Map(), settle: new Map(), counted: new Set(), gritPulse: 0, closeT: null };
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const dotsHTML = v => Array.from({ length: 9 }, (_, i) => `<i${PIPS[v].includes(i) ? '' : ' class="off"'}></i>`).join('');
const DIE_SHAPES = {
  4: 'polygon(50% 4%, 97% 92%, 3% 92%)', 8: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
  10: 'polygon(50% 0, 96% 40%, 50% 100%, 4% 40%)', 12: 'polygon(50% 0, 98% 36%, 80% 96%, 20% 96%, 2% 36%)',
  20: 'polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)',
};
const SOUND_ON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
const SOUND_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="m17 9 5 5M22 9l-5 5"/></svg>';
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Only play when someone can see it: tab in front, dice panel on screen.
function trayVisible() {
  const log = $('#log');
  if (!log || !$('#tray') || document.hidden || reducedMotion()) return false;
  // On narrow screens the panel is a drawer that slides down out of view when closed.
  const t = $('#tray').getBoundingClientRect();
  return t.width > 0 && t.left < window.innerWidth - 20 && t.top < window.innerHeight - 40 && t.bottom > 0;
}
function trayEvent(type, before, r) {
  if (!S.ready || !trayVisible() || !r.dice || !r.dice.length) return false;
  if (type !== 'roll' && !before) return false;
  TRAY.hold.set(r.id, type === 'roll' ? null : { row: before, type });
  TRAY.q.push({ type, before, id: r.id });
  // A burst of rolls: show the older ones straight away.
  while (TRAY.q.length > 3) { const ev = TRAY.q.shift(); TRAY.hold.delete(ev.id); }
  // Start on the next tick: applyRoll stores the roll after this returns.
  if (!TRAY.busy) { TRAY.busy = true; setTimeout(playTray, 0); }
  return true;
}
async function playTray() {
  const ev = TRAY.q.shift();
  if (!ev) { TRAY.busy = false; clearTimeout(TRAY.closeT); TRAY.closeT = setTimeout(closeTray, 150); return; }
  TRAY.busy = true;
  clearTimeout(TRAY.closeT);
  const r = S.rolls.get(ev.id);
  if (r && TRAY.hold.has(ev.id)) {
    try { await animateTray(ev, r); } catch { /* the entry still lands */ }
  }
  trayLand(ev);
  setTimeout(playTray, 60);
}
function closeTray() {
  const w = $('#tray-wrap');
  if (w) w.classList.remove('open');
  setTimeout(() => { if (!TRAY.busy) document.querySelectorAll('#tray .tdie').forEach(d => d.remove()); }, 400);
}
function trayLand(ev) {
  const r = S.rolls.get(ev.id);
  TRAY.hold.delete(ev.id);
  if (!r) return renderLog();
  const before = ev.before;
  const gritChanged = !before || JSON.stringify((before.extras || []).map(e => e.die)) !== JSON.stringify((r.extras || []).map(e => e.die));
  TRAY.settle.set(r.id, { at: performance.now(), from: before ? before.total : 0, dice: ev.type !== 'grit', grit: ev.type === 'grit' || (ev.type === 'reroll' && gritChanged && (r.extras || []).length > 0) });
  TRAY.counted.delete(r.id);
  if (ev.type === 'grit') TRAY.gritPulse = performance.now();
  renderLog();
}
function settleOf(id) {
  const se = TRAY.settle.get(id);
  if (!se) return null;
  const age = Math.round(performance.now() - se.at);
  if (age > 2600) { TRAY.settle.delete(id); return null; }
  return { ...se, age };
}
// Totals count up (or down, after a bad reroll) once, when an entry lands.
function countUps() {
  for (const [id, se] of TRAY.settle) {
    if (TRAY.counted.has(id)) continue;
    TRAY.counted.add(id);
    const r = S.rolls.get(id), el = document.querySelector(`.entry[data-roll="${id}"] .total`);
    if (!r || !el || se.from === r.total) continue;
    const from = se.from, to = r.total, t0 = performance.now(), dur = Math.min(700, 120 + Math.abs(to - from) * 45);
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), v = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 2)));
      if (!el.isConnected) return;
      el.textContent = v.toLocaleString();
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = from.toLocaleString();
    setTimeout(() => requestAnimationFrame(step), 150);
  }
}

function trayDie(v, sides, grit) {
  const e = document.createElement('span');
  e.className = 'tdie ' + (v === 1 ? 'one ' : v === sides ? 'max ' : '') + (grit ? 'grit ' : '') + (sides === 6 ? 'cube' : 'poly');
  if (sides === 6 && v >= 1 && v <= 6) e.innerHTML = `<span class="pp">${dotsHTML(v)}</span>`;
  else {
    e.textContent = v;
    if (DIE_SHAPES[sides]) { e.style.clipPath = DIE_SHAPES[sides]; e.classList.add('shaped', 'd' + sides); }
  }
  return e;
}
const rnd = sides => 1 + Math.floor(Math.random() * sides);

// Dice fly in, bounce, spin and settle on their values.
function tumbleIn(tray, items, opts = {}) {
  const W = tray.clientWidth, H = tray.clientHeight, n = items.length;
  const size = n > 5 ? 34 : 44, gap = Math.min(size + 12, (W - 24) / Math.max(1, n));
  const startX = opts.from ?? -60, x0 = (opts.center ?? W / 2) - ((n - 1) * gap) / 2 - size / 2;
  let longest = 0;
  items.forEach((it, i) => {
    const e = trayDie(rnd(it.sides), it.sides, it.grit);
    e.style.setProperty('--sz', size + 'px');
    tray.appendChild(e);
    const ex = x0 + i * gap, ey = H / 2 - size / 2 + (Math.random() * 10 - 5), sy = Math.random() * H * 0.5;
    const kf = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, a = 1 - Math.pow(1 - t, 3);
      kf.push({ transform: `translate(${startX + (ex - startX) * a}px, ${sy + (ey - sy) * a - Math.abs(Math.sin(t * Math.PI * 2.5)) * 30 * (1 - t)}px) rotate(${(1 - a) * 640 + i * 25}deg)` });
    }
    const flick = setInterval(() => { const f = trayDie(rnd(it.sides), it.sides, it.grit); e.className = f.className; e.innerHTML = f.innerHTML; e.style.clipPath = f.style.clipPath; }, 85);
    const dur = 820 + i * 100;
    longest = Math.max(longest, dur);
    e.animate(kf, { duration: dur, easing: 'linear', fill: 'forwards' }).onfinish = () => {
      clearInterval(flick);
      const f = trayDie(it.v, it.sides, it.grit);
      f.style.setProperty('--sz', size + 'px');
      f.style.transform = `translate(${ex}px, ${ey}px)`;
      if (opts.gold) f.classList.add('gold');
      e.replaceWith(f);
    };
  });
  return longest;
}
function placeStill(tray, items, cls, centerX) {
  const H = tray.clientHeight, n = items.length, size = n > 5 ? 34 : 44, gap = size + 10;
  const x0 = centerX - ((n - 1) * gap) / 2 - size / 2;
  return items.map((it, i) => {
    const e = trayDie(it.v, it.sides, it.grit);
    e.style.setProperty('--sz', size + 'px');
    e.style.transform = `translate(${x0 + i * gap}px, ${H / 2 - size / 2}px)`;
    if (cls) e.classList.add(cls);
    tray.appendChild(e);
    return { e, x: x0 + i * gap, y: H / 2 - size / 2 };
  });
}

function animateTray(ev, r) {
  return new Promise(resolve => {
    const wrap = $('#tray-wrap'), tray = $('#tray'), lbl = $('#tray-lbl');
    if (!wrap || !tray) return resolve();
    tray.querySelectorAll('.tdie').forEach(d => d.remove());
    wrap.classList.add('open');
    const W = tray.clientWidth, cap = 8;
    const asItems = (dice, sides, grit) => dice.slice(0, cap).map(v => ({ v, sides, grit }));
    const who = r.who || 'GM', dbl = isDoubles(r) && r.kind !== 'grit_session';
    let wait = 0;
    if (ev.type === 'roll') {
      lbl.textContent = `${who} · ${r.label || 'Roll'}${r.dice.length > cap ? ` · showing ${cap} of ${r.dice.length} dice` : ''}`;
      clack(Math.min(r.dice.length, 4));
      wait = tumbleIn(tray, asItems(r.dice, r.sides), { gold: dbl }) + 450;
    } else if (ev.type === 'grit') {
      const g = (r.extras || [])[r.extras.length - 1];
      lbl.textContent = `${g ? g.who : 'Someone'} adds a Grit die to ${who}’s roll`;
      placeStill(tray, asItems(ev.before.dice, ev.before.sides), 'dim', W * 0.36);
      clack(1);
      wait = tumbleIn(tray, [{ v: g ? g.die : 1, sides: 6, grit: true }], { from: W + 20, center: W * 0.78 }) + 450;
    } else {
      const h = (r.history || [])[r.history.length - 1];
      lbl.textContent = `${h ? h.who : who} spends 1 Wear to reroll`;
      const old = placeStill(tray, asItems(ev.before.dice, ev.before.sides), '', W / 2);
      old.forEach((o, i) => o.e.animate(
        [{ transform: `translate(${o.x}px, ${o.y}px)`, opacity: 1 }, { transform: `translate(${o.x + W}px, ${o.y - 18}px) rotate(110deg)`, opacity: 0 }],
        { duration: 420, delay: 160 + i * 50, easing: 'ease-in', fill: 'forwards' }));
      const items = asItems(r.dice, r.sides);
      const gNew = (r.extras || [])[0], gOld = (ev.before.extras || [])[0];
      if (gNew && gOld && S.settings.reroll_grit && gNew.die !== gOld.die) items.push({ v: gNew.die, sides: 6, grit: true });
      setTimeout(() => { clack(Math.min(items.length, 4)); tumbleIn(tray, items, { gold: dbl }); }, 520);
      wait = 520 + 820 + items.length * 100 + 450;
    }
    setTimeout(resolve, wait);
  });
}

// A short rattle made on the fly (no sound files).
let audioCtx = null;
function clack(n) {
  if (!S.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (audioCtx.state !== 'running') return;
    const hits = 2 + n * 2;
    for (let k = 0; k < hits; k++) {
      const t = audioCtx.currentTime + k * 0.075 + Math.random() * 0.03;
      const len = Math.floor(audioCtx.sampleRate * 0.03), b = audioCtx.createBuffer(1, len, audioCtx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      const src = audioCtx.createBufferSource(), f = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
      f.type = 'bandpass'; f.frequency.value = 1700 + Math.random() * 1600;
      g.gain.value = 0.3 * (1 - k / hits);
      src.buffer = b; src.connect(f).connect(g).connect(audioCtx.destination); src.start(t);
    }
  } catch { /* no audio */ }
}
// Browsers only allow sound after a click; wake the audio on the first one.
document.addEventListener('pointerdown', () => {
  if (!S.sound || audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
}, { once: true, capture: true });

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
    // The dice tray plays new rolls, Grit dice and Wear rerolls; the log entry
    // waits until the dice land. Without the tray, the log dice tumble instead.
    const type = !cur ? 'roll' : (r.history || []).length > (cur.history || []).length ? 'reroll'
      : (r.extras || []).length > (cur.extras || []).length ? 'grit' : null;
    if (!type || !trayEvent(type, cur, r)) {
      if (!cur) { S.anim.add(r.id + ':dice'); if ((r.extras || []).length) S.anim.add(r.id + ':grit'); }
      else {
        if (cur.dice.join() !== r.dice.join() || (cur.history || []).length !== (r.history || []).length) S.anim.add(r.id + ':dice');
        if (JSON.stringify(cur.extras) !== JSON.stringify(r.extras)) S.anim.add(r.id + ':grit');
      }
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
    netUp();
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

    if (!S.ready) { S.ready = true; renderApp(); trackPresence(); return; }
    if (changed.size) { renderNav(); renderOnline(); refreshTokPickers(); }
    if (changed.size || crewChanged || (vaultChanged && S.route.view === 'scenes') || (liveChanged && S.route.view === 'scenes')) refreshMain(changed, crewChanged);
    if (rulesChanged && S.route.view === 'rules') refreshMain(new Set(), true);
    if (crewChanged) renderClock();
    if (rollsChanged || crewChanged || changed.size) renderLog();
    if (chatChanged) renderChat();
    if (liveChanged || vaultChanged || changed.size) renderScenes();
    else if (vaultChanged) renderVaultViews();
    for (const id of dirtyScenes) redrawScene(id);
  } catch (err) {
    if (err.code === '28P01') signOut('You were signed out. Log in again.');
    else if (isNetErr(err) && (++netFails >= 2 || navigator.onLine === false)) netDown();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) sync(); trackPresence(); });

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
    // Offline: keep the edit and send it once the connection is back.
    if (isNetErr(err) && !keepalive && pending.get(key) === p) { p.waiting = true; netDown(); return; }
    fail(err);
    S.since = null; // pull the true state back
  } finally {
    if (pending.get(key) === p && !p.waiting) pending.delete(key);
    showSaving();
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
  if (!el) return;
  const all = [...pending.values()], busy = on || all.some(p => !p.waiting);
  el.textContent = busy ? 'Saving…' : all.length ? 'Not saved yet · offline' : 'Saved';
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
    const trayed = TRAY.hold.has(r.id) || TRAY.settle.has(r.id);
    if (!trayed) S.anim.add(r.id + ':dice');
    ping();
    renderLog();
    if (trayed) { /* the tray and the log entry show it */ }
    else if (r.wear_marked === 1) toast(`Doubles! ${r.who} banks 1 Wear.`);
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

const KEY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="m16 7 3 3"/><path d="m14 9 2 2"/></svg>';
const LOCK_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

// ── Login page extras: neon sign, live status, GM's desk, vault door ──────

// Each letter is its own tube so one can sputter while the rest stay lit.
function neonHTML() {
  return `<h1 class="neon" aria-label="Debt">${'DEBT'.split('').map((c, i) => `<span class="tube" style="--n:${i}" aria-hidden="true">${c}</span>`).join('')}</h1>`;
}
let neonTimer = null;
function startNeon() {
  clearTimeout(neonTimer);
  if (reducedMotion()) return;
  const tick = () => {
    const h = $('.login .neon');
    if (!h) return;                       // left the login page
    const tubes = h.querySelectorAll('.tube');
    if (Math.random() < 0.12) {           // now and then the whole sign drops out
      h.classList.add('blackout');
      setTimeout(() => h.classList.remove('blackout'), 500 + Math.random() * 500);
    } else {
      const t = tubes[Math.floor(Math.random() * tubes.length)];
      t.classList.remove('flick'); void t.offsetWidth; t.classList.add('flick');
      if (Math.random() < 0.3) setTimeout(() => { t.classList.remove('flick'); void t.offsetWidth; t.classList.add('flick'); }, 260);
    }
    neonTimer = setTimeout(tick, 2500 + Math.random() * 5500);
  };
  neonTimer = setTimeout(tick, 1600);
}

// Who's on right now, shown on the login tiles (same presence as the top bar).
function renderLoginStatus() {
  if (!$('.login')) return;
  const pm = presenceMap();
  document.querySelectorAll('.login [data-status-for]').forEach(el => {
    const id = el.dataset.statusFor, st = pm.get(id) || 'offline';
    if (id === 'gm') { el.hidden = st === 'offline'; el.classList.toggle('away', st === 'away'); el.textContent = st === 'away' ? '· GM is away' : '· GM is in'; return; }
    if (!el.querySelector('.ct-dot')) return;   // no password yet
    el.className = 'ct-status ' + st;
    el.querySelector('span').textContent = STATUS_LABEL[st] || 'Offline';
    const tile = el.closest('.crew-tile');
    if (tile) tile.classList.toggle('is-online', st === 'online');
  });
}

// The GM's desk: banker's lamp, open ledger, a cigar going in the ashtray.
const DESK_SVG = `<svg class="desk-props" viewBox="0 0 230 110" aria-hidden="true">
  <defs>
    <linearGradient id="dk-cone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe2a0" stop-opacity=".55"/><stop offset="1" stop-color="#ffe2a0" stop-opacity="0"/></linearGradient>
    <linearGradient id="dk-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f8a5a"/><stop offset="1" stop-color="#1d4a2f"/></linearGradient>
  </defs>
  <polygon class="lamp-cone" points="42,40 92,40 120,100 10,100" fill="url(#dk-cone)"/>
  <rect x="62" y="40" width="10" height="44" fill="#a9852f"/>
  <ellipse cx="67" cy="96" rx="26" ry="6" fill="#7d6122"/><ellipse cx="67" cy="93" rx="24" ry="5" fill="#c9a24b"/>
  <path d="M34 40 Q67 14 100 40 Z" fill="url(#dk-shade)" stroke="#10301e" stroke-width="1.5"/>
  <rect x="34" y="38.5" width="66" height="3" rx="1.5" fill="#c9a24b"/>
  <g class="ledger"><path d="M92 88 L132 80 L172 88 L172 100 L132 93 L92 100 Z" fill="#5b2a1e"/>
    <path d="M95 86 L132 79 L132 92 L95 98 Z" fill="#efe6cc"/><path d="M132 79 L169 86 L169 98 L132 92 Z" fill="#e2d8bb"/>
    <path d="M100 88 L127 83 M100 91 L127 86 M100 94 L122 90 M137 83 L164 88 M137 86 L164 91 M137 89 L158 93" stroke="#9b8a62" stroke-width=".8"/></g>
  <ellipse cx="200" cy="98" rx="20" ry="6" fill="#1a1d1f" stroke="#3a3f42"/>
  <rect x="180" y="91" width="30" height="5" rx="2.5" fill="#6b4226" transform="rotate(-8 195 93)"/>
  <circle class="ember" cx="209" cy="90.5" r="2.6" fill="#ff7a2e"/>
  <g class="smoke" fill="none" stroke="#cfc8b8" stroke-linecap="round">
    <path d="M210 86 C204 76 216 70 209 58 C203 48 214 42 208 30"/>
    <path d="M211 86 C218 74 206 66 213 54 C219 44 209 36 214 24"/>
    <path d="M209 86 C214 78 205 70 210 62"/>
  </g>
  <g class="desk-dice"><rect x="150" y="66" width="12" height="12" rx="2.5" fill="#e6dfcb" transform="rotate(-14 156 72)"/><circle cx="153" cy="70" r="1.3" fill="#1b1f22"/><circle cx="158.5" cy="74.5" r="1.3" fill="#1b1f22"/></g>
</svg>`;

// Right password: the vault door spins its dial, pulls its bolts and swings open
// while the portal loads behind it. Click to skip.
function vaultDoor(name) {
  if (reducedMotion()) return;
  const v = document.createElement('div');
  v.className = 'vault';
  v.innerHTML = `
    <div class="vault-frame">
      <div class="vault-door">
        ${Array.from({ length: 8 }, (_, i) => `<i class="bolt" style="--a:${i * 45 + 22.5}deg"></i>`).join('')}
        <div class="vault-ring"></div>
        <div class="vault-dial"><div class="vault-wheel"><i></i><i></i><i></i></div><b></b></div>
      </div>
    </div>
    <p class="vault-hello">Welcome back, <b>${esc(name)}</b></p>`;
  document.body.appendChild(v);
  const done = () => { v.classList.add('gone'); setTimeout(() => v.remove(), 500); };
  v.addEventListener('click', done);
  requestAnimationFrame(() => v.classList.add('go'));
  setTimeout(() => v.classList.add('open'), 1500);
  setTimeout(done, 2500);
}

async function renderLogin(msg) {
  clearInterval(pollTimer);
  app.innerHTML = `<div class="login"><div class="login-inner"><header class="login-brand"><div class="logo-die"><i></i><i></i><i></i></div>${neonHTML()}<p>Loading the crew…</p></header></div></div>`;
  let options = [];
  try { options = await rpc('login_options'); }
  catch { app.querySelector('.login-brand p').textContent = 'Couldn’t reach the server. Refresh to try again.'; return; }

  const tiles = options.map((o, i) => {
    const accent = o.accent || PALETTE[i % PALETTE.length];
    return `
      <button type="button" class="crew-tile ${o.ready ? '' : 'locked'}" data-pick="${o.id}" style="--accent:${esc(accent)};--d:${i * 50}ms" aria-pressed="false">
        <span class="ct-photo" style="${o.portrait ? `background-image:url('${esc(o.portrait)}')` : ''}">${o.portrait ? '' : `<b>${esc((o.name || '?').charAt(0).toUpperCase())}</b>`}</span>
        <span class="ct-plate">
          <b class="ct-name">${esc(o.name || 'Unnamed')}</b>
          <small class="ct-status" data-status-for="${o.id}">${o.ready ? '<i class="ct-dot"></i><span>Offline</span>' : `${LOCK_SM} No password yet`}</small>
        </span>
      </button>`;
  }).join('');

  app.innerHTML = `
    <div class="login">
      <div class="login-inner">
        <header class="login-brand">
          <div class="logo-die"><i></i><i></i><i></i></div>
          ${neonHTML()}
          <p>Crew portal</p>
        </header>

        <button type="button" class="gm-card gm-desk" data-pick="gm" aria-pressed="false">
          <span class="gm-seal">${KEY_SVG}</span>
          <span class="gm-copy">
            <small>Running the table? <i class="gm-here" data-status-for="gm" hidden>· GM is in</i></small>
            <b>Game Master</b>
            <span>Scenes, rolls, the Vault and every sheet.</span>
          </span>
          ${DESK_SVG}
          <span class="gm-go">Sign in <i>→</i></span>
        </button>

        <div class="login-divider"><span>or play as</span></div>

        <div class="crew-grid">${tiles || '<p class="dim small">No characters yet. The GM adds them.</p>'}</div>

        <form class="unlock" id="login-pass" autocomplete="on" hidden>
          <span class="unlock-who" id="unlock-who"></span>
          <div class="unlock-field">
            <label for="pass" id="pass-label">Password</label>
            <div class="unlock-row">
              <input id="pass" type="password" autocomplete="current-password" placeholder="••••••">
              <span class="mini-dial" id="mini-dial" aria-hidden="true"><i></i></span>
              <button class="btn brass" type="submit" id="login-btn">Enter</button>
            </div>
          </div>
          <button type="button" class="icon-btn unlock-x" id="unlock-x" aria-label="Pick someone else">×</button>
        </form>
        <p class="err login-err" id="login-err" role="alert">${esc(msg || '')}</p>
      </div>
    </div>`;

  startNeon();
  connectRealtime();      // the login page joins as an anonymous viewer
  trackViewer();
  renderLoginStatus();

  let picked = null;
  const unlock = $('#login-pass');
  const close = () => {
    picked = null; unlock.hidden = true; unlock.classList.remove('gm');
    app.querySelectorAll('[data-pick]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  };
  app.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    const id = b.dataset.pick, o = options.find(x => x.id === id), err = $('#login-err');
    app.querySelectorAll('[data-pick]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (o && !o.ready) {
      close();
      b.setAttribute('aria-pressed', 'true');
      err.textContent = `${o.name} has no password yet. Ask the GM to set one.`;
      return;
    }
    picked = id;
    err.textContent = '';
    const gm = id === 'gm';
    const accent = gm ? 'var(--brass)' : b.style.getPropertyValue('--accent');
    unlock.style.setProperty('--accent', accent);
    unlock.classList.toggle('gm', gm);
    $('#unlock-who').innerHTML = gm
      ? `<span class="uw-photo gm">${KEY_SVG}</span><span><small>Signing in as</small><b>Game Master</b></span>`
      : `<span class="uw-photo" style="${b.querySelector('.ct-photo').getAttribute('style')}">${b.querySelector('.ct-photo').innerHTML}</span><span><small>Signing in as</small><b>${esc(o.name)}</b></span>`;
    $('#pass-label').textContent = gm ? 'GM password' : `${o.name}’s password`;
    // Open the password box right under what was picked (the GM card, or the crew grid).
    (gm ? $('.gm-card') : $('.crew-grid')).after(unlock, $('#login-err'));
    unlock.hidden = false;
    $('#pass').value = '';
    unlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('#pass').focus({ preventScroll: true });
  });
  $('#unlock-x').onclick = close;

  unlock.onsubmit = async e => {
    e.preventDefault();
    if (!picked) return;
    const btn = $('#login-btn'), dial = $('#mini-dial');
    btn.disabled = true; btn.textContent = 'Checking…';
    dial.classList.remove('wrong'); dial.classList.add('spin');
    try {
      const s = await rpc('login', { p_sheet: picked === 'gm' ? null : picked, p_pass: $('#pass').value });
      S.token = s.token; S.me = { role: s.role, sheet_id: s.sheet_id };
      lsSet('debt.token', s.token);
      const o = options.find(x => x.id === picked);
      vaultDoor(picked === 'gm' ? 'Game Master' : (o && o.name) || 'crew');
      boot();
    } catch (err) {
      $('#login-err').textContent = err.message === 'bad_login' ? 'That’s not the password.' : 'Couldn’t reach the server. Try again.';
      dial.classList.remove('spin'); void dial.offsetWidth; dial.classList.add('wrong');
      unlock.classList.remove('shake'); void unlock.offsetWidth; unlock.classList.add('shake');
      btn.disabled = false; btn.textContent = 'Enter';
      $('#pass').select();
    }
  };
}

async function signOut(msg) {
  const tok = S.token;
  untrackPresence();
  S.token = ''; lsSet('debt.token', null);
  S.me = null; S.ready = false; S.since = null; S.onlineOpen = false;
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
      <div class="clock-wrap" id="clock"></div>
      <nav class="nav" id="nav"></nav>
      <div class="online-wrap" id="online"></div>
      <div class="me" id="me"></div>
    </header>
    <div class="layout">
      <main class="main" id="main"></main>
      <aside class="log" id="log" aria-label="Dice"></aside>
    </div>
    <div id="net" class="net-banner" role="status" aria-live="polite"></div>
    <div id="scene-root"><div class="pill-bar" id="pill-bar"></div></div>
    <button class="log-fab" id="log-fab" data-act="log-toggle" aria-label="Open dice">${die(22)}<span id="fab-last"></span></button>
    <input type="file" id="file-portrait" accept="image/*" hidden>
    <input type="file" id="file-import" accept="application/json,.json" hidden>
    <input type="file" id="file-scene" accept="image/*" hidden>`;
  renderNav();
  renderClock();
  renderOnline();
  renderMain();
  renderLog();
  renderScenes();
  renderNet();
}

function orderedSheets() {
  return [...S.sheets.values()].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}
function accentOf(rec) {
  if (rec.data.accent) return rec.data.accent;
  const i = orderedSheets().findIndex(r => r.id === rec.id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

// ── In-game day & time (GM sets it, everyone sees it) ─────────────────────

const CLOCK_PRESETS = [['Dawn', 360], ['Morning', 540], ['Noon', 720], ['Dusk', 1080], ['Night', 1290], ['Midnight', 0]];
function getClock() {
  const c = S.clockPending || (isObj(S.settings.clock) ? S.settings.clock : {});   // a change still saving wins
  const m = c.minutes == null || isNaN(+c.minutes) ? 480 : +c.minutes;   // 0 is midnight, not "unset"
  return { day: Math.max(1, +c.day || 1), minutes: (m % 1440 + 1440) % 1440 };
}
const fmtClock = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
// Crossing midnight moves the day on (or back).
function shiftClock(c, delta) {
  let m = c.minutes + delta;
  while (m >= 1440) { m -= 1440; c.day += 1; }
  while (m < 0) { if (c.day > 1) { m += 1440; c.day -= 1; } else { m = 0; } }
  c.minutes = m;
}
function clockPhase(m) {
  if (m >= 300 && m < 420) return ['dawn', 'Dawn'];
  if (m >= 420 && m < 1050) return ['day', 'Day'];
  if (m >= 1050 && m < 1200) return ['dusk', 'Dusk'];
  return ['night', 'Night'];
}
const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
const MOON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1z"/></svg>';
const HORIZON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 17a7 7 0 0 1 14 0"/><path d="M2 20h20M12 4v3M4.2 9.2l2 2M19.8 9.2l-2 2"/></svg>';

function renderClock() {
  const host = $('#clock');
  if (!host) return;
  const gm = isGM(), c = getClock(), [phase, phaseName] = clockPhase(c.minutes);
  const icon = phase === 'day' ? SUN_SVG : phase === 'night' ? MOON_SVG : HORIZON_SVG;
  const key = c.day + '|' + c.minutes;
  const bump = S.clockKey != null && S.clockKey !== key;
  S.clockKey = key;
  const face = `
    <span class="clock-icon">${icon}</span>
    <span class="clock-day">Day ${c.day}</span>
    <span class="clock-sep"></span>
    <span class="clock-time">${fmtClock(c.minutes)}</span>`;
  host.innerHTML = gm
    ? `<button class="clock ${phase} ${bump ? 'bump' : ''}" data-act="clock-toggle" aria-expanded="${!!S.clockOpen}" title="In-game day and time (click to change)">${face}<span class="clock-caret">▾</span></button>
       ${S.clockOpen ? `
       <div class="clock-pop" role="dialog" aria-label="Set the in-game day and time">
         <div class="cp-row"><span class="cp-lbl">Day</span>
           <span class="stepper"><button data-act="clock-day" data-d="-1" aria-label="Previous day" ${c.day <= 1 ? 'disabled' : ''}>−</button><b>Day ${c.day}</b><button data-act="clock-day" data-d="1" aria-label="Next day">+</button></span></div>
         <div class="cp-row"><span class="cp-lbl">Time</span>
           <span class="cp-time">
             <button class="btn sm" data-act="clock-time" data-d="-60">−1h</button>
             <button class="btn sm" data-act="clock-time" data-d="-15">−15m</button>
             <input type="time" id="clock-input" value="${fmtClock(c.minutes)}" step="300" aria-label="Time of day">
             <button class="btn sm" data-act="clock-time" data-d="15">+15m</button>
             <button class="btn sm" data-act="clock-time" data-d="60">+1h</button>
           </span></div>
         <div class="cp-presets">${CLOCK_PRESETS.map(([n, m]) => `<button class="btn sm ${c.minutes === m ? 'on' : ''}" data-act="clock-preset" data-v="${m}">${n} <small>${fmtClock(m)}</small></button>`).join('')}</div>
         <p class="small dim cp-note">Everyone sees this at the top. Going past midnight moves to the next day.</p>
       </div>` : ''}`
    : `<div class="clock ${phase} ${bump ? 'bump' : ''}" title="In-game day and time · ${phaseName}">${face}</div>`;
}

let clockTimer = null;
function setClock(mutate) {
  const c = getClock();
  mutate(c);
  S.clockPending = c;
  renderClock();
  clearTimeout(clockTimer);
  clockTimer = setTimeout(async () => {
    const want = S.clockPending;
    try { S.settings = await api('gm_set_settings', { p_settings: { clock: want } }); ping(); }
    catch (err) { fail(err); }
    if (S.clockPending === want) S.clockPending = null;
    renderClock();
  }, 250);
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
  else if (r.view === 'gm' && isGM()) { main.innerHTML = gmHTML(); if (S.gmNotes === null) loadGM(); if (!S.stats.rows && !S.stats.loading) loadStats(); }
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
        <section class="panel s12 stats-panel" id="dice-stats">${diceStatsHTML()}</section>
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

// ── GM dice stats ──────────────────────────────────────────────────────────
// Every roll ever made (the log plus rolls the GM cleared), per player. Only
// the GM can load this. Worked out in the browser from compact rows.

async function loadStats() {
  S.stats.loading = true;
  try {
    const rows = await api('gm_roll_history');
    S.stats.rows = rows.map(a => ({ id: a[0], sheet: a[1], who: a[2], kind: a[3], sides: a[4], dice: a[5] || [], total: a[6],
      at: Date.parse(trimTs(a[7])), priv: a[8], label: a[9] || '', history: a[10] || [], extras: a[11] || [], wear: a[12] }));
    S.stats.at = Date.now();
  } catch (err) { fail(err); }
  S.stats.loading = false;
  const el = $('#dice-stats');
  if (el) el.innerHTML = diceStatsHTML();
}

const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);
const fmtDay = k => new Date(k + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function statsRange() {
  const r = S.stats.range;
  if (r === 'all') return () => true;
  if (r === '7d' || r === '30d') { const from = Date.now() - (r === '7d' ? 7 : 30) * 864e5; return x => x.at >= from; }
  if (r.startsWith('day:')) { const k = r.slice(4); return x => dayKey(x.at) === k; }
  return () => true;
}
function statsWhoKey(x) {
  if (x.sheet) return x.sheet;
  return x.who === 'GM' ? 'gm' : 'gone:' + x.who;
}
function statsPerson(key) {
  if (key === 'gm') return { name: 'GM', av: '<span class="avatar sm gm-av">GM</span>', color: S.gmColor };
  const rec = S.sheets.get(key);
  if (rec) return { name: rec.data.name || 'Unnamed', av: avatarHTML(rec, 'sm'), color: accentOf(rec) };
  const n = key.startsWith('gone:') ? key.slice(5) : 'Deleted';
  return { name: n + ' (deleted)', av: `<span class="avatar sm">${esc(n.charAt(0).toUpperCase())}</span>`, color: '#6c777b' };
}

// All the numbers for one set of rolls.
function crunch(list) {
  const o = { rolls: list.length, dice: 0, luckSum: 0, two: 0, dbl: 0, dblExp: 0, snake: 0, box: 0, ones: 0, tops: 0,
              rerolls: 0, grit: 0, wear: 0, priv: 0, hist: Array(13).fill(0), n2d6: 0, sum2d6: 0, faces: Array(7).fill(0), d6n: 0,
              labels: new Map(), days: new Map(), best: null, worst: null, form: [] };
  for (const x of list) {
    const all = [...x.dice, ...x.history.flatMap(h => h.dice || [])];
    for (const v of all) {
      o.dice++; o.luckSum += x.sides > 1 ? (v - 1) / (x.sides - 1) : .5;
      if (v === 1) o.ones++; if (v === x.sides) o.tops++;
      if (x.sides === 6 && v >= 1 && v <= 6) { o.faces[v]++; o.d6n++; }
    }
    if (x.dice.length === 2) {
      o.two++; o.dblExp += 1 / x.sides;
      if (x.dice[0] === x.dice[1]) { o.dbl++; if (x.dice[0] === 1) o.snake++; if (x.dice[0] === x.sides) o.box++; }
      if (x.sides === 6 && x.kind !== 'grit_session') { const t = x.dice[0] + x.dice[1]; o.hist[t]++; o.n2d6++; o.sum2d6 += t; }
    }
    o.rerolls += x.history.length; o.grit += x.extras.length; if (x.wear === 1) o.wear++; if (x.priv) o.priv++;
    if (x.kind !== 'grit_session') {
      const lb = (x.label || 'Roll').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Roll';
      const L = o.labels.get(lb) || { n: 0, sum: 0 }; L.n++; L.sum += x.total; o.labels.set(lb, L);
      if (!o.best || x.total > o.best.total) o.best = x;
      if (!o.worst || x.total < o.worst.total) o.worst = x;
    }
    const dk = dayKey(x.at), D = o.days.get(dk) || { n: 0, luck: 0, dice: 0 };
    D.n++; for (const v of x.dice) { D.luck += x.sides > 1 ? (v - 1) / (x.sides - 1) : .5; D.dice++; } o.days.set(dk, D);
    if (x.dice.length) o.form.push(x.dice.reduce((a, v) => a + (x.sides > 1 ? (v - 1) / (x.sides - 1) : .5), 0) / x.dice.length);
  }
  o.luck = o.dice ? Math.round(o.luckSum / o.dice * 100) : null;   // 50 = exactly average
  o.avg2d6 = o.n2d6 ? Math.round(o.sum2d6 / o.n2d6 * 10) / 10 : null;
  o.dblRate = pct(o.dbl, o.two); o.dblExpRate = o.two ? Math.round(o.dblExp / o.two * 1000) / 10 : 0;
  return o;
}

const STAT_COLS = [
  ['rolls', 'Rolls', o => o.rolls, o => o.rolls],
  ['luck', 'Luck', o => o.luck ?? -1, o => (o.luck == null ? '—' : o.luck), 'Average die face on a 0–100 scale. 50 is dead average.'],
  ['avg', 'Avg 2d6', o => o.avg2d6 ?? -1, o => (o.avg2d6 == null ? '—' : o.avg2d6.toFixed(1)), 'Expected: 7.0'],
  ['dbl', 'Doubles', o => o.dblRate, o => (o.two ? `${o.dbl} <small>${o.dblRate}%</small>` : '—'), 'Two-dice rolls that came up doubles. Expected about 16.7% on 2d6.'],
  ['ones', '1s', o => pct(o.ones, o.dice), o => (o.dice ? `${o.ones} <small>${pct(o.ones, o.dice)}%</small>` : '—'), 'Dice that showed a 1'],
  ['tops', 'Top faces', o => pct(o.tops, o.dice), o => (o.dice ? `${o.tops} <small>${pct(o.tops, o.dice)}%</small>` : '—'), 'Dice that showed their highest face'],
  ['rerolls', 'Wear rerolls', o => o.rerolls, o => o.rerolls],
  ['grit', 'Grit dice', o => o.grit, o => o.grit, 'Grit dice added to their rolls'],
  ['best', 'Best', o => (o.best ? o.best.total : -1e9), o => (o.best ? o.best.total : '—'), 'Highest total (with modifiers)'],
];

function luckClass(v) { return v == null ? '' : v >= 56 ? 'hot' : v <= 44 ? 'cold' : ''; }
function luckWord(v) { return v == null ? 'No dice yet' : v >= 60 ? 'On fire' : v >= 54 ? 'Lucky' : v > 46 ? 'Average' : v > 40 ? 'Unlucky' : 'Cursed'; }

function diceStatsHTML() {
  const st = S.stats;
  const head = `<h2><span class="grow">Dice stats</span>
      <span class="small dim" style="font-family:var(--type)">${st.rows ? 'Only you can see this' : ''}</span>
      <button class="btn sm" data-act="stats-refresh" ${st.loading ? 'disabled' : ''}>${REROLL_SVG} ${st.loading ? 'Loading…' : 'Refresh'}</button></h2>`;
  if (!st.rows) return head + `<p class="small dim">${st.loading ? 'Counting every roll…' : 'Could not load the stats. Try Refresh.'}</p>`;

  const inRange = statsRange();
  const rows = st.rows.filter(inRange);
  const days = [...new Set(st.rows.map(x => dayKey(x.at)))].sort().reverse();
  const ranges = [['all', 'All time'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  const sessions = sortedSessions();
  const dayLabel = k => { const i = sessions.findIndex(g => g.date === k); return (i >= 0 ? `Session #${i + 1} · ` : '') + fmtDay(k); };
  const rangeBar = `<div class="stats-ranges">${ranges.map(([k, l]) => `<button class="btn sm ${st.range === k ? 'on' : ''}" data-act="stats-range" data-v="${k}">${l}</button>`).join('')}
      <select data-stats-day aria-label="One game day"><option value="">One game day…</option>${days.map(k => `<option value="day:${k}" ${st.range === 'day:' + k ? 'selected' : ''}>${esc(dayLabel(k))}</option>`).join('')}</select></div>`;

  // Group per player.
  const groups = new Map();
  for (const x of rows) { const k = statsWhoKey(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const order = [...orderedSheets().map(r => r.id), 'gm'];
  const keys = [...new Set([...order.filter(k => groups.has(k)), ...groups.keys()])];
  const people = keys.map(k => ({ k, p: statsPerson(k), o: crunch(groups.get(k)) }));
  const crew = crunch(rows);
  const col = STAT_COLS.find(c => c[0] === st.sort) || STAT_COLS[0];
  people.sort((a, b) => col[2](b.o) - col[2](a.o));
  if (!st.sel || !groups.has(st.sel)) st.sel = people[0] ? people[0].k : null;

  if (!rows.length) return head + rangeBar + '<p class="small dim" style="margin-top:14px">No rolls in this range yet.</p>';

  // The leader in each column (players only, needs a few rolls to count).
  const lead = {};
  for (const c of STAT_COLS) {
    const pool = people.filter(x => x.o.rolls >= 3 && x.k !== 'gm');
    if (pool.length < 2) continue;
    const top = Math.max(...pool.map(x => c[2](x.o)));
    const leaders = pool.filter(x => c[2](x.o) === top);
    if (top > 0 && leaders.length === 1) lead[c[0]] = leaders[0].k;   // ties get no star
  }

  const crewCards = `<div class="stats-cards">
      ${statCard('Rolls', crew.rolls.toLocaleString(), `${crew.dice.toLocaleString()} dice thrown`)}
      ${statCard('Crew luck', crew.luck ?? '—', luckWord(crew.luck), luckClass(crew.luck))}
      ${statCard('Avg 2d6', crew.avg2d6 == null ? '—' : crew.avg2d6.toFixed(1), 'Expected 7.0')}
      ${statCard('Doubles', crew.dbl, crew.two ? `${crew.dblRate}% · expected ${crew.dblExpRate}%` : 'No two-dice rolls')}
      ${statCard('Wear rerolls', crew.rerolls, `${crew.wear} Wear banked from doubles`)}
      ${statCard('Grit dice', crew.grit, `${crew.priv} private rolls`)}
    </div>`;

  const table = `<div class="stats-table-wrap"><table class="stats-table">
      <thead><tr><th>Player</th>${STAT_COLS.map(c => `<th><button data-act="stats-sort" data-v="${c[0]}" class="${st.sort === c[0] ? 'on' : ''}" ${c[4] ? `title="${esc(c[4])}"` : ''}>${c[1]}${st.sort === c[0] ? ' ▾' : ''}</button></th>`).join('')}</tr></thead>
      <tbody>${people.map(({ k, p, o }) => `
        <tr class="${st.sel === k ? 'sel' : ''}" data-act="stats-sel" data-v="${esc(k)}" style="--accent:${esc(p.color)}" tabindex="0">
          <td><span class="stats-who">${p.av}<b>${esc(p.name)}</b></span></td>
          ${STAT_COLS.map(c => `<td class="${lead[c[0]] === k ? (c[0] === 'ones' ? 'lead bad' : 'lead') : ''} ${c[0] === 'luck' ? 'luck ' + luckClass(o.luck) : ''}">${c[3](o)}</td>`).join('')}
        </tr>`).join('')}</tbody></table></div>
      <p class="small dim stats-foot">★ marks the clear leader in each column (3+ rolls); a red ★ is the most 1s. Click a column to sort, or a player to see their detail. Rerolled dice count in luck and faces.</p>`;

  const sel = people.find(x => x.k === st.sel);
  return head + rangeBar + crewCards + table + (sel ? playerStatsHTML(sel) : '');
}

function statCard(label, value, sub, cls = '') {
  return `<div class="stat-card ${cls}"><span class="sc-label">${label}</span><b class="sc-value">${value}</b><span class="sc-sub">${sub}</span></div>`;
}

function playerStatsHTML({ p, o }) {
  const EXP2 = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map(n => n / 36 * 100);
  const histMax = Math.max(...EXP2, ...o.hist.map(n => pct(n, o.n2d6)), 1);
  const hist = o.n2d6 ? `<div class="bars hist">${o.hist.map((n, t) => t < 2 ? '' : `
      <div class="bar-col" title="${t}: ${n} of ${o.n2d6} rolls (${pct(n, o.n2d6)}%, expected ${EXP2[t].toFixed(1)}%)">
        <span class="bar-n">${n || ''}</span>
        <div class="bar-track"><i class="bar ${t === 2 ? 'one' : t === 12 ? 'max' : ''}" style="height:${pct(n, o.n2d6) / histMax * 100}%"></i><i class="exp" style="bottom:${EXP2[t] / histMax * 100}%"></i></div>
        <span class="bar-x">${t}</span></div>`).join('')}</div>` : '<p class="small dim">No 2d6 rolls in this range.</p>';

  const fMax = Math.max(...o.faces.slice(1).map(n => pct(n, o.d6n)), 100 / 6, 1);
  const faces = o.d6n ? `<div class="bars faces">${o.faces.map((n, f) => f === 0 ? '' : `
      <div class="bar-col" title="${f}: ${n} of ${o.d6n} d6 (${pct(n, o.d6n)}%, expected 16.7%)">
        <span class="bar-n">${pct(n, o.d6n)}%</span>
        <div class="bar-track"><i class="bar ${f === 1 ? 'one' : f === 6 ? 'max' : ''}" style="height:${pct(n, o.d6n) / fMax * 100}%"></i><i class="exp" style="bottom:${100 / 6 / fMax * 100}%"></i></div>
        <span class="bar-x pip-x">${f}</span></div>`).join('')}</div>` : '<p class="small dim">No d6 rolled in this range.</p>';

  const labels = [...o.labels.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const lMax = labels.length ? labels[0][1].n : 1;
  const labelsHTML = labels.length ? `<div class="top-labels">${labels.map(([l, v]) => `
      <div class="tl-row"><span class="tl-name" title="${esc(l)}">${esc(l)}</span><span class="tl-bar"><i style="width:${v.n / lMax * 100}%"></i></span><span class="tl-n">${v.n}×</span><span class="tl-avg" title="Average total">avg ${(v.sum / v.n).toFixed(1)}</span></div>`).join('')}</div>` : '<p class="small dim">Nothing yet.</p>';

  const days = [...o.days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  const dMax = Math.max(...days.map(d => d[1].n), 1);
  const daysHTML = days.length > 0 ? `<div class="bars days">${days.map(([k, d]) => { const lk = d.dice ? Math.round(d.luck / d.dice * 100) : null; return `
      <div class="bar-col" title="${esc(fmtDay(k))}: ${d.n} rolls · luck ${lk ?? '—'}">
        <span class="bar-n">${d.n}</span>
        <div class="bar-track"><i class="bar ${luckClass(lk)}" style="height:${d.n / dMax * 100}%"></i></div>
        <span class="bar-x">${esc(fmtDay(k))}</span></div>`; }).join('')}</div>` : '';

  const form = o.form.slice(-30);
  const formHTML = form.length ? `<div class="form-strip" aria-label="Last ${form.length} rolls, above or below average">${form.map(v => `<i class="${v > .5 ? 'up' : v < .5 ? 'down' : ''}" style="height:${Math.max(6, Math.abs(v - .5) * 2 * 100) / 2}%" title="${Math.round(v * 100)}"></i>`).join('')}</div>` : '';

  const rollLine = r => r ? `<b>${r.total}</b> <span class="dim">· ${esc(r.label || 'Roll')} · ${r.dice.join(', ')} · ${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>` : '—';

  return `<div class="player-stats" style="--accent:${esc(p.color)}">
      <div class="ps-head">${p.av.replace('avatar sm', 'avatar md')}<div><h3>${esc(p.name)}</h3><span class="luck-word ${luckClass(o.luck)}">${luckWord(o.luck)}${o.luck != null ? ` · luck ${o.luck}` : ''}</span></div></div>
      <div class="stats-cards">
        ${statCard('Rolls', o.rolls, `${o.dice} dice · ${o.priv} private`)}
        ${statCard('Avg 2d6', o.avg2d6 == null ? '—' : o.avg2d6.toFixed(1), o.n2d6 ? `${o.n2d6} rolls · expected 7.0` : 'No 2d6 yet')}
        ${statCard('Doubles', o.dbl, o.two ? `${o.dblRate}% · expected ${o.dblExpRate}%` : 'No two-dice rolls')}
        ${statCard('Snake eyes · Boxcars', `${o.snake} · ${o.box}`, 'Double 1s · double top faces')}
        ${statCard('Wear', o.rerolls, `rerolls used · ${o.wear} banked`)}
        ${statCard('Grit dice', o.grit, 'added to their rolls')}
      </div>
      <div class="ps-grid">
        <div class="ps-box"><h4>2d6 totals <small>bars = this player · line = expected</small></h4>${hist}</div>
        <div class="ps-box"><h4>d6 faces <small>line = fair die (16.7%)</small></h4>${faces}</div>
        <div class="ps-box"><h4>Most rolled</h4>${labelsHTML}</div>
        <div class="ps-box"><h4>Best and worst</h4>
          <div class="bw"><span class="tag green">Best</span>${rollLine(o.best)}</div>
          <div class="bw"><span class="tag red">Worst</span>${rollLine(o.worst)}</div>
          ${formHTML ? `<h4 style="margin-top:14px">Recent form <small>last ${form.length} rolls · up = above average</small></h4>${formHTML}` : ''}
        </div>
        ${daysHTML ? `<div class="ps-box wide"><h4>Rolls per game day <small>colour = luck that day</small></h4>${daysHTML}</div>` : ''}
      </div>
    </div>`;
}

document.addEventListener('change', e => {
  if (!e.target.matches || !e.target.matches('[data-stats-day]')) return;
  S.stats.range = e.target.value || 'all';
  rerenderStats();
});
document.addEventListener('keydown', e => {
  const tr = e.key === 'Enter' && e.target.closest && e.target.closest('tr[data-act="stats-sel"]');
  if (tr) { S.stats.sel = tr.dataset.v; rerenderStats(); const again = document.querySelector(`tr[data-v="${CSS.escape(tr.dataset.v)}"]`); if (again) again.focus(); }
});

function rerenderStats() {
  const el = $('#dice-stats');
  if (el) el.innerHTML = diceStatsHTML();
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
      <div class="vault-frame">
        <div class="v-title">VAULT</div>
        <div class="vault">
          <div class="v-block">${rows(VAULT_LEFT)}</div>
          <div class="v-block">${rows(VAULT_MID)}</div>
          <div class="v-block">${rows(VAULT_RIGHT)}</div>
        </div>
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
  renderPills();
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
  const names = { pen: '✎ Pen', erase: '⌫ Erase', text: 'T Text', token: '◉ Token', select: '✥ Move', ping: '◎ Ping' };
  return `
    <div class="draw-tools">
      ${Object.keys(names).map(t => `<button class="tool ${S.tool === t ? 'on' : ''}" data-tool="${t}">${names[t]}</button>`).join('')}
      <span class="widths pen-only" role="radiogroup" aria-label="Pen width">${PEN_WIDTHS.map(w => `<button class="wbtn ${S.penWidth === w ? 'on' : ''}" data-width="${w}" role="radio" aria-checked="${S.penWidth === w}" aria-label="Pen width ${w}" title="Pen width ${w}"><i style="width:${Math.min(15, w + 2)}px;height:${Math.min(15, w + 2)}px"></i></button>`).join('')}</span>
      <span class="tokpicks token-only" role="radiogroup" aria-label="Which token">${tokPickHTML()}</span>
      <span class="tsizes text-only" role="radiogroup" aria-label="Text size">${TEXT_SIZES.map(([w, l], i) => `<button class="tsbtn ${S.textSize === w ? 'on' : ''}" data-tsize="${w}" role="radio" aria-checked="${S.textSize === w}" title="Text size ${l}" style="font-size:${10 + i * 2.5}px">${l}</button>`).join('')}</span>
      ${gm ? `<label class="swatch gm-swatch" title="Your pen colour (GM only)" style="background:${esc(myColor())}"><input type="color" value="${esc(myColor())}" data-gm-color aria-label="Pen colour"></label>`
           : `<span class="swatch" style="background:${esc(myColor())}" title="Your colour"></span>`}
      <span class="spacer"></span>
      ${gm ? `<button class="btn sm ghost" data-clear="${sc.id}">Clear all</button>` : ''}
      ${sc.kind === 'board' ? '<button class="tool tool-max" data-max title="Full screen (Esc to close)" aria-label="Full screen">⤢ Full screen</button>' : ''}
    </div>`;
}

// The Drawing Board can take over the screen while you draw. Same aspect
// ratio, so everyone's drawings stay where they were put.
function toggleMax(c, on = !c.el.classList.contains('maximized')) {
  c.el.classList.toggle('maximized', on);
  document.body.classList.toggle('board-max', on);
  const b = c.el.querySelector('[data-max]');
  if (b) { b.innerHTML = on ? '⤡ Exit full screen' : '⤢ Full screen'; b.title = on ? 'Exit full screen (Esc)' : 'Full screen (Esc to close)'; }
  requestAnimationFrame(() => layout(c));
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.target.closest && e.target.closest('.text-entry')) return;
  for (const c of canvases.values()) if (c.el.classList.contains('maximized')) toggleMax(c, false);
});

// Text size on the scene, in CSS px for a box `boxW` wide.
const textPx = (w, boxW) => (12 + w * 2.2) * (boxW / 900);

// Text labels can span lines; the first line is centred on the click point.
const LINE_H = 1.25;
const measureCtx = document.createElement('canvas').getContext('2d');
const textFont = fs => `${fs}px "Special Elite", "Courier New", monospace`;
function textLines(t) { return String(t || '').split('\n'); }
// The box a label covers, in CSS px of a drawing box rw × rh wide.
function textBox(s, rw, rh) {
  const fs = textPx(s.width, rw), lh = fs * LINE_H, ls = textLines(s.text);
  measureCtx.font = textFont(fs);
  const w = Math.max(...ls.map(l => measureCtx.measureText(l).width));
  const x0 = s.points[0] * rw, y0 = s.points[1] * rh - lh / 2;
  return { x0, y0, w, h: ls.length * lh };
}

function openTextInput(c, x, y) {
  c.box.querySelectorAll('.text-entry, .text-hint').forEach(n => n.remove());
  const bw = c.box.clientWidth, bh = c.box.clientHeight;
  const fs = Math.max(11, textPx(S.textSize, bw)), lh = fs * LINE_H, PAD = 4;
  const left = x * bw, maxW = Math.max(90, bw - left - 4);
  const ta = document.createElement('textarea');
  ta.className = 'text-entry';
  ta.maxLength = 300;
  ta.rows = 1;
  ta.wrap = 'off';
  ta.spellcheck = false;
  ta.placeholder = 'Type here';
  const hint = document.createElement('div');
  hint.className = 'text-hint';
  hint.textContent = 'Enter to save · Shift+Enter for a new line · Esc to cancel';
  Object.assign(ta.style, {
    left: left + 'px', top: Math.max(0, y * bh - lh / 2 - PAD - 1) + 'px',
    color: myColor(), fontSize: fs + 'px', lineHeight: lh + 'px', padding: PAD + 'px ' + (PAD + 2) + 'px',
  });
  const fit = () => {
    const ls = textLines(ta.value || ta.placeholder);
    measureCtx.font = textFont(fs);
    const w = Math.max(...ls.map(l => measureCtx.measureText(l).width));
    ta.style.width = Math.max(80, Math.min(maxW, w + 2 * PAD + 10)) + 'px';
    ta.style.height = (textLines(ta.value || ' ').length * lh + 2 * PAD + 2) + 'px';
    // The hint sits under the box, or above it near the bottom edge.
    const top = parseFloat(ta.style.top), h = parseFloat(ta.style.height);
    hint.style.left = ta.style.left;
    hint.style.top = (top + h + 22 > bh ? Math.max(0, top - 22) : top + h + 4) + 'px';
  };
  fit();
  c.box.appendChild(ta);
  c.box.appendChild(hint);
  // No page jump: focus without scrolling.
  setTimeout(() => ta.focus({ preventScroll: true }), 0);
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\s+$/, '').replace(/^\n+/, '');
    ta.remove(); hint.remove();
    if (!save || !text.trim()) return;
    try {
      const st = await api('add_stroke', { p_scene: c.id, p_color: myColor(), p_width: S.textSize, p_points: [x, y], p_text: text });
      applyStroke(st); redraw(c); ping();
    } catch (err) { fail(err); }
  };
  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('pointerdown', ev => ev.stopPropagation());
}

function makeCanvas(sc) {
  const el = document.createElement('div');
  el.className = 'draw ' + sc.kind;
  el.dataset.tool = S.tool;
  el.innerHTML = `${toolsHTML(sc)}
    <div class="draw-stage"><div class="draw-box">${sc.kind === 'image' ? '<img class="draw-img" alt="" draggable="false">' : ''}<canvas></canvas><div class="tokens"></div><div class="pings"></div></div></div>`;
  const c = { id: sc.id, kind: sc.kind, el, stage: el.querySelector('.draw-stage'), box: el.querySelector('.draw-box'),
              canvas: el.querySelector('canvas'), img: el.querySelector('.draw-img'),
              aspect: sc.kind === 'board' ? 16 / 7 : 16 / 10, imgKey: null, cur: null, erase: null, tokEls: new Map() };

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
    const tp = e.target.closest('[data-tokpick]');
    if (tp) {
      S.tokenPick = tp.dataset.tokpick; lsSet('debt.tokpick', S.tokenPick);
      refreshTokPickers();
      if (S.tokenPick === 'npc') { const inp = c.el.querySelector('.npc-name'); if (inp) inp.focus({ preventScroll: true }); }
      return;
    }
    if (e.target.closest('[data-max]')) { toggleMax(c); return; }
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
    if (S.tool === 'token' && !hitToken(c, e)) { e.preventDefault(); placeToken(c, x, y); return; }
    if (S.tool === 'select' || S.tool === 'token') {
      const h = hitToken(c, e) || (S.tool === 'select' && hitText(c, e));
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
      if (Date.now() - lastSend > 60) { lastSend = Date.now(); send('tokmove', { scene: c.id, id: st.id, points: st.points }); }
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
      redraw(c);
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
  const fitHeight = c.kind === 'image' || c.el.classList.contains('maximized');
  if (fitHeight && H && h > H) { h = H; w = H * c.aspect; }
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
      const fs = Math.round((12 + s.width * 2.2) * scale);
      ctx.fillStyle = s.color;
      ctx.font = textFont(fs);
      ctx.textBaseline = 'middle';
      textLines(s.text).forEach((ln, i) => ctx.fillText(ln, s.points[0] * W, s.points[1] * H + i * fs * LINE_H));
      return;
    }
    ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(1.5, s.width * scale); strokePath(ctx, s.points, W, H); ctx.stroke();
  };
  for (const s of (S.strokes.get(c.id) || new Map()).values()) if (!s.piece) draw(s);
  for (const d of S.drafts.values()) if (d.scene === c.id && d.points.length >= 2) draw(d);
  if (c.cur) draw(c.cur);
  renderTokens(c);
}
function redrawScene(id) { const c = canvases.get(id); if (c) redraw(c); }

// Select tool: the topmost text label under the pointer.
function hitText(c, e) {
  const r = c.box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  let hit = null;
  for (const s of (S.strokes.get(c.id) || new Map()).values()) {
    if (!s.text) continue;
    const b = textBox(s, r.width, r.height);
    if (px > b.x0 - 8 && px < b.x0 + b.w + 8 && py > b.y0 - 8 && py < b.y0 + b.h + 8) hit = s;
  }
  return hit;
}

// Eraser: rub out whole strokes that pass under the pointer.
function eraseAt(c, e) {
  const r = c.box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, R = 12;
  const m = S.strokes.get(c.id);
  if (!m) return;
  let hit = false;
  const tr = tokenPx(r.width) / 2;
  for (const [id, s] of m) {
    const p = s.points;
    if (s.piece) {
      if (Math.hypot(px - p[0] * r.width, py - p[1] * r.height) < tr + R / 2) { c.erase.add(id); m.delete(id); hit = true; }
      continue;
    }
    if (s.text) {
      const b = textBox(s, r.width, r.height);
      if (px > b.x0 - R && px < b.x0 + b.w + R && py > b.y0 - R && py < b.y0 + b.h + R) { c.erase.add(id); m.delete(id); hit = true; }
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

// ── Tokens ────────────────────────────────────────────────────────────────
// A token is a stroke with a `piece` ('gm', 'sheet:<id>', 'npc:<label>') at
// [x, y]. They sit on a DOM layer above the drawing so portraits stay crisp;
// the layer ignores the pointer and hits are worked out here.

const tokenPx = boxW => Math.round(Math.max(26, Math.min(58, boxW * 0.05)));
function myPiece() {
  const p = S.tokenPick;
  if (p === 'gm' || p === 'npc') return p;
  if (p && p.startsWith('sheet:') && S.sheets.has(p.slice(6))) return p;
  return mine() ? 'sheet:' + mine() : 'gm';
}
function initials(name) {
  const w = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((w[0] || '?').charAt(0) + (w.length > 1 ? w[w.length - 1].charAt(0) : '')).toUpperCase();
}
function tokenInfo(st) {
  const piece = st.piece || '';
  if (piece === 'gm') return { name: 'GM', color: st.color || GM_COLOR, mark: 'GM', gm: true };
  if (piece.startsWith('npc:')) { const n = piece.slice(4); return { name: n, color: '#b8463a', mark: initials(n), npc: true }; }
  const rec = S.sheets.get(piece.slice(6));
  if (!rec) return { name: 'Gone', color: '#6c777b', mark: '?' };
  return { name: rec.data.name || 'Unnamed', color: accentOf(rec), mark: (rec.data.name || '?').trim().charAt(0).toUpperCase(), portrait: rec.data.portrait };
}
function tokPickHTML() {
  const cur = myPiece();
  const btn = (piece, face, label) => `<button class="tokpick ${cur === piece ? 'on' : ''}" data-tokpick="${esc(piece)}" role="radio" aria-checked="${cur === piece}" title="${esc(label)}" aria-label="${esc(label)}">${face}</button>`;
  return orderedSheets().map(r => btn('sheet:' + r.id, avatarHTML(r, 'xs'), 'Token: ' + (r.data.name || 'Unnamed'))).join('')
    + btn('gm', '<span class="avatar xs gm-av">GM</span>', 'Token: GM')
    + btn('npc', '<span class="avatar xs npc-av">NPC</span>', 'Token: an NPC (type a name)')
    + `<input class="npc-name ${cur === 'npc' ? '' : 'hide'}" maxlength="16" placeholder="NPC name, then click" value="${esc(S.npcName)}" aria-label="NPC name">`;
}
function refreshTokPickers() {
  document.querySelectorAll('.tokpicks').forEach(el => {
    if (el.contains(document.activeElement)) {   // don't steal the NPC name box while typing
      el.querySelectorAll('.tokpick').forEach(b => { const on = b.dataset.tokpick === myPiece(); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
      el.querySelector('.npc-name').classList.toggle('hide', myPiece() !== 'npc');
      return;
    }
    el.innerHTML = tokPickHTML();
  });
}
document.addEventListener('input', e => {
  if (!e.target.classList || !e.target.classList.contains('npc-name')) return;
  S.npcName = e.target.value;
  document.querySelectorAll('.npc-name').forEach(i => { if (i !== e.target) i.value = S.npcName; });
});
document.addEventListener('keydown', e => {
  if (e.target.classList && e.target.classList.contains('npc-name')) { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); }
}, true);

async function placeToken(c, x, y) {
  let piece = myPiece();
  if (piece === 'npc') {
    const n = S.npcName.trim();
    if (!n) { toast('Type the NPC’s name first, then click the board.', true); const i = c.el.querySelector('.npc-name'); if (i) i.focus({ preventScroll: true }); return; }
    piece = 'npc:' + n.slice(0, 16);
  }
  // Show it straight away: a character's token jumps to the new spot.
  const m = S.strokes.get(c.id) || new Map(); S.strokes.set(c.id, m);
  const prev = piece.startsWith('npc:') ? null : [...m.values()].find(s => s.piece === piece);
  const temp = prev || { id: 'tmp-' + uid(), scene_id: c.id, piece, color: myColor(), points: [x, y] };
  const was = prev && prev.points;
  temp.points = [x, y];
  if (!prev) m.set(temp.id, temp);
  redraw(c);
  try {
    const st = await api('place_token', { p_scene: c.id, p_piece: piece, p_points: [x, y], p_color: myColor() });
    if (!prev) m.delete(temp.id);
    applyStroke(st);
    redraw(c); ping();
  } catch (err) {
    if (prev) prev.points = was; else m.delete(temp.id);
    redraw(c); fail(err);
  }
}

function hitToken(c, e) {
  const r = c.box.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, R = tokenPx(r.width) / 2 + 3;
  let hit = null;
  for (const s of (S.strokes.get(c.id) || new Map()).values()) {
    if (s.piece && !String(s.id).startsWith('tmp-') && Math.hypot(px - s.points[0] * r.width, py - s.points[1] * r.height) < R) hit = s;
  }
  return hit;
}

function renderTokens(c) {
  const layer = c.box.querySelector('.tokens');
  if (!layer) return;
  const size = tokenPx(c.box.clientWidth || 900);
  layer.style.setProperty('--tok', size + 'px');
  const seen = new Set();
  for (const s of (S.strokes.get(c.id) || new Map()).values()) {
    if (!s.piece) continue;
    seen.add(s.id);
    const t = tokenInfo(s);
    const sig = [t.name, t.color, t.mark, t.portrait ? t.portrait.length + t.portrait.slice(-24) : ''].join('|');
    let el = c.tokEls.get(s.id);
    if (!el) { el = document.createElement('div'); el.className = 'token'; layer.appendChild(el); c.tokEls.set(s.id, el); }
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.classList.toggle('npc', !!t.npc); el.classList.toggle('gm', !!t.gm);
      el.style.setProperty('--c', t.color);
      el.innerHTML = `<span class="tok-face" style="${t.portrait ? `background-image:url('${esc(t.portrait)}')` : ''}">${t.portrait ? '' : esc(t.mark)}</span><span class="tok-name">${esc(t.name)}</span>`;
    }
    el.classList.toggle('dragging', !!(c.drag && c.drag.id === s.id));
    el.style.left = (s.points[0] * 100) + '%';
    el.style.top = (s.points[1] * 100) + '%';
  }
  for (const [id, el] of c.tokEls) if (!seen.has(id)) { el.remove(); c.tokEls.delete(id); }
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
  renderPills();
  saveWins();
}

// Minimised windows sit as pills bottom-left. The Turn Order pill still shows
// the round, whose turn it is, and who's next.
function renderPills() {
  const bar = $('#pill-bar');
  if (!bar) return;
  const live = S.live.filter(s => s.kind !== 'board' && S.wins[s.id] && S.wins[s.id].min);
  bar.innerHTML = live.map(sc => sc.kind === 'turns' ? turnsPillHTML(sc)
    : `<button class="scene-pill" data-act="win-restore" data-id="${sc.id}"><span class="live-dot"></span><b>${esc(sc.title || 'Untitled')}</b></button>`).join('');
}

function turnsPillHTML(sc) {
  const st = normTurns((turnsScene() || sc).state);
  const nameOf = e => { const r = e && e.sheet_id && S.sheets.get(e.sheet_id); return r ? r.data.name : (e ? e.name : ''); };
  const cur = st.entries[st.current], next = st.entries.length > 1 ? st.entries[(st.current + 1) % st.entries.length] : null;
  const rec = cur && cur.sheet_id && S.sheets.get(cur.sheet_id);
  const key = `${st.round}|${st.current}|${cur ? cur.id : ''}`;
  const changed = S.turnPillKey != null && S.turnPillKey !== key;
  S.turnPillKey = key;
  const av = rec ? avatarHTML(rec, 'xs') : `<span class="avatar xs">${esc((nameOf(cur) || '·').charAt(0).toUpperCase())}</span>`;
  return `
    <button class="scene-pill turn-pill ${changed ? 'bump' : ''}" data-act="win-restore" data-id="${sc.id}"
      style="--accent:${esc(rec ? accentOf(rec) : '#9aa3a6')}" title="Turn Order: open">
      <span class="tp-round">R${st.round}</span>
      ${cur ? `${av}<span class="tp-now"><b>${esc(nameOf(cur))}</b><small>${next ? 'next: ' + esc(nameOf(next)) : 'their turn'}</small></span>`
            : '<span class="tp-now"><b>Turn Order</b><small>not set up yet</small></span>'}
    </button>`;
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
  // While the tray plays a Grit die or a reroll, the entry keeps its old state.
  const held = TRAY.hold.get(r.id);
  if (held) r = held.row;
  const se = held ? null : settleOf(r.id);
  const rec = r.sheet_id && S.sheets.get(r.sheet_id);
  const accent = rec ? accentOf(rec) : 'var(--line)';
  const dbl = isDoubles(r) && r.kind !== 'grit_session';
  const animDice = !held && !se && S.anim.has(r.id + ':dice'), animGrit = !held && !se && S.anim.has(r.id + ':grit');
  const el = se ? `--el:-${se.age}ms;` : '';
  // A 1 is red, the top face (6 on a d6) is green. Freshly landed d6s show
  // their pips for a beat, then fade into the number.
  const face = (v, sides) => (v === 1 ? 'one' : v === sides ? 'max' : '');
  const inner = (v, sides, on) => (on && sides === 6 && v >= 1 && v <= 6 ? `<span class="pp">${dotsHTML(v)}</span><span class="num">${v}</span>` : v);
  const settleCls = (on, sides) => (on ? (sides === 6 ? 'settle' : 'settle-n') : '');
  const gone = held && held.type === 'reroll' ? 'gone' : '';
  const sd = se && se.dice, sg = se && se.grit;
  const dice = r.dice.map((v, i) => `<span class="die ${face(v, r.sides)} ${dbl ? 'dbl' : ''} ${animDice ? 'tumble' : ''} ${settleCls(sd, r.sides)} ${gone}" style="--i:${i};${el}">${inner(v, r.sides, sd)}</span>`).join('');
  const grit = (r.extras || []).map(e => `<span class="die grit ${face(e.die, 6)} ${animGrit ? 'tumble' : ''} ${settleCls(sg, 6)} ${gone && S.settings.reroll_grit ? 'gone' : ''}" style="--i:${r.dice.length};${el}" title="Grit from ${esc(e.who)}">${inner(e.die, 6, sg)}</span>`).join('');
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
  const canGrit = !held && r.sides === 6 && r.kind !== 'grit_session' && !(r.extras || []).length && S.grit > 0;
  const canReroll = !held && ed && r.kind !== 'grit_session' && rec.data.wear >= 1;
  const actions = (canGrit || canReroll) ? `
    <div class="entry-actions">
      ${canGrit ? `<button class="btn" data-act="spend-grit" data-id="${r.id}" title="Spend 1 Grit to add 1d6">+ Grit 1d6</button>` : ''}
      ${canReroll ? `<button class="btn" data-act="reroll" data-id="${r.id}" title="Spend 1 Wear to reroll">${REROLL_SVG} Reroll · 1 Wear (${rec.data.wear} left)</button>` : ''}
    </div>` : '';

  const fresh = S.ready && !S.seenRolls.has(r.id) ? 'fresh' : '';
  S.seenRolls.add(r.id);
  const landDbl = se && se.dice && dbl;
  return `
    <article class="entry ${fresh} ${r.private ? 'is-private' : ''} ${landDbl ? 'dbl-land' : ''}" data-roll="${r.id}" style="--accent:${esc(accent)};${el}">
      ${landDbl ? '<span class="dbl-stamp" aria-hidden="true">Doubles</span>' : ''}
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
  // The tray lives between the controls and the list and survives re-renders.
  if (!$('#log-head')) {
    log.innerHTML = `<div class="log-head" id="log-head"></div>
      <div class="tray-wrap" id="tray-wrap" aria-hidden="true"><div class="tray" id="tray"><span class="tray-lbl" id="tray-lbl"></span></div></div>
      <div class="log-list" id="log-list"></div>`;
  }
  const gp = TRAY.gritPulse && performance.now() - TRAY.gritPulse < 900 ? `pulse" style="--el:-${Math.round(performance.now() - TRAY.gritPulse)}ms` : '';
  $('#log-head').innerHTML = `
      <h2><span class="grow">Dice</span><span class="tag brass ${gp}" title="Shared Grit pool">Grit ${S.grit}/10</span>
        <button class="icon-btn sound-btn ${S.sound ? 'on' : ''}" data-act="sound" aria-pressed="${S.sound}" aria-label="Dice sound" title="${S.sound ? 'Dice sound on' : 'Dice sound off'}">${S.sound ? SOUND_ON_SVG : SOUND_OFF_SVG}</button>
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
      <div class="small dim">Rolling as <b style="color:var(--paper)">${esc(myName())}</b>${S.private ? ' · <span class="warn">private</span>' : ''}</div>`;
  const shown = rolls.filter(r => TRAY.hold.get(r.id) !== null);   // null = still in the tray
  $('#log-list').innerHTML = shown.length ? shown.map(entryHTML).join('') : '<p class="log-empty">No rolls yet. Click a stat on your sheet or roll here.</p>';
  S.anim.clear();
  $('#log-list').scrollTop = scroll;
  $('#mr-label').value = label;
  $('#mr-hint').innerHTML = mrHint(label);
  if (focusId === 'mr-label') $('#mr-label').focus();
  $('#mr-form').onsubmit = e => { e.preventDefault(); rollerSubmit($('#mr-label').value); };
  const fab = $('#fab-last');
  if (fab) fab.textContent = shown[0] ? shown[0].total : '';
  countUps();
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
  if (el.id === 'clock-input' && el.value) {
    const [h, m] = el.value.split(':').map(Number);
    setClock(c => { c.minutes = h * 60 + m; });
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
    if (S.clockOpen && !e.target.closest('.clock-wrap')) { S.clockOpen = false; renderClock(); }
    if (S.onlineOpen && !e.target.closest('.online-wrap')) { S.onlineOpen = false; renderOnline(); }
    return;
  }
  if (S.onlineOpen && !el.closest('.online-wrap')) { S.onlineOpen = false; renderOnline(); }
  if (S.clockOpen && !el.closest('.clock-wrap')) { S.clockOpen = false; renderClock(); }
  const act = el.dataset.act;
  const rec = currentSheet(el);
  const d = rec && rec.data;
  const n = +el.dataset.n, dd = +el.dataset.d, i = +el.dataset.i, si = +el.dataset.si, fi = +el.dataset.fi;
  if (el.tagName === 'A') e.preventDefault();

  switch (act) {
    // Shell
    case 'logout': signOut(); break;
    case 'online-toggle': S.onlineOpen = !S.onlineOpen; renderOnline(); break;
    case 'clock-toggle': S.clockOpen = !S.clockOpen; renderClock(); break;
    case 'clock-day': setClock(c => { c.day = Math.max(1, c.day + dd); }); break;
    case 'clock-time': setClock(c => { shiftClock(c, dd); }); break;
    case 'clock-preset': setClock(c => { c.minutes = +el.dataset.v; }); break;
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
        applyRoll(r);
        if (!TRAY.hold.has(r.id) && !TRAY.settle.has(r.id)) S.anim.add(r.id + ':grit');
        S.grit = Math.max(0, S.grit - 1);
        ping(); renderLog(); refreshMain(new Set(), true); sync();
      } catch (err) { fail(err); el.disabled = false; }
      break;
    }
    case 'reroll': {
      el.disabled = true;
      try {
        const before = S.rolls.get(+el.dataset.id);
        const r = await api('reroll', { p_roll: +el.dataset.id });
        applyRoll(r);
        const trayed = TRAY.hold.has(r.id) || TRAY.settle.has(r.id);
        if (!trayed) { S.anim.add(r.id + ':dice'); if (S.settings.reroll_grit && (r.extras || []).length) S.anim.add(r.id + ':grit'); }
        ping();
        if (before) await afterReroll(before, r);
        renderLog(); await sync();
        if (!trayed) toast(`Rerolled with 1 Wear: ${r.total}${r.wear_marked === 1 && isDoubles(r) ? ' · doubles, +1 Wear banked' : ''}`);
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

    case 'sound': {
      S.sound = !S.sound; lsSet('debt.sound', S.sound ? '1' : '0');
      renderLog();
      if (S.sound) clack(2);
      break;
    }

    // GM dice stats
    case 'stats-refresh': loadStats(); break;
    case 'stats-range': S.stats.range = el.dataset.v; rerenderStats(); break;
    case 'stats-sort': S.stats.sort = el.dataset.v; rerenderStats(); break;
    case 'stats-sel': S.stats.sel = el.dataset.v; rerenderStats(); break;

    // GM
    case 'gm-clear': {
      if (!confirm('Clear the dice log for everyone? Dice stats keep counting these rolls.')) break;
      try { await api('gm_clear_rolls'); S.rolls.clear(); ping(); renderLog(); toast('Dice log cleared. Stats kept.'); } catch (err) { fail(err); }
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
