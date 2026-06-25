# Resident Doctor Swap

A small static web app that reads your SpR on-call rota and suggests the **best person to ask for a shift swap** when you want a day (or block of days) off.

Everything runs in the browser. There's no server, no database, no login — the rota is baked into `data.js` as a JavaScript object, so it works on Netlify, GitHub Pages, or even by opening `index.html` straight off your machine.

---

## What it does

1. You pick your rota slot (your number, e.g. `2b`).
2. It shows your swappable **on-call** shifts only — `E`, `Day`, `N1`, `N2`, `WARD`. (`NWD` normal working days are never swapped.)
3. You tap the shift(s) you want off.
4. (Optional) You add any dates you *cannot* take in return.
5. It ranks colleagues who could take your shift, giving you a **reciprocal swap** (they take yours, you take an equivalent one of theirs) wherever possible.

The ranking prefers swaps that are **like-for-like and rest-neutral**: same shift type, and the same number of days off before and after, so neither person's rest pattern gets worse.

---

## The rules it enforces

These come straight from how the rota works, and are all encoded in the matching engine:

- **Swappable shifts:** `E`, `Day`, `N1`, `N2`, `WARD`. `NWD` is never swapped.
- **Nights are interchangeable:** `N1` and `N2` are both nights, so they swap freely with each other.
- **Day and WARD swap like-for-like:** `Day↔Day` and `WARD↔WARD` only, so a swap never lands on top of someone's own-specialty NWD. (`WARD` only occurs on weekends/bank holidays.)
- **E swaps with E.**
- **LTFT days are sacred:** a person is never offered a swap that would place them on a shift or NWD on their less-than-full-time non-working day.
- **Black-outlined cells are protected:** these are days off people are entitled to. Nobody is ever suggested to swap *into* a black-outlined date.
- **Never more than 4 nights in a row:** a swap that would push someone to 5+ consecutive `N1`/`N2` nights is rejected.
- **Rest days after on-call are protected:** the app won't suggest a swap that eats the OFF day someone gets after a run of on-calls.
- **Split slots (a/b) only count when active:** e.g. `2a` and `2b` share a rota line but cover different parts of the year. A person is only offered as a candidate inside their active window (i.e. once their cells are populated).
- **Days off** = cells labelled `OFF` or left blank-grey.

A candidate who *could* cover your shift but for whom no clean reciprocal swap exists is still shown, lower down, as a **cover-only** option. Anyone ineligible (LTFT clash, blocked day, already on-call, 4-night ceiling, inactive) is listed under "why others weren't suggested" so you can see the reasoning.

---

## Deploying it (GitHub + Netlify)

Same flow you've used before:

1. **Make a new GitHub repo**, e.g. `resident-doctor-swap`.
2. **Upload these files** to the repo root (drag-and-drop in the GitHub web UI is fine):
   - `index.html`
   - `app.js`
   - `data.js`
   - `netlify.toml` (optional but included)
3. **In Netlify:** *Add new site → Import an existing project → pick the repo.* No build command is needed — it's a static site. Publish directory is the repo root (`.`), which `netlify.toml` already sets.
4. **Rename the site** under *Site configuration → Change site name* to something memorable like `resident-doctor-swap`, giving you `https://resident-doctor-swap.netlify.app`.

That's it. To share it, just send people the URL — they pick their number and go.

---

## Updating the rota when it changes

The rota is frozen into `data.js`. When the rota team issues a new version, send me the new `.xlsx` and I'll regenerate `data.js` for you — drop the new file into the repo (replacing the old `data.js`), and Netlify redeploys automatically. Nothing else needs to change.

---

## Assumptions & things to confirm

A few judgement calls were made while reading the spreadsheet. Please sanity-check these against reality:

- **Slot `22` / `AC` column (flagged):** column `AB` is clearly slot `22`. The adjacent column `AC` overlaps with it in time rather than being a clean a/b hand-over, so it's been labelled **`22b`** provisionally. **Please confirm** whether `AC` is genuinely a second person in slot 22, or something else — if it's wrong, tell me and I'll relabel.
- **Confirmed split pairs:** `2a/2b`, `12a/12b`, `19a/19b`, `23a/23b` were detected from complementary active date-ranges within the same department.
- **Excluded from candidates:** the `ActingUp` column and the NWD-only slots (e.g. 28, 30) hold no on-calls, so they're never offered as swap partners. If any of these *should* be able to pick up on-calls, let me know.
- **OFF vs. rest-day:** a plain `OFF`/blank-grey day is treated as available-to-swap-into with a soft warning (you're choosing to give up a day off). An OFF that is the protected rest day *after* an on-call block is treated as a hard block. Shout if you'd rather treat all OFF days the same.
- **Date range:** the dataset covers 2026-08-05 → 2027-02-02 (the populated rows). Anything outside that is ignored, as you asked.

---

## How to test it

Once it's live, try the scenario you mentioned — pick `2b`, select a night shift, and check it suggests a sensible night-shift partner with matching rest. Then try a `Day` and a `WARD` shift to confirm it only ever offers like-for-like. If any suggestion looks wrong (offers someone who shouldn't be available, or misses an obvious partner), tell me the slot + date and I'll adjust the logic.
