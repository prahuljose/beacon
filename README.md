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

- **Crew board.** The Grit pool (session roll, spend from any d6 roll) and a
  card per character.
- **Sheets.** Bio & Info and Attributes & Abilities tabs.
  - Skills follow the fixed stat matrix. Each one rolls on its own
    (2d6 + skill) or with its stat (2d6 + stat + skill).
  - Temp HP is used up before regular HP.
  - The roll bar shows your Specialty and your last roll, with a Wear reroll
    button next to it.
- **Customizing.** Each sheet has its own colour and portrait. You can hide
  panels and add your own sections and fields.
- **Dice log.** Every roll shows how its total was reached: each die, every
  modifier and where it came from, a Grit die and who added it, and the old
  dice from a Wear reroll.
  - Doubles offer +1 Wear.
  - A manual roller lets you pick the number of dice, the die type and a
    modifier.
- **Scenes (GM).** Upload a map or picture and show it. Players see it in a
  floating window they can drag, minimise or open full screen.
- **The Vault.** A built-in scene with 100 boxes (A1–Y4). Any player can mark
  a box Open, In progress or Complete while the Vault is shown.

Changes reach everyone within about a second (a Supabase Realtime ping), with
2.5 s polling as a backup.

## How it works

- Static `index.html` + `styles.css` + `app.js`. No build step. Vercel serves
  the repo as-is on every push to `main`.
- Data lives in the Supabase project **beacon** (RJ org, ap-south-1).
  `supabase/schema.sql` is the full schema.
- The browser only holds the public Supabase key and a session token. Tables
  are closed to that key. Every call goes through a database function that
  checks the session and the role first.
- `docs/TASKS.md` is the running task list.

## Local preview

```sh
python3 -m http.server 5173
```

Open http://127.0.0.1:5173. It talks to the **live** database, so test on a
throwaway character and delete it afterwards.
