# Resident Doctor Swap

**Version 1.1.0** · Rota period 5 Aug 2026 – 2 Feb 2027

A small static web app that reads your SpR on-call rota and suggests the **best person to ask for a shift swap** when you want a day (or block of days) off.

Everything runs in the browser. There's no server, no database, no login — the rota is baked into `data.js` as a JavaScript object, so it works on Netlify, GitHub Pages, or even by opening `index.html` straight off your machine.

The version number appears in the footer of the app itself so anyone using it can confirm what they're on.

## Changelog

- **v1.1.0** — Mutual swap matching (shared "looking" list, opening banner, mutual-match ribbons). Multi-mode calendar picker for unavailable dates (tap individual days or tap a range). Confirmed weekends/BH don't travel as rest days; confirmed LTFT days are never swapped onto. Version visible in footer.
- **v1.0.0** — Initial release. Like-for-like matching with rest days travelling. Shared unavailability store. Three-way swap fallback. Off-rota period detection (≥28-day gaps). Email drafting for both partner and rota team. Help modal in-app.

---

## What it does

1. Pick your rota slot (your number).
2. Flag any dates you can't take a swap onto. These save to a shared store so colleagues see them too.
3. Tap the shift(s) you want off.
4. Get a ranked list of colleagues who can swap with you. If no direct two-way swap is possible, three-way swaps are offered as a fallback.
5. Draft the "ask them" email or the "rota-team" email straight from the result card, edit if you want, and send.

The match engine handles like-for-like classes (Day/Night/Ward/E), keeps rest days travelling with each shift, respects LTFT and protected days, never pushes anyone past four nights in a row, and skips people who are structurally off the on-call rota for that period (long runs of NWD with no on-calls).

## Mutual swap matching

When you click "Find a swap", your selected dates get added to a shared "looking" list. If any colleague is currently looking for one of your shifts, you'll see a banner at the top of the app the next time you open it — tap it to swap straight away.

In results, mutual matches (both of you are looking for compatible shifts) get a coral "Mutual swap" ribbon and float to the top. One-direction matches ("they've also flagged this date") get a softer treatment but still rank above ordinary swaps. You can stop advertising at any time by hitting "Stop looking" in step 2.

---

## Deploying it (GitHub + Netlify)

Same flow as before:

1. **Make a new GitHub repo**, e.g. `resident-doctor-swap`.
2. **Upload everything** to the repo, keeping the folder structure:
   - `index.html`, `app.js`, `data.js` — the app
   - `netlify.toml`, `package.json` — config
   - `netlify/functions/prefs.mjs` — the shared availability store
   - `README.md`
3. **In Netlify:** *Add new site → Import an existing project → pick the repo.* No build command is needed for the site itself; Netlify will spot the function, install its one dependency, and wire up storage automatically.
4. **Rename the site** under *Site configuration → Change site name* to something memorable like `resident-doctor-swap`, giving you `https://resident-doctor-swap.netlify.app`.

To share it with the team, just send the URL — they pick their slot and use it.

---

## The shared availability store

When people flag dates they can't work, those flags need to be visible to everyone — so they live in a small shared store, not just on one phone.

- On Netlify, this runs through the included function (`netlify/functions/prefs.mjs`) backed by **Netlify Blobs**. No accounts beyond your Netlify one, no database to set up, no API keys.
- If the store ever isn't reachable (for example if you open `index.html` straight off your computer), the app falls back to saving preferences on that device only and tells the user so. The swap finder still works either way.
- The data is slot numbers and dates only — no names, nothing personally identifying.

---

## Updating the rota when it changes

The rota is frozen into `data.js`. When the rota team issues a new version, send me the new `.xlsx` and I'll regenerate `data.js` for you. Drop the new file into the repo (replacing the old `data.js`), and Netlify redeploys automatically. Nothing else needs to change.

---

## Notes on detection rules

A few things the engine handles automatically that are worth knowing:

- **Off-rota periods**: if someone has a long stretch (≥ 4 weeks) with no on-calls in their column, they're treated as not on the on-call rota during that period and aren't suggested for swaps until their on-calls resume. This catches people on day-team rotations or other non-on-call blocks.
- **Split slots (a/b)**: `2a/2b`, `12a/12b`, `19a/19b`, `22a/22b`, `23a/23b` are detected as split rotations within the same line, and each half only counts inside its active dates.
- **Excluded from candidates**: the ActingUp column and NWD-only slots hold no on-calls, so they're never offered as swap partners.

If anything looks wrong (someone suggested who shouldn't be, or missing from suggestions when they should be), tell me the slot and date and I'll tune the logic.
