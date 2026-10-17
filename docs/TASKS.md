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

## Round 13 (2026-10-18)
- [x] Tokens on scenes and the Drawing Board (anyone). New "◉ Token" tool with a picker: every character, GM, or NPC (type a name). Clicking places it; a character or the GM has one token per scene (placing again moves it), NPCs can repeat. "✥ Move" (was "Move text") drags tokens and text; others see the drag live (`tokmove` broadcast). Erase removes a token. GM "Clear all" clears tokens too. Tokens are strokes with `piece` ('gm' | 'sheet:<id>' | 'npc:<label>'), drawn as a DOM layer over the canvas. supabase/v7.sql: `strokes.piece`, `place_token`, `move_stroke` accepts tokens.
- [x] GM dice stats on the GM page (GM only, `gm_roll_history`). Crew cards, sortable per-player table with ★ leaders, and a detail view per player: 2d6 totals vs expected, d6 faces vs fair, most-rolled labels, best/worst, recent form, rolls per game day. Ranges: all time / 7 days / 30 days / one game day (named Session #N when it matches a GM session date). "Clear dice log" now archives into `private.roll_archive` so stats survive. Note: if `public.rolls` gets a new column, add it to `private.roll_archive` too (the union uses `select *`).
- [x] Connection banner: "Reconnecting…" / "You're offline." after 2 failed syncs or the browser going offline, then "Back online." for ~2.6 s. Sheet edits made offline wait in `pending` (`waiting: true`) and save when the connection returns; the Saved chip says "Not saved yet · offline".
- [ ] Dice tray polish: design mockup shown to the user (felt tray, pip d6 faces, shaped polyhedral dice, doubles stamp and shake, synthesized clack sound with a toggle, reduced-motion fallback). DO NOT build until the user confirms the design.
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
