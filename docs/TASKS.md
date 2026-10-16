# Debt portal: task list

Resume from here. Tick items as they land. Repo: `~/VSCode Projs/beacon`, which
deploys to beacon.dpdns.org on push to `main`. Database: Supabase project
`beacon` (id `kposvtazbuizognblzbb`). The schema source of truth is
`supabase/schema.sql`. Apply changes with the Supabase MCP `apply_migration`
and keep the file in sync.

Testing: `python3 -m http.server 5173` in the repo, then open
http://127.0.0.1:5173. It uses the LIVE database, and the user and friends
have real data in it. Never edit existing characters while testing: create a
throwaway "ZZ Test" character, test on it, and delete it (plus its rolls)
afterwards. Don't sign in on the live site; test locally only.

Incident (2026-10-17): an API test overwrote BOBO's job and notes (now
blank) and used up BOBO's Wear (restored to 1). Grit was reset to 5. The user
has been told.

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
