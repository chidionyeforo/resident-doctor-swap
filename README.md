# Resident Doctor Swap

A small static web app that reads your SpR on-call rota and suggests the **best person to ask for a shift swap** when you want a day (or block of days) off.

Everything runs in the browser. There's no server, no database, no login — the rota is baked into `data.js` as a JavaScript object, so it works on Netlify, GitHub Pages, or even by opening `index.html` straight off your machine.

---

## What it does

1. You pick your rota slot (your number, e.g. `2b`).
2. (Optional) You flag any dates you **can't** take a swap onto. These are saved for the whole team, so nobody gets offered you on a day you've ruled out.
3. It shows your swappable **on-call** shifts only — `E`, `Day`, `N1`, `N2`, `WARD`. (`NWD` normal working days are never swapped.)
4. You tap the shift(s) you want off.
5. (Optional) You add any further dates you can't take in return.
6. It ranks colleagues who could take your shift, giving you a **reciprocal swap** (they take yours, you take an equivalent one of theirs) wherever possible. If no direct swap exists, it looks for a **three-way swap** as a last resort.

The ranking prefers swaps that are **like-for-like and rest-neutral**: same shift type, and the same days off before and after, so neither person's rest pattern gets worse. On a like-for-like swap the **rest days either side travel with the shift** — if they don't line up, the swap is flagged.

---

## The rules it enforces

These come straight from how the rota works, and are all encoded in the matching engine:

- **Swappable shifts:** `E`, `Day`, `N1`, `N2`, `WARD`. `NWD` is never swapped.
- **Nights are interchangeable:** `N1` and `N2` are both nights, so they swap freely with each other.
- **Day and WARD swap like-for-like:** `Day↔Day` and `WARD↔WARD` only, so a swap never lands on top of someone's own-specialty NWD. (`WARD` only occurs on weekends/bank holidays.)
- **E swaps with E.**
- **Rest days travel with a like-for-like swap.** The protected off days either side of a shift move with it, so a swap never quietly costs someone a rest day. If the two blocks' rest envelopes differ, the swap is shown with a warning rather than hidden.
- **Stored availability is respected.** Anyone can flag dates they can't take. A flagged person is never offered for a swap (direct or three-way) on those dates.
- **Three-way swaps as a last resort.** If nobody can both take your shift *and* hand you an equivalent one back, the tool searches for a closed loop of three people — A takes your shift, you take B's, B takes A's — all like-for-like, all within the rules. These only appear when no direct two-way swap exists, and only for single-block requests.
- **LTFT days are sacred:** a person is never offered a swap that would place them on a shift or NWD on their less-than-full-time non-working day.
- **Black-outlined cells are protected:** these are days off people are entitled to. Nobody is ever suggested to swap *into* a black-outlined date.
- **Never more than 4 nights in a row:** any swap (including each leg of a three-way) that would push someone to 5+ consecutive `N1`/`N2` nights is rejected.
- **Rest days after on-call are protected:** the app won't suggest a swap that eats the OFF day someone gets after a run of on-calls.
- **Split slots (a/b) only count when active:** e.g. `2a` and `2b` share a rota line but cover different parts of the year. A person is only offered as a candidate inside their active window.
- **Days off** = cells labelled `OFF` or left blank-grey.

A candidate who *could* cover your shift but for whom no clean reciprocal swap exists is still shown, lower down, as a **cover-only** option. Anyone ineligible (LTFT clash, blocked day, already on-call, 4-night ceiling, inactive) is listed under "why others weren't suggested" so you can see the reasoning.

---

## Deploying it (GitHub + Netlify)

Same flow you've used before, with a couple of extra files this time:

1. **Make a new GitHub repo**, e.g. `resident-doctor-swap`.
2. **Upload everything** to the repo, keeping the folder structure:
   - `index.html`, `app.js`, `data.js` — the app
   - `netlify.toml`, `package.json` — config
   - `netlify/functions/prefs.mjs` — the shared availability store (keep it in the `netlify/functions/` folder)
   - `README.md`
3. **In Netlify:** *Add new site → Import an existing project → pick the repo.* No build command is needed for the site itself; Netlify will spot the function, install its one dependency automatically, and wire up storage with no extra setup.
4. **Rename the site** under *Site configuration → Change site name* to something memorable like `resident-doctor-swap`, giving you `https://resident-doctor-swap.netlify.app`.

That's it. To share it, just send people the URL — they pick their number and go.

## The shared availability store

When people flag dates they can't work, those flags need to be visible to everyone — so they live in a small shared store, not just on one phone.

- On Netlify, this runs through the included function (`netlify/functions/prefs.mjs`) backed by **Netlify Blobs**. It needs no account beyond your Netlify one, no database to set up, and no API keys. As long as the `netlify/functions/` folder and `package.json` are in the repo, it works automatically once deployed.
- If the store ever isn't reachable (for example if you open `index.html` straight off your computer, or the function isn't deployed), the app quietly falls back to saving preferences **on that device only** and tells the user so. The swap-finding still works either way.
- It's an internal convenience tool: anyone with the link can read and edit the availability flags, the same way anyone with the link can use the swap finder. There's no personal data beyond slot numbers and dates. If you'd prefer it locked down, tell me and I can add a simple shared passcode.

---

## Updating the rota when it changes

The rota is frozen into `data.js`. When the rota team issues a new version, send me the new `.xlsx` and I'll regenerate `data.js` for you — drop the new file into the repo (replacing the old `data.js`), and Netlify redeploys automatically. Nothing else needs to change.

---

## Assumptions & things to confirm

A few judgement calls were made while reading the spreadsheet. Please sanity-check these against reality:

- **Slot `22` / `AC` column:** confirmed — column `AB` is slot `22a` and `AC` is `22b`, the same way as the other split pairs.
- **Confirmed split pairs:** `2a/2b`, `12a/12b`, `19a/19b`, `22a/22b`, `23a/23b` were detected from complementary active date-ranges within the same department.
- **Excluded from candidates:** the `ActingUp` column and the NWD-only slots (e.g. 28, 30) hold no on-calls, so they're never offered as swap partners. If any of these *should* be able to pick up on-calls, let me know.
- **OFF vs. rest-day:** a plain `OFF`/blank-grey day is treated as available-to-swap-into with a soft warning (you're choosing to give up a day off). An OFF that is the protected rest day *after* an on-call block is treated as a hard block. Shout if you'd rather treat all OFF days the same.
- **Date range:** the dataset covers 2026-08-05 → 2027-02-02 (the populated rows). Anything outside that is ignored, as you asked.

---

## How to test it

Once it's live, try the scenario you mentioned — pick `2b`, select a night shift, and check it suggests a sensible night-shift partner with matching rest. Then try a `Day` and a `WARD` shift to confirm it only ever offers like-for-like. If any suggestion looks wrong (offers someone who shouldn't be available, or misses an obvious partner), tell me the slot + date and I'll adjust the logic.
