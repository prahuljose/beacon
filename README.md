# Beacon

The crew portal for our game, live at [beacon.dpdns.org](https://beacon.dpdns.org).
It replaces Roll20: character sheets, a shared dice log, the Grit pool, Wear
tracking and private GM notes.

## What's in it

- **Crew board.** The Grit pool (session roll, +/−, spend from any d6 roll),
  plus a card for each character with HP, Wear, money, vice and virtue.
- **Character sheets.** Bio & Info and Attributes & Abilities tabs, like the
  Roll20 sheet. Click a stat or skill to roll 2d6 + mod. The "Next roll" bar
  adds Specialty +2 or a one-off bonus.
- **Customizing.** Each sheet has its own colour and portrait. You can hide
  any panel and add your own sections and fields: text, number, checkbox,
  tracker boxes, or roll buttons with formulas like `2d6+dex+spec`.
- **Dice log.** Shared by everyone and rolled on the server. Doubles on a
  sheet roll mark 1 Wear automatically. Any d6 roll can take a Grit die, and a
  sheet roll can be pushed (mark 1 Wear, reroll) until 3 Wear.
- **GM page.** Notes only the GM can see, clearing the dice log, and restoring
  deleted characters.

Edits save field by field and show up for everyone within a couple of seconds.

## How it works

- Static `index.html` + `styles.css` + `app.js`. No build step. Vercel serves
  the repo as-is on every push to `main`.
- Data lives in the Supabase project **beacon** (RJ org, ap-south-1).
  `supabase/schema.sql` is the full schema.
- The browser only holds the public Supabase key. Tables are closed to it. All
  reads and writes go through database functions that check the crew password
  (or the GM password) first.

## Passwords

The passwords aren't stored in this repo. To change them, run this in the
Supabase SQL editor for the beacon project:

```sql
select private.set_secret('entry', 'new-crew-password');
select private.set_secret('gm',    'new-gm-password');
```

The GM password also works as the crew password. Anyone already signed in
with the old password is sent back to the password screen.

## Local preview

```sh
python3 -m http.server 5173
```

Then open http://127.0.0.1:5173. It talks to the live database.
