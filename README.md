# Resident Doctor Swap

**Version 2.0.0** · Rota period 05 Aug 2026 – 02 Feb 2027

A small static web app that reads your SpR on-call rota and suggests the **best person to ask for a shift swap** when you want a day (or block of days) off.

Everything runs in the browser. There's no server, no database, no login for read access — the rota is baked into `data.js` as a JavaScript object, so it works on Netlify, GitHub Pages, or even by opening `index.html` straight off your machine. PIN-based login (per slot) authenticates the audit trail.

The version number appears in the footer of the app itself so anyone using it can confirm what they're on.

## Changelog

- **v2.0.0** — **Feedback tool**: a footer link always available to send bugs/suggestions/comments straight to the admin dashboard. **Star rating flow**: after 5 searches, a one-time 1-5 star prompt appears; below 4 stars invites a comment. **Admin dashboard**, now gated behind a separate shared admin PIN: audit trail, roster record (slot/grade/specialty, survives renumbering), feedback & ratings list, unavailability store (live view of who's flagged what), and success metrics (swaps proposed vs confirmed-in-rota, comparing against a snapshot taken at each rota refresh, plus a manual baseline field for last year's raw request count). **Rota refreshed** from an updated spreadsheet — see notes below on the identity-matching approach used. **Store reset** for a clean launch (see below).

- **v1.9.0** — Weekend **day and ward shifts now count as the same type** for swaps (a weekend day-for-ward is a normal like-for-like); only a night traded for a daytime shift is a genuine cross-type. **Removed rest-day notifications** throughout (everyone knows their own rest rules). **All dates now dd/mm/yyyy** (UK numeric) everywhere — cards, emails, calendar, admin. **Working-pattern preference:** two full-timers, or two LTFT people who share an LTFT day, rank above a full-timer/LTFT pairing (still allowed, just less tidy). **Copy-email button fixed** — copies the actual email text reliably, no longer a link. **Roster record** added to admin: a dated snapshot of every slot's grade/specialty keyed to its permanent spreadsheet column, so there's always a note of who held which slot when the rota changes. **Removed the night-before-LTFT block** (the live rota shows it's worked in practice).

- **v1.8.0** — **Combined-return swaps:** a block can now be swapped for two smaller blocks that add up to the same shift count (e.g. 3 nights for 2 nights + 1 evening/ward), so someone stuck with an awkward block has more routes to a swap. Never leaves anyone doing a lone single night; every rest and safety rule still applies; ranked as a lower-preference option. **Removed the night-before-LTFT rule** — the live rota shows this is worked in practice, so it no longer blocks swaps. **Removed the "less preferable" wording** on cross-type swaps (the badge already makes it clear).

- **v1.7.0** — **Cross-type swaps** as an explicit last-resort option. When you're set on getting dates off and no like-for-like partner exists, the app will now offer swaps into a different shift type (for example, weekend nights for weekend days). They appear in a collapsed "Cross-type swaps — less preferable" section below every like-for-like and three-way option, each carrying a "Cross-type" badge and a plain warning. Equal shift counts and every rest/safety rule still apply; only the like-for-like requirement is relaxed. Cross-type swaps never rank above like-for-like and are never treated as mutual matches. Three-way swaps remain strictly like-for-like.

- **v1.6.0** — **Stable identity: the store now keys on spreadsheet column, not slot number.** When the rota is renumbered (someone joins or leaves), display numbers change but each person's column id is permanent, so PINs and unavailability stay attached to the right person with zero store migration. **Non-on-call slots removed entirely** (ActingUp and any column with no on-call shifts are hidden — never in the picker, never suggested). **Slot numbers cleaned up** to a gap-free sequence in column order. **Unequal-length direct swaps are now hard-blocked** (previously warned) — every swap, direct or three-way, moves an equal number of shifts. "Start again" renamed to "Back".

- **v1.5.0** — **Slot 6 removed and all higher slots renumbered down by one** (7→6 … 34→33, split slots 12a/b→11a/b, 19a/b→18a/b, 22a/b→21a/b, 23a/b→22a/b; 1–5 and ActingUp unchanged). Shared-store and device keys bumped to v2 so old-numbering data can't attach to the wrong person — everyone re-enters their PIN and unavailable dates once. **Three-way swaps now move equal shift counts** on every leg (hard rule) so nobody's on-call total changes. **Unequal-length direct swaps** are warned ("your on-call totals would change, which unbalances the rota") and ranked to the bottom. **Night-before-LTFT rule:** a night shift finishing 09:30 next morning can never be placed the day before someone's LTFT day (a day/E/ward shift on that date remains fine).

- **v1.4.0** — **Back-to-back weekend avoidance via three-way swaps.** When every available direct swap would put someone on consecutive weekends, the engine now runs the three-way search and offers only chains where nobody works back-to-back weekends. These are shown first, above the warned direct swaps, with a note explaining why. Works in both single-block and per-block views.

- **v1.3.3** — Back button: "← Choose a different slot" appears in Step 1 once a slot is picked, and a floating "↺ Start again" pill appears bottom-left once you've scrolled into the results. Either resets the whole flow and returns to the slot picker.

- **v1.3.2** — **Copy button fixed:** now copies the full email text with a reliable fallback for browsers where the clipboard API silently fails (previously nothing was copied and the last clipboard item — often a link — got pasted instead). **Email templates rewritten:** no slot numbers, "(name)" placeholders for the partner and the sender's sign-off, rest-days line removed. Rota-team email now reads "Please could you action the following on-call swap that (name) and I have agreed to…".

- **v1.3.1** — **Cross-device preference sync fixed.** Blob reads now use strong consistency (previously a laptop could read stale data after a phone saved). Frontend tolerates both backend response shapes, and prefs saved while the backend was unreachable are queued and re-uploaded automatically on the next successful connection instead of being lost. **Phone calendar fixed:** rapid date taps no longer trigger the phone's double-tap zoom (which made numbers jump off-screen); calendar cells hard-constrained against overflow; tightened layouts at ≤480px and ≤360px. Verified zero horizontal overflow at 390/360/320px widths.
- **v1.3.0** — **Merged-schedule validation (major safety layer).** Every proposed swap validates the person's whole resulting schedule. Hard rules: nights never butt against other on-calls (rest day before, 46h after); weekend ward blocks need 2 clear days after, a clear day before, and a rest day 2 days before (1 day before if LTFT); max 4 nights. Soft rules (warned, ranked lower): back-to-back on-calls, back-to-back weekends, same-week proximity. Applies to direct, three-way, and cover-only suggestions.
- **v1.2.1** — 48-hour post-nights rule. Calendar cell alignment. Padded UK dates. Removed noisy warnings and "Why others" tab.
- **v1.2.0** — Per-block independent matching. Past shifts hidden. Shift-class filters. PIN login + audit trail. Admin mode (`?admin=1`).
- **v1.1.0** — Mutual swap matching. Multi-mode calendar picker.
- **v1.0.0** — Initial release.

## Deploying this update

Replace `index.html`, `app.js`, `package.json`, `netlify/functions/prefs.mjs`, and `README.md` in the repo. **The `netlify/functions/prefs.mjs` update is essential this time** — it carries the strong-consistency fix that makes preferences appear correctly across devices. After Netlify redeploys, do a hard refresh (or just reopen) on each device once.

---

## What it does

1. Pick your rota slot (your number).
2. Set/enter your 4-digit PIN. First time: pick a PIN you'll remember. After that: enter it once per device.
3. Flag dates you can't take a swap onto in the calendar. Saved to a shared store.
4. Filter your shifts by class (Nights/Days/Ward/E) and tap any to mark for swap.
5. Get ranked colleagues for each block independently. If no direct swap, three-way as a fallback.
6. Draft the "ask them" or "rota-team" email straight from the result card.

The match engine handles like-for-like classes (Day/Night/Ward/E), keeps rest days travelling with each shift, respects LTFT and protected days, never pushes anyone past four nights in a row, skips people who are structurally off the on-call rota, and never claims weekends or bank holidays as travelling rest (they were off anyway).

## Mutual swap matching

When you click "Find a swap", your selected dates are added to a shared "looking" list. If any colleague is currently looking for one of your shifts, you'll see a coral banner at the top of the app the next time you open it — tap it to swap straight away. Mutual matches in the results carry a "Mutual swap" ribbon and float to the top. Hit "Stop looking" in step 2 to clear your advertised intent.

## PIN-based login + audit trail

Each slot has its own 4-digit PIN. First time you pick your slot, the app asks you to set it (twice, to confirm). Subsequent visits: enter the PIN once per device. The PIN is stored as a salted SHA-256 hash (`"rds:" + slot + ":" + pin`) — the rota team never sees the actual digits, but can confirm the audit trail is genuine.

Every login, every published wanted-off, every drafted email is logged with timestamp, slot, partner (if applicable) and dates. The most recent 500 events are kept in the shared store.

A "Browse only" option lets people decline the PIN if they just want to look. Without a verified PIN, actions still work but the audit log records them as unverified.

## Admin mode

Visit `https://your-site.netlify.app/?admin=1` to enable admin mode. Adds a dark banner at the top of the app with:
- Days until rota ends (with prompts when ≤28 days away)
- Count of verified slots
- Count of active swappers (people who've drafted at least one email)
- Total events in the audit log
- "View audit log" button opening a modal with the 200 most recent events

The flag is just a URL parameter — share the link with whoever is admin, regular users don't need to know about it.

---

## Deploying it (GitHub + Netlify)

Same flow as before:

1. **Make a new GitHub repo**, e.g. `resident-doctor-swap`.
2. **Upload everything** to the repo, keeping the folder structure:
   - `index.html`, `app.js`, `data.js` — the app
   - `netlify.toml`, `package.json` — config
   - `netlify/functions/prefs.mjs` — the shared availability + audit store
   - `README.md`
3. **In Netlify:** *Add new site → Import an existing project → pick the repo.* No build command is needed for the site itself; Netlify auto-installs the function's dependency and wires up storage.
4. **Rename the site** under *Site configuration → Change site name* to something memorable like `resident-doctor-swap`, giving you `https://resident-doctor-swap.netlify.app`.

To share it with the team, just send the URL — they pick their slot, set a PIN, and use it.

---

## The shared store

When people flag dates they can't work, those flags need to be visible to everyone. Same for PINs and the audit log.

- On Netlify, this runs through `netlify/functions/prefs.mjs` backed by **Netlify Blobs**. No accounts beyond your Netlify one, no database to set up, no API keys.
- If the store ever isn't reachable, the app falls back to per-device storage and tells the user so.
- The data is slot numbers, dates, hashed PINs, and event timestamps. No names, nothing personally identifying.

---

## Updating the rota when it changes

The rota is frozen into `data.js`. When the rota team issues a new version, send me the new `.xlsx` and I'll regenerate `data.js` for you. Drop the new file into the repo (replacing the old `data.js`), and Netlify redeploys automatically. The prefs/audit blob persists, so users don't lose their PINs or settings.

---

## Notes on detection rules

A few things the engine handles automatically that are worth knowing:

- **Off-rota periods**: if someone has a long stretch (≥ 4 weeks) with no on-calls, they're treated as not on the on-call rota during that period.
- **Past shifts**: shifts where the last date is in the past are hidden from Step 2.
- **Split slots (a/b)**: `2a/2b`, `12a/12b`, `19a/19b`, `22a/22b`, `23a/23b` are detected and each half only counts inside its active dates.
- **Multi-block selection**: when you pick two separate blocks (e.g. a Day shift AND a Night block on a different week), each block gets its own ranked partner list — they don't have to be the same person.
- **Weekends/BH**: never claimed as travelling rest. They're off anyway.

If anything looks wrong, tell me the slot and date and I'll tune the logic.

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


## How rota updates preserve identity

When the rota changes, the spreadsheet's own column letters can shift — for example, deleting a column (someone leaving) shifts every column to its right by one letter. Since PINs and unavailability are keyed to the spreadsheet column, a naive re-parse would silently reassign people's stored data to the wrong slot.

To avoid this, each rota refresh matches people between the old and new spreadsheet by their actual on-call pattern (grade, specialty, and which specific dates they're on E/Day/Night/Ward), not by column position. A continuing person keeps their original stable id — and therefore their PIN and unavailability — regardless of where their column physically sits in the new file. Only genuinely new starters get a freshly minted id.

One limitation worth knowing: protected/blocked-day formatting (black-outlined cells) can't be read from the spreadsheet file itself — Excel's border styling doesn't survive into the parsing library. Protected days are carried forward automatically for any date that already existed in the previous version; genuinely new dates need a manual top-up, which the admin dashboard's roster and unavailability views are designed to support.
