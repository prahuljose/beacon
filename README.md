# Debt

The crew portal for our *Debt* campaign, live at
[beacon.dpdns.org](https://beacon.dpdns.org). It replaces Roll20: character
sheets, a shared dice log, the Grit pool, Wear rerolls, scenes and the Vault.

## Logging in

- **Players** pick their character and type the password the GM gave them.
  They edit only their own sheet. Everyone else's is view-only.
- **The GM** picks "Game Master". The GM sees and edits everything. The GM
  page sets every character's password, locks sheets, reopens the session
  Grit roll, and changes the GM password. No Supabase visit needed.

## What's in it

- **Crew board.**
  - Shared Grit pool: anyone can add, remove or spend Grit. The session roll is once per session, and the GM reopens it.
  - Chat.
  - A card per character.
  - The shared **Drawing Board**.
- **Sheets.** Bio & Info and Attributes & Abilities tabs.
  - HP (with temp HP), Dropping and Wear sit above Stats & Skills.
  - Skills follow the fixed stat matrix and always roll with their stat.
  - Gear slots are items or weapons. A weapon rolls N d6 + a stat + a permanent bonus.
- **Customizing.** Each sheet has its own colour and portrait. You can hide panels and add your own sections and fields.
- **Dice log.**
  - Rolls are public, or private (only the roller and the GM; the GM's private rolls are GM-only).
  - Each roll shows its modifiers next to the dice and a full breakdown underneath.
  - Doubles bank Wear automatically, and Wear rerolls any of your rolls. A GM setting makes rerolls include the Grit die.
  - Dice animate when rolled or rerolled.
  - A manual roller, plus formulas like `2d6+wits+perception`.
- **Scenes (GM).** Upload maps or pictures. Several can be live at once, each in its own floating window for everyone.
  - Everyone can draw in their colour, erase and ping. The GM can clear a scene.
- **Turn Order.** A built-in scene the GM controls: characters and extras, initiative, sort, reorder, Next turn with the current turn highlighted, and a round counter. Players watch it read-only.
- **The Vault.** A built-in scene with 100 boxes (A1–Y4).
  - Players mark boxes Open, In progress or Complete.
  - The GM can secretly mark DANGER boxes, which show to players once opened.
- **GM page.** Logins and passwords, Wear max per character, settings, Session Notes and GM Notes, the session roll, clearing the log, and restoring or permanently deleting characters.
- **Rules page.** The crew rules, plus a note at the bottom that only the GM can edit.

Changes reach everyone within about a second (Supabase Realtime), with 2.5 s
polling as a backup.

## How it works

- Static `index.html` + `styles.css` + `app.js`. No build step. Vercel serves
  the repo as-is on every push to `main`.
- Data lives in the Supabase project **beacon** (RJ org, ap-south-1).
  The schema is `supabase/schema.sql` (v2), then `supabase/v3.sql`, `v4.sql` and `v5.sql` on top.
- The browser only holds the public Supabase key and a session token. Tables
  are closed to that key. Every call goes through a database function that
  checks the session and the role first.
- `docs/TASKS.md` is the running task list. Bump the `?v=` asset version in
  `index.html` on every front-end change (Cloudflare caches assets for 4 hours).

## Local preview

```sh
python3 -m http.server 5173
```

Open http://127.0.0.1:5173. It talks to the **live** database, so test on a
throwaway character and delete it afterwards.
