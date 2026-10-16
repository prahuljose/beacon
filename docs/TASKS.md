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
