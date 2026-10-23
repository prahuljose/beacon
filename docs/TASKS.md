# Debt portal: task list

Resume from here. Tick items as they land. Repo: `~/VSCode Projs/beacon`, which
deploys to beacon.dpdns.org on push to `main`. Database: Supabase project
`beacon` (id `kposvtazbuizognblzbb`). The schema source of truth is
`supabase/schema.sql`. Apply changes with the Supabase MCP `apply_migration`
and keep the file in sync.

Deploying: whenever app.js or styles.css changes, bump the `?v=` number on both
links in index.html. Cloudflare tells browsers to cache those files for 4
hours; index.html itself isn't cached.

Testing: `python3 -m http.server 5173` in the repo, then open
http://127.0.0.1:5173. It uses the LIVE database, and the user and friends
have real data in it. Never edit existing characters while testing: create a
throwaway "ZZ Test" character, test on it, and delete it (plus its rolls)
afterwards. Don't sign in on the live site; test locally only.

Incident (2026-10-17): an API test overwrote BOBO's job and notes (now
blank) and used up BOBO's Wear (restored to 1). Grit was reset to 5. The user
has been told.

## Round 32 (2026-10-24): New divider, chat alert settings, loading skeletons
- [x] Chat "New" divider: when the chat comes into view with unread messages (opening the app on Crew, switching to Crew, coming back to the tab, or opening the chat from a pop-up), a red NEW line sits above the first unread message, and the list starts there if it's off the top. It stays until you leave Crew or send a message. Also fixes: opening the app straight onto Crew now marks the chat read.
- [x] Chat alert settings: gear on the chat panel opens three switches, saved per login on this device (`debt.chatPrefs.<id>`): ding when mentioned, pop-ups for new messages (badge still counts), count @everyone as a mention. Turning the ding on plays a sample. Esc / click outside closes; survives redraws.
- [x] Loading skeletons: the app's first load shows the page's shape in grey (header, rail, two panels, crew cards, dice column; phone header rows and bottom bar) built from the real layout classes; the login page shows the GM card and four tile placeholders instead of "Loading the crew…". Shimmer off with reduced motion.
- Tested locally (player + temporary GM, private messages only): divider placement, visibility, persistence and clearing; each setting off and back on (pop-ups, ding, @everyone, badge still counts); settings panel open/close; skeletons rendered against the real pages at desktop and phone sizes; all pages; no console errors beyond a stale-session 403. Deployed `?v=34`.

## Round 31 (2026-10-24): chat extras
- [x] supabase/v12.sql (applied; tested first in a rolled-back transaction): `chat.reactions` ({emoji: [sheet id | 'gm']}), `chat.reacted_at`, `chat.image` ({w, h}); `public.chat_images` (picture data, one row per message, newest 50 kept). RPCs `chat_react` (toggle; fixed set 👍 ❤️ 😂 😮 💀 🎲), `chat_send_image` (same rules and rate limit as chat_send, which is untouched; max 600 KB), `chat_image` (only if you can see the message and it isn't deleted). `sync` = v8 plus `chat_react` (reaction changes on messages a client already has).
- [x] @mentions: typing @ offers the GM, everyone and each character (arrows/Enter/Tab pick, Esc closes); full names, @GM, @everyone and unique first names are highlighted, your own in gold. A message mentioning you is tinted, gives a gold Crew badge, a longer "@ you" pop-up and a soft two-note ding (only when you're not looking at the chat).
- [x] Reactions: smiley button on each message (always faintly visible on touch screens) opens the six; chips show counts, yours outlined in brass, names on hover; optimistic with rollback.
- [x] Pictures: button inside the message box, paste, or drop on the chat panel; shrunk in the browser to ≤1600 px JPEG under ~430 KB (small GIFs kept as they are); optional caption; preview with remove; fixed-size boxes so the chat doesn't jump; fetched as they scroll into view; tap for full size (Esc / tap to close); "Picture no longer available" once pruned; GM delete hides the picture too. Pop-ups read "📷 Picture".
- Tested locally (player + temporary GM, private messages only; a test guard blocked anything public): real-keyboard mention picking and sending, @everyone vs someone else's mention, badge/ding/pop-up states, reaction sync both ways, picture send both ways, 4.5 MB PNG → 371 KB, GIF pass-through, non-image refused, pruned and deleted pictures, redraw with the name list open (fixed), all pages for both roles, paste elsewhere untouched, phone width. Deployed `?v=33`.

## Round 30 (2026-10-24): last seen
- [x] supabase/v11.sql (applied): `public.last_seen` (who = sheet id or 'gm', at) kept out of `sheets` so check-ins never trigger sheet re-syncs; RPC `seen(p_token)` stamps the caller and returns everyone's times. Tested in a rolled-back block (player + GM rows, bad session rejected, table not readable by anon).
- [x] Who's here: offline rows show "last seen …" in small grey text under the name (mockup B), full date on hover. Wording: just now / N min ago / N h ago (today) / yesterday, HH:MM / Tue 21 Oct, HH:MM (+year if not this year). The app checks in on load, every minute and when the tab comes back; presence fills the gap (anyone seen here counts as seen now), so someone who just left reads "just now". Times start recording from this release, so offline players show no line until their next visit. Deployed `?v=32`.

## Round 29 (2026-10-21): vault door reveal
- [x] Login vault door: the overlay is now a wall with a round hole exactly behind the door (`.vd-wall`, CSS mask). When the door swings open the portal shows only through the doorway, then the whole vault scales up (`.vdoor.zoom`, scale 4.5, 1 s) until the page is fully revealed. Timeline: dial/bolts 0–1.5 s, door opens 1.5 s, zoom 2.4 s, removed 3.45 s. Click still skips; reduced motion still skips entirely.
- [x] The wall uses the login screen's own background (body stripes + `.login` glow and hairline frame, via `.vd-glow` lined up with the login page's box), so the backdrop doesn't change when the door appears. Checked with headless Chrome against the real login page: background pixels match within 1/255. Welcome text is positioned under the door so the hole stays centred. Deployed `?v=31`.

## Round 28 (2026-10-21)
- [x] Crew cards: the Vice/Virtue chips stretched to the height of the "+1 Grit" button with their text stuck at the top. `.chips` now centres its items and `.chip` centres its text (3/9 px padding, line-height 1.2). Measured: text centred in the chip, chips level with the button. Deployed `?v=30`.

## Round 27 (2026-10-21): page rail with live scenes
- [x] Crew, Rules and Shop (plus Scenes and GM for the GM) moved out of the top bar into a left icon rail (`.rail`, `renderRail`): three heads, open book, shopping bag, folded map, key. Badges on the rail: unread chat on Crew, pending shop requests on Shop (GM), live count on Scenes (GM). The top bar keeps only the character links. Phones (≤900 px): the rail becomes a bottom bar.
- [x] Minimised-scene pills (bottom-left) replaced by a "Live" section in the rail: one tile per live scene (`renderLive`). Turn Order tile shows round, current avatar and first name (bumps on a new turn); picture scenes show a map icon, the Vault a safe icon. Tiles of open windows are highlighted. Click: open a minimised scene, bring a buried window to the front, or minimise the one on top. Phones: a "Live" tab with a count opens a list (Esc / tap outside closes). New scene windows open right of the rail.
- [x] The rail's skeleton is built once and its parts only re-render when their HTML changes, so the frequent sheet syncs never swap a tile under a click.
- Tested locally as a player and as the GM (temporary session) with sample scenes injected client-side only (no real scene activated): routes and active states, chat badge, scenes appearing/disappearing, turn change + bump (fixed a double render cancelling the bump), open/front/minimise/full-screen, window state saved, dev-shop request → GM badge → approve, phone list, GM phone bar (6 items fit at 375 px), login screen, no console errors. Deployed `?v=29`.

## Round 26 (2026-10-21): music fade-in and compact chip
- [x] New tracks start quietly: before a new video/playlist/mood loads the player is set to 0 and fades up to the listener's level (`fadeIn`, ~4 s; 3 s for a mood change on the same video; 1.5 s when the GM resumes). Playlists hush the next song when it's cued (state -1). Moving the slider stops a fade. New listeners default to slider 20 (2%).
- [x] Music chip: speaker + short layered-waves canvas (28×16, drawn not measured: YouTube audio can't be read; amplitude follows your volume, flat when paused/muted). Players see the mood name slide out for 4 s when music starts, the mood changes, or the GM pauses ("Paused by the GM"), then the pill shrinks (~68 px). GM paused = brass "GM" tag + pause; your own mute = red speaker with a cross. GM chip keeps its label. Banner uses the waves too.
- Tested with real playback in the dev room: default level 2, fade 0→level on start/new video/same-video mood change, label timing and width, GM-paused and muted states, GM chip, no app console errors. Deployed `?v=28`.

## Round 25 (2026-10-21): music volume curve
- [x] The music slider now follows loudness, not YouTube's linear volume: slider 1–100 maps geometrically onto YouTube 1–40 (`musicLevel`, `MUSIC_MAX = 40`): 10 → 1, 20 → 2, 30 → 3, 40 → 4, 50 → 6, 70 → 13, 100 → 40. Default 30. Saved settings move to `debt.musicVol2`, converted so they sound the same (old 2 → 20, old 3 → 30; anything above 40 → 100).
- [x] Bug found while testing: `applyVolume` called `setVolume()` then `unMute()`, and YouTube's unMute lifts anything under 5 back to 5, so every level below 5% played at 5%. Now it unmutes first (only if muted) and sets the level after. Checked against the real player: every slider step gives the expected YouTube volume, mute and unmute work. Deployed `?v=27`.

## Round 24 (2026-10-21)
- [x] Who's-here list: a long name (e.g. Wally Wallbanger) truncated together with the "you" tag, which showed as dots. The name now truncates on its own (`.ol-n`) and the tag always shows in full. Checked with a long throwaway name. Deployed `?v=26`.

## Round 23 (2026-10-21): the Shop
- [x] Backup first: schema `backup_20261021` (sheets, rolls, chat, crew, gm_notes, gm_sessions, scenes, strokes, vault_boxes, music, roll_archive). Row counts verified.
- [x] supabase/v10.sql: `public.shop` (one row per room 'live' / 'dev'; `catalog` jsonb, `open`, `sold` counts kept apart so catalogue edits never reset them) and `public.shop_orders` (snapshot of items, total, status pending/approved/declined/cancelled/refunded, gift). `chat.kind` ('msg' | 'shop'). RPCs: `shop_get` (players get only open categories, visible items, revealed effects, units left; never GM notes; their own orders without stats), `gm_shop_save`, `shop_order` (players only; prices from the catalogue; checks open/visible/stock/money minus pending; max 5 pending), `shop_cancel`, `gm_shop_decide` (approve runs `private.shop_apply`: money off, items → Gear (items, weapons with dice/stat/effect) or Kit (armor with reduction/durability), sold counts, chat line "X bought …" in the live room only), `gm_shop_refund` (money back, removes that order's items by `oid`, restocks), `gm_shop_give` (free or priced gift, "got … from the GM"). Lock order shop → sheet everywhere.
- [x] `patch_sheet` guard: a whole Gear/Kit save that lacks a shop item added in the last 20 s keeps it (shop items carry `oid` + `at`), so a browser that hadn't seen an approval can't wipe the purchase. Client also merges newly seen shop items into a queued Gear/Kit save (`sheetRecord`, `S.seenOids`).
- [x] Catalogue seeded from the user's sample Shop.html: 10 categories, 73 items, notes, short effects (all hidden at first), weapons parsed to dice/stat/effect (Baton has no damage roll, stays an item), armor to reduction/durability. Live shop starts CLOSED.
- [x] Client: Shop tab (GM always, with a pending-requests badge; players only while open). Player: money left (+ held by pending requests), category chips, search, rows with type tag / revealed effect / units left / Sold out, cart with qty (kept per character in localStorage), "Left after approval", Request purchase, Your orders (cancel while pending), toasts when the GM decides. GM: open/close banner, Requests tab (approve/decline with "has $X" warning, history with Refund, Give an item), Catalogue tab (inline edit names, prices, effects, reveal toggle, stock, hide/show, type + weapon/armor stats, notes short/full, add/delete items and categories, reveal/hide all), Player preview. Saves debounced (700 ms), editor never re-renders under the caret. Chat shows purchases as a green "🛒 X bought …" line. Prefixed CSS (sh-).
- Tests (all on throwaway data; server tests in rolled-back transactions): closed shop, visibility/leaks (no notes, hidden effects, hidden items), price tampering ignored, stock, money incl. pending, qty bounds, 5-pending cap, permissions (players can't save/approve/refund/give/cancel others; GM can't order), approve/refund/decline/cancel/give, chat line text, patch_sheet regression (fields, nested, list removal, permissions, GM full replace) + race guard; UI in dev room: GM edits saved to dev only, player view correct, cart → request → GM toast/badge → approve → sheet (Gear/Kit/money) + player toast, client race merge, refund, stock sold out for others, poor player limits, cancel/decline/gift, all pages load, music/online chips intact, phone layout, no console errors. Afterwards sheets identical to backup, chat/rolls/strokes/vault unchanged, no test rows left. Deployed `?v=25`.

## Round 22 (2026-10-18): shared background music (YouTube)
- [x] supabase/v9.sql: `public.music` (one row per room: 'live' for the site, 'dev' for local tests so tests never reach players), `music_get(room)` (moods only returned to the GM), `gm_music_set(room, state, moods)` (GM only; server stamps `at`). Kept out of sync() on purpose; clients fetch it every 10 s and get instant updates over the realtime 'music' broadcast.
- [x] Client: YouTube IFrame API player per client. GM sees the video in the jukebox popover (a fixed host positioned over a slot; never moved in the DOM, which would reload it); players' player is invisible (opacity 0) and they only get volume + mute (localStorage `debt.musicVol` / `debt.musicMute`). Clients compute where the track should be from pos + server-time elapsed and correct drift > 3 s every 4 s; the GM's player is the reference (publishes playlist auto-advance, title, and its real position after ads/buffering). Pause fades out over ~0.8 s.
- [x] UI: top-bar ♪ chip (eq bars, mood name; icon-only at 901–1360px so tabs keep room), player popover (volume only), GM jukebox (video, seek for all, play/pause for all, prev/next for playlists, loop, Silence, moods grid with save/remove, "Play link now", who's listening from presence `music` meta, own volume). "The GM is playing music · Tap to listen" banner until the first click/key on the page (browser autoplay rule). Logout destroys the player.
- Note: hiding the player for players goes against YouTube's embed policy (III.I.9, background players); the user chose this knowingly. If YouTube ever blocks hidden playback, switch moods to uploaded audio files (the state model already supports a different source).
- Tested in the dev room with a throwaway player and temp GM: mood save, play (GM state 1, title auto-filled), player banner + real click unlock, sync drift 0.2–0.5 s, pause/play/seek reaching the player, playlist load + next followed by the player, volume 25% + mute stored and shown in GM's listeners, Silence, bad link rejected, link parsing (watch, youtu.be, shorts, music.youtube, radio mix → video, non-YouTube rejected), logout cleanup, online chip unaffected. Dev room reset, test rows deleted; live music row untouched (empty). Deployed `?v=24`.

## Round 21 (2026-10-18): chat moderation, rate limit, spam-proof pop-ups
- [x] supabase/v8.sql: `chat.deleted_at` (soft delete: rows stay, hidden from everyone; recoverable by setting it back to null). `gm_chat_delete(id)` and `gm_chat_clear()` (GM only). `sync` hides deleted rows and returns `chat_deleted` (ids deleted since the last sync) so open clients drop them. `chat_send` is rate limited per sender (5 per 10 s, 20 per minute; advisory lock so bursts can't race) and raises `slow_down`.
- [x] GM UI: bin icon on each chat message (shows on hover; always faint on touch screens) with a confirm; GM page Settings column has a Chat section with the live message count and "Erase all chat" (confirm). Players never see either.
- [x] Pop-ups can't pile up: messages arriving together are grouped by sender; one card per sender (private separate) that updates with "N new"; at most 3 cards; new senders beyond that go into a "+N more messages in chat" pill instead of knocking cards out. Deleted messages are pulled out of cards (card vanishes if empty). Send button can't double-submit; a slow_down shows a toast and keeps the draft.
- Tested: server checks inside rolled-back transactions (rate limit 5 ok / 6th refused, player sees then loses a deleted message via chat_deleted, full sync excludes it, players get gm_only on erase, erase hides all but keeps rows). UI with in-browser messages and stubbed delete/erase calls (burst grouping, delete propagation to cards, bin + confirm, erase all, slow_down toast with draft kept, players have no bins), no console errors. Real chat and sheets verified identical to the backup afterwards; nothing committed by tests. Deployed `?v=23`.

## Round 20 (2026-10-18): chat alerts
- [x] Backup first: `backup_20261018` schema (not exposed to the API) holds copies of sheets, rolls, chat, crew, gm_notes, gm_sessions, scenes, strokes, vault_boxes and private.roll_archive (sessions and the secret left out). Row counts verified. Drop it later with `drop schema backup_20261018 cascade;` once no longer wanted.
- [x] Unread badge on the Crew tab (red; purple when one is private; 9+ cap). Pop-up cards bottom-right (left of the dice panel on desktop, above the dice button on tablet/phone): sender, private tag, first 140 chars; click opens Crew and focuses the chat; × or 6.5 s to dismiss (pauses on hover); max 3; private ones look like a folded note. Tab title "(n) Debt" and a red dot on the favicon while unread.
- How it works: client only, no DB change. Each login stores the newest message id it has seen in localStorage (`debt.chatSeen.<gm|sheet id>`); first visit starts from "now" (no backlog). Own messages never count. Crew page + visible tab = read. Other tabs of the same login sync through the `storage` event. Logout resets title/icon and clears pop-ups.
- Tested with two throwaway players + temp GM (private messages only, so real players saw nothing; public path simulated in-browser): first-visit no backlog, private alert to player, click-to-open clears, no alert while on Crew, own message ignored, GM alerted on Scenes page, reload keeps badge without repeat pop-ups, other player can't see privates, two-tab sync, typing on a sheet while a message arrives keeps focus and saves, phone layout, logout reset, dice roll, no console errors. Test rows deleted; sheets/chat/vault contents verified byte-identical to the backup. Deployed `?v=22`.

## Round 19 (2026-10-18): minimised scenes column
- [x] Minimised scene pills (and the Turn Order pill) were covering page content at the bottom-left. On screens wider than 900px they now stack in a column at the top-left under the top bar (equal widths, scrolls if very long). `fitPills()` pushes `.main` right (`--pills-pad`) only as far as needed to clear the column, re-measuring because centred content moves half as far as its padding; runs on renderPills, renderMain and resize. Phones keep the bottom row, and `.main` gets 150px of extra bottom room when any pill is showing so content can scroll above them.
- Checked at 1100, 1440, 1920, 2400 and phone width, with fake minimised scenes (local only). Deployed `?v=20`.
- [x] Follow-up: the user wanted the column at the bottom-left instead of the top. Anchored to `bottom: 16px` (stacks upward, same content push). Deployed `?v=21`.

## Round 18 (2026-10-18): hotfix
- [x] GM Scenes page showed only a giant Vault grid over everything. Cause: the vault-door login animation (Round 15) used class names `.vault` and `.vault-frame`, which the Vault scene already uses, so the door's `position: fixed; inset: 0` overlay rules hijacked the scene. Renamed every door class to `vdoor` / `vd-*`. Checked the other new generic class names (tray, token, bar, exp…): each is only used by its own feature. Lesson: prefix new feature classes. Deployed `?v=19`.

## Round 17 (2026-10-18): hanging neon sign
- [x] Login "DEBT" is now design H: the Alfa Slab letters traced in amber neon (dark fill, amber tube, pale core, soft blurred halo at ~40% glow) on a riveted steel plate hanging from two chains that fade up into the dark; it sways ±0.6° over 9 s. Built as an inline SVG, one `<g class="ns-l">` per letter so a single letter can sputter (`.off` turns the tube to grey glass); about 1 time in 8 the whole sign drops out. Reduced motion: no sway, no flicker. Old `.neon` text-shadow sign removed.
- Checked at desktop and phone widths. Deployed `?v=18`.

## Round 16 (2026-10-18)
- [x] Online chip stuck on "Connecting…" after a player logged in (user report; couldn't reproduce locally or on the live login page). Made it self-healing: a 3 s watchdog sets the chip from the channel's real state (`channel.state === 'joined'`), re-tracks our own presence if it's missing or stale (e.g. still the login-page viewer), and replaces a channel that stays down for 12 s (`rtClient.removeChannel` + `connectRealtime`). Callbacks from a replaced channel are ignored. Tested: forced-off flag heals in 3 s, stale viewer meta re-tracked, a killed channel rejoins in ~15 s.
- [x] Vault door: removed the "DEBT · CREW VAULT" plate; bolts offset 22.5° so none sit at top/bottom. "Welcome back, <name>" under the door stays.
- [x] Neon sign redesign: after three rounds of mockups the user picked H, built in Round 17.
- Deployed `?v=17`.

## Round 15 (2026-10-18): login page extras
- [x] Flickering neon sign: "DEBT" is four amber neon tubes; every few seconds one sputters, and about 1 time in 8 the whole sign blacks out for half a second (`startNeon`, stops itself when the login page is gone; off for reduced motion).
- [x] Live status on the ID cards: Online (pulsing green dot) / Away / Offline under each name, and "· GM is in / away" on the GM card. Uses the same Realtime presence as the top bar. The login page has to track something to receive presence, so it tracks `{ role: 'viewer' }`, which presenceMap() ignores (no one sees it).
- [x] Vault-door unlock: a small brass dial spins next to Enter while checking and clunks red on a wrong password. A right password shows a full-screen vault door: wheel spins, bolts pull in, the door swings open on its hinge (~2.5 s, click to skip) while the portal loads behind it. "Welcome back, <name>".
- [x] GM's desk: the GM card is a wood desk under a green banker's lamp with an open ledger, a die and a cigar smoking in an ashtray (inline SVG, `DESK_SVG`). On phones the props sit under the text.
- Tested locally (throwaway ZZ character with a placeholder hash so it shows as ready, temporary GM and player sessions to drive the dots); all deleted. Deployed `?v=16`.

## Round 14 (2026-10-18): dice tray
- [x] Felt dice tray in the dice panel, between the roller and the log. It opens on each new roll, Grit die or Wear reroll (anyone's roll you can see), plays it, then closes. Several at once queue (max 3 waiting; older ones land straight away).
- [x] New roll: dice tumble in (d6 cubes with pips; d4/d8/d10/d12/d20 shaped, d100 a tile; at most 8 shown). Grit: original dice dim, a brass die rolls in from the right. Wear reroll: old dice swept off, new ones roll in (plus the Grit die when the "Wear rerolls the Grit die too" setting is on).
- [x] The log entry waits (`TRAY.hold`: new rolls hidden; Grit/reroll entries show the old state, rerolled dice greyed, action buttons hidden) and then lands (`TRAY.settle`): d6s show pips then fade into the number tile, other dice pop in, the total counts up/down, doubles get gold rings + a "Doubles" stamp + a small shake, the Grit tag pulses. `--el` (negative animation delay) keeps animations in step across re-renders.
- [x] Sound: a rattle made with Web Audio (no files), speaker toggle in the dice header, saved per browser (`debt.sound`).
- [x] No tray when it can't be seen: tab hidden, phone drawer closed, or reduced motion; those show the roll straight away as before. Own-roll toasts are skipped when the tray shows it.
- Tested locally with a temporary GM session and a ZZ Test character (private rolls, real reroll; Grit and doubles simulated in the browser so the shared pool wasn't touched); test rolls, sheet and session deleted. Deployed `?v=15`.

## Round 13 (2026-10-18)
- [x] Tokens on scenes and the Drawing Board (anyone). New "◉ Token" tool with a picker: every character, GM, or NPC (type a name). Clicking places it; a character or the GM has one token per scene (placing again moves it), NPCs can repeat. "✥ Move" (was "Move text") drags tokens and text; others see the drag live (`tokmove` broadcast). Erase removes a token. GM "Clear all" clears tokens too. Tokens are strokes with `piece` ('gm' | 'sheet:<id>' | 'npc:<label>'), drawn as a DOM layer over the canvas. supabase/v7.sql: `strokes.piece`, `place_token`, `move_stroke` accepts tokens.
- [x] GM dice stats on the GM page (GM only, `gm_roll_history`). Crew cards, sortable per-player table with ★ leaders, and a detail view per player: 2d6 totals vs expected, d6 faces vs fair, most-rolled labels, best/worst, recent form, rolls per game day. Ranges: all time / 7 days / 30 days / one game day (named Session #N when it matches a GM session date). "Clear dice log" now archives into `private.roll_archive` so stats survive. Note: if `public.rolls` gets a new column, add it to `private.roll_archive` too (the union uses `select *`).
- [x] Connection banner: "Reconnecting…" / "You're offline." after 2 failed syncs or the browser going offline, then "Back online." for ~2.6 s. Sheet edits made offline wait in `pending` (`waiting: true`) and save when the connection returns; the Saved chip says "Not saved yet · offline".
- [x] Dice tray polish: designed with the user over three mockups, built in Round 14.
- Tested locally with a temporary GM session on a hidden throwaway scene and a ZZ Test character, all deleted afterwards. Deployed `?v=14`.

## Round 12 (2026-10-18)
- [x] Online chip padding: the first portrait was pulled past the pill's left edge by the -7px overlap margin. The first portrait now has no negative margin, the chip has 5px left padding, and portraits are round. Checked with 1 and 3 portraits on desktop and phone. Deployed `?v=13`.

## Round 11 (2026-10-18)
- [x] Moved the online chip to the right of the top bar, just before the signed-in chip; its list opens leftwards. On narrow screens Log out stays right-aligned on the second row. Checked desktop + phone. Deployed `?v=12`.

## Round 10 request (2026-10-18): players online
- [x] Top-bar chip "N / M online" with overlapping portraits. M counts only characters with a login. Clicking it lists GM + every character: Online (tab in front), Away (tab in background), Offline, No login yet.
- [x] Built on Supabase Realtime Presence over the existing channel. Each tab tracks { role, sheet_id, away } with its own key. Several tabs on one character count once, and any foreground tab wins. Log out untracks; closing the tab drops off within seconds; a dead connection times out (~30 s).
- [x] Safety: local dev (localhost/127.0.0.1) joins `debt-crew-dev`, so tests never show to the real crew. Presence is client-reported (fine among friends) and carries no secrets.
- [x] supabase/v6.sql: sync now returns `has_pass` to everyone (already public via login_options) to drive "No login yet".
- [x] Tested on the isolated channel with a temporary GM session + throwaway players (Online, Away simulated via visibilitychange, Offline on logout and on tab close, No login yet). Cleaned up. Deployed `?v=11`.

## Round 9 request (2026-10-18)
- [x] Drawing Board full screen: a "⤢ Full screen" button in its toolbar (Esc or the button exits). Same 16:7 shape, so existing drawings stay in place, just bigger.
- [x] Text entry no longer jumps or scrolls: it was an input caught by the global `input { width: 100% }` rule, so it overflowed off the board and focus scrolled the page. Now a textarea sized to its text, clamped inside the board, focused with preventScroll.
- [x] Shift+Enter adds a new line; Enter saves; Esc cancels. Multi-line labels draw, move (select tool) and erase as one block. Short "Type here" placeholder plus a small hint under the box.
- [x] Fixed while testing: the full-screen board overflowed on the right (`.draw { width: 100% }` beat the insets).
- [x] Note: during testing the board was "Clear all"-ed by a GM session on the live site (not the test), which removed HOHO's "asd" and a GM pen stroke.
- [x] Deployed `?v=10`.

## Round 8 request (2026-10-18)
- [x] In-game Day and Time in the top bar (next to DEBT), visible to everyone at all times. Only the GM can change it: click the clock for Day −/+, time −1h/−15m/+15m/+1h, a time box, and presets (Dawn, Morning, Noon, Dusk, Night, Midnight). Going past midnight moves to the next day. The style changes with the time (sun by day, horizon at dawn/dusk, moon and blue tint at night) and pulses when it changes.
- [x] Stored as `crew.settings.clock = { day, minutes }` and saved via gm_set_settings (GM-only), so no DB migration was needed.
- [x] Bug caught in testing: 00:00 was treated as unset and showed 08:00. Fixed.
- [x] The user has changed the GM password (no longer the original). For local GM testing I used a temporary `zztest-gm-…` session inserted in private.sessions, then deleted it. Deployed `?v=8`.

## Round 7 request (2026-10-17)
- [x] Login page redesign, on brand: big DEBT wordmark, a featured brass "Game Master" card (seal, sheen, Sign in button), ID-card tiles with large portraits and name plates (accent strip, tick when picked, greyed "No password yet"), a password panel that opens under whatever was picked, and a shake on a wrong password.
- [x] Fixed while checking it by eye: the old `#login-pass` rule (360px, full-width button) squeezed the panel; the entrance animation's `both` fill blocked hover lifts (now `backwards`).
- [x] Checked on desktop 1280 and phone 375 (no sideways scroll). Wrong and right password both tested. Deployed `?v=7`.

## Round 6 request (2026-10-17)
- [x] Minimised Turn Order pill shows the round, the current person (portrait and colour) and who's next. It pulses when the turn changes.
- [x] Vault redesign: one brass frame and "VAULT" title around all three blocks, which now look identical (the brass middle block made only K–O look like the vault).
- [x] Tested locally with live scenes faked client-side only (no server writes, so no pop-ups for players online). Deployed `?v=6`.

## Round 5 request (2026-10-17)

### Progress
- [x] DB migration v5 (supabase/v5.sql): scenes.state, kind 'turns', move_stroke, gm_scene_state
- [x] Front end v5
- [x] Tested locally (GM + throwaway player), cleaned up
- [x] Deployed (`?v=5`)

### Items
- [x] Select tool on scenes and the board: drag text labels around (text only).
- [x] Text size picker (5 sizes) when the Text tool is on. Separate from pen width.
- [x] GM Settings: toggles instead of checkboxes, same layout for every setting, separated rows.
- [x] Combat rules: apply the user's updated sheet (new Turns panel and action table, revised Dropping text and status effects).
- [x] Doubles styling: a 1,1 roll is red faces, so the red doubles ring clashed. Doubles now get a distinct ring.
- [x] Turn Order special scene (like the Vault): GM-only control. Add characters or custom entities (no sheet), initiative numbers, sort, reorder, remove, Next/Prev turn with the current turn highlighted, round counter. Players see it read-only. No drawing or pings.

### Round 5 notes
- Bug found in testing: the `.draw` wrapper now carries `data-tool`, so `closest('[data-tool]')` swallowed size/width clicks. The lookup is now `.tool[data-tool]`.
- Doubles = a gold ring with a gap (box-shadow), clear on red 1s and green tops. The Grit die keeps its brass ring with no gap.
- Turn Order entries: `{ id, name, sheet_id|null, init }`. Characters show their portrait and colour; extras are tagged "extra". The highlight follows the current entity when reordering.

## Round 4 request (2026-10-17)

Findings:
- Portrait "only shows on hover": the CSS rule `.portrait-btn span` (for the
  "Change" label) also matched the avatar, which became a `<span>` in v2, so
  the avatar was hidden until hover.
- Formula "no breakdown": BOBO's `2d6+2+wits+perception` went into the label
  box of the manual roller, so it rolled plain 2d6 with that text as its label.
  Fix: a single input that rolls formulas and otherwise acts as the label.
- Custom-roller doubles not banking: those were 2d8 doubles, and only 2d6
  banked. Now any 2 matching dice count as doubles.

### Progress
- [x] DB migration v4 (supabase/v4.sql)
- [x] Front end v4
- [x] Tested locally (GM + throwaway player), cleaned up
- [x] Deployed (`?v=4`)

### Items
- [x] Fix the portrait picker (always visible, editable without hover). Test it visually.
- [x] Weapon: "No stat" option (+0), damage die dropdown d2–d10, free-text Effect, roll button shows only a die icon.
- [x] Kit panel: Apparel (free text) or Armor (Durability + Damage Reduction numbers, no roll).
- [x] Drawing Board becomes a blackboard.
- [x] Text tool: static text on the board and on scenes.
- [x] 5 pen widths.
- [x] GM-only pen colour picker.
- [x] Private chat: players → GM. The GM can reply privately to one player. Clear indication for both sides.
- [x] Dice input: formulas like `2d6+2+wits+perception` always parse (show the breakdown and grey mods).
- [x] Dice faces: a 1 is a red box with white text; the max face (a 6 on d6) is a green box with white text. All rolls.
- [x] Doubles = any 2 matching dice (any die type) and auto-bank Wear.
- [x] Rules page: a Combat Rules tab (content from the user's CREW RULES COMBAT doc). Players see it only when the GM setting "Show Combat rules" is on. No other logic changes.
- [x] Remove "Gear & weapons" from Crew rules.
- [x] GM Session Notes: a dated list, Session #1 (earliest) … #N (latest). Add, edit any, delete. The old single note was migrated into Session #1.

### Round 4 decisions (tell the user)
- Green = the die's top face (6 on a d6, 8 on a d8 …), red = 1. On a d6 that's exactly 6 and 1.
- One roller input: text starting with a formula (`2d6…`) is rolled as a formula; anything else is a label for the stepper dice. A live hint under it says which.
- Pen widths also set the text size. The GM pen colour is saved per browser.
- The GM replies privately via the "Reply privately" button or the "Private to X" picker.
- Combat rules are reference only. The GM's banner on that tab shows/hides it for players.

## Round 3 request (2026-10-17)

Root cause of the "blank page after lock" bug: not the lock. Seeded sheets
had no `gear` array in the DB, and typing into gear slot 1 patched
`gear.0`. `patch_sheet` created the missing parent as an *object*, so NONO
got `{"0":"sss"}` and the client crashed on `gear.map`. Fix: the client always
saves `gear`/`custom` as whole arrays, `normalize()` repairs objects into
arrays, and NONO's data was repaired in the DB.

### Progress
- [x] DB migration v3 (supabase/v3.sql, applied and API-tested on throwaway characters)
- [x] Front end v3 (app.js rewrite + styles)
- [x] Tested locally as GM and player (throwaway ZZ Test), then cleaned up
- [x] Deployed (`?v=3`)

### Items
- [x] Remove Quick Rules from the Crew page. Rules live only on the Rules page.
- [x] Chat goes where Quick Rules was (simple: name, message, time; everyone).
- [x] Players can add and remove Grit (+/−, pips).
- [x] Dice log: show modifiers inline in grey next to the dice, AND the breakdown.
- [x] Breakdown shows every part, even +0 (e.g. "History skill +0").
- [x] GM setting (global): a Wear reroll also rerolls the Grit die.
- [x] Doubles auto-bank 1 Wear. At max, the log says "already at max Wear".
- [x] Bug: profile picture couldn't be added or changed. Check and fix.
- [x] Skills: remove the skill-only roll. Only stat, or stat + skill.
- [x] Remove the lock feature completely (UI + server). Unlock all sheets.
- [x] Sheet order: HP, Dropping, Wear above Stats & Skills.
- [x] Remove the "Last roll / reroll" strip from the sheet.
- [x] Dice animation when rerolled or a Grit die is added (and on fresh rolls).
- [x] Dice log avatar 2× bigger.
- [x] Gear: each slot is an item or a weapon. A weapon has damage (N d6) + stat + permanent bonus (default 0). Roll damage from the sheet.
- [x] Login screen: bigger character icons.
- [x] Vault DANGER: GM marks boxes. Hidden from players until the box is Open / In progress / Complete, then shown in a special style.
- [x] Scenes: several can be active at once. Each opens its own floating window for players (drag, minimise). The GM clearly sees which are live.
- [x] Image scenes: pen in your profile colour, eraser, ping (fades after ~1 s, in your colour). Realtime for everyone. GM can clear all markings.
- [x] Drawing Board: a special shared blank canvas, always on the Crew page, with the same pen/erase/ping.
- [x] Player tab order: Crew, Rules, then their sheet (others after).
- [x] GM can permanently delete a character from Deleted characters.
- [x] Rolls can be public or private (GM-only). Clear marker for the GM. The GM can roll privately (GM-only).
- [x] GM can raise an individual player's Wear max (default 3).
- [x] Dice formula supports skills: `2d6+wits+perception`.
- [x] GM page: two notes, "GM Session Notes" and "GM Notes".
- [x] Rules page: GM-editable free text at the bottom. Read-only for players.

### Round 3 decisions (tell the user)
- Players can view other sheets read-only (unchanged). Anyone can now use Grit +/−, the pips and "+1 Grit" on cards.
- Doubles auto-bank on any 2d6 sheet roll (including HP and damage), and again if a Wear reroll lands doubles.
- The eraser removes whole strokes, anyone's. Pings and in-progress strokes go over Realtime broadcast only; saved strokes go to the DB.
- DANGER shows to players once a box is Open, In progress or Complete.
- A private roll from a player is seen by that player and the GM. A GM private roll is GM-only. Grit can't be added to rolls you can't see.
- The GM's pen colour is cream (#f1e7c9). Players draw in their sheet colour.

## Round 2 request (2026-10-17)

### Progress
- [x] DB migration v2 applied (sessions, locks, scenes, vault, parts/history, new RPCs). GM password set by SQL (never write passwords in this public repo).
- [x] Front end rewrite (app.js/styles.css), tested locally as GM and as a player (ZZ Test, since deleted).
- [x] Deployed.

### Governance and login
- [x] Login = pick your character + its password. GM logs in as "Game Master" with the GM password.
- [x] Session tokens (table `private.sessions`). No password kept in the browser. Logout button.
- [x] GM sets and changes every character's password in the app (no Supabase trip). Changing one signs that player out.
- [x] GM can change their own password in the app.
- [x] Only the GM creates, deletes, duplicates or imports characters.
- [x] Players edit only their own sheet. Other sheets are view-only.
- [x] GM lock per sheet: freezes Identity (name, player, job, specialty, vice, virtue, portrait), Appearance, Backstory, Gear for the player. Enforced in `patch_sheet`.
- [x] GM lock/unlock for the Grit session roll. Anyone can roll it while it's open, and rolling it closes it again.

### Rolls
- [x] Wear = reroll tokens (max 3). Never automatic. Doubles *offer* "Mark 1 Wear". Reroll any of your own rolls (HP included) by spending 1 Wear, which takes Wear down by 1.
- [x] Reroll UI next to rolls: the "Last roll" strip on the sheet plus a button on log entries. Shows Wear left.
- [x] Every roll stores `parts` (label + value per modifier). The log shows a breakdown of dice, each modifier and why, Grit dice with who added them, and the old dice from a Wear reroll.
- [x] Manual roller like Roll20: number of dice, die type, modifier, optional label. Keep the text formula too.
- [x] Max 1 Grit per roll (server check). Grit and rolls show the player's character name, never "Someone".
- [x] The roller's portrait sits beside each log entry.

### Sheet
- [x] Skills follow the fixed matrix: Int (Investigation, History, Technology), Wits (Perception, Insight, Survival), Str (Athletics, Intimidation, Endurance), Dex (Stealth, Sleight of Hand, Acrobatics), Manip (Deception, Persuasion, Performance), Comp (Nerve, Empathy, Focus). Data shape: `skills: { SkillName: bonus }`.
- [x] Each skill rolls either "skill only" (2d6 + skill) or "with stat" (2d6 + stat + skill).
- [x] Show the Specialty text on the Attributes tab, in the roll bar.
- [x] Temp HP (`hp.temp`). −1 uses up temp HP first. Shown on the sheet and the crew card.
- [x] Bug: vice/virtue couldn't be changed once set (datalist filtering). Switch to selects.
- [x] Money: drop the roll button. Note "Starting cash is 2d6 × $60." Plain editable fields.

### Scenes
- [x] GM-only scenes: upload an image, title and caption. Show one to players or hide all. Rename, delete.
- [x] Players see the shown scene in a floating window: drag, minimise to a pill, fullscreen. It reopens when the GM changes the scene.
- [x] Near-realtime: Supabase Realtime broadcast "ping" after writes, with 2.5 s polling as backup.
- [x] Special built-in Vault scene: 100 boxes laid out as in the sketch.
  - Left block: A–J, 4 boxes each.
  - Centre top block under the "VAULT" header: K–O, 4 boxes each.
  - Right block: P–Y, 4 boxes each.
  - Codes look like A1–A4.
  - Each box is unmarked, Open, In progress or Complete. Any player can change it while the Vault is shown; the GM always can.

### UI
- [x] Rename Beacon → Debt everywhere in the UI. The domain stays.
- [x] Logout button in the top bar.
- [x] Rules page Wear text matches the new reroll-token rule.

## Decisions made (tell the user)
- Others' sheets are view-only for players (they can still see them).
- Grit +/−, set and "+1 Grit for vice/virtue" are GM-only. Players can spend Grit and do the session roll while it's open.
- Lock covers exactly the four areas above. Stats, skills, HP, Wear, money, notes and custom sections stay editable.
- Death-roll pips update from the roll, and are corrected if that roll is rerolled with Wear.

## Done earlier (round 1)
Portal v1 shipped on 2026-10-17: shared password, sheets, dice log, Grit, Wear (auto), GM notes.
