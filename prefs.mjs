// Shared availability + audit + feedback store for Resident Doctor Swap.
// Runs on Netlify (Functions + Netlify Blobs). No accounts, no API keys —
// when the site is deployed on Netlify this "just works"; the front-end
// falls back to per-device storage if it isn't reachable.
//
//   GET  /.netlify/functions/prefs           -> { prefs, audit, feedback, meta }
//   GET  /.netlify/functions/prefs?slim=1    -> { prefs }   (skip everything else)
//   POST /.netlify/functions/prefs           -> body shapes:
//     { label, prefs:{ unavail, wantedOff, searchCount, ratedPromptShown,
//                        ratingSnoozeUntil } }              — save prefs
//     { label, pinHash }                                    — set/replace slot PIN
//     { event:{ slot, action, partnerSlot?, dates?, kind?, trade? } } — audit event
//     { feedback:{ slot?, slotLabel?, type, stars?, text? } }        — feedback/rating
//     { adminPinHash }                                       — set/replace admin PIN
//     { meta:{ baselineLastYear? } }                          — small admin config
//
// This is attribution-grade security, not a real auth boundary — same posture
// as the rest of the app: PINs identify who did what for the audit trail, they
// don't gate the network endpoint itself.
//
// Blob keys: "all-id" (per-slot prefs/pin), "audit-id" (rolling event log, capped
// at 500), "feedback-id" (rolling feedback/rating log, capped at 1000), "meta-id"
// (admin PIN hash + small config, single small object).
//
// POST does read-merge-write per key so concurrent saves to different slots
// don't clobber each other.

import { getStore } from "@netlify/blobs";

const STORE = "rds-prefs";
// Keys stored by STABLE id (spreadsheet column, e.g. "L", "AA") — never by the
// display slot number. When the rota is renumbered (someone joins/leaves), the
// display numbers change but the column ids don't, so PINs and unavailability
// stay attached to the right person and the store needs no migration.
const PREFS_KEY = "all-launch";
const AUDIT_KEY = "audit-launch";
const FEEDBACK_KEY = "feedback-launch";
const META_KEY = "meta-launch";
const AUDIT_CAP = 500;
const FEEDBACK_CAP = 1000;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function cleanIsoList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)).slice(0, 400);
}
function cleanLabel(s) {
  return typeof s === "string" && /^[A-Za-z0-9]{1,8}$/.test(s);
}
function cleanHash(s) {
  return typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
}
function cleanAction(s) {
  return typeof s === "string" && /^[a-z_-]{1,32}$/.test(s);
}
function cleanInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}
function cleanText(s, maxLen) {
  if (typeof s !== "string") return "";
  return s.slice(0, maxLen).trim();
}
function cleanFeedbackType(s) {
  return typeof s === "string" && /^(bug|suggestion|other|rating)$/.test(s);
}
// Trade: array of legs describing a proposed swap cycle, used later to detect
// whether it was actually confirmed in a subsequent rota upload.
// [{ slot, dates:[iso...] }, ...] — 2 legs for direct/cross/combined, 3 for chain.
function cleanTrade(arr) {
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > 4) return undefined;
  const out = [];
  for (const leg of arr) {
    if (!leg || !cleanLabel(leg.slot)) return undefined;
    const dates = cleanIsoList(leg.dates);
    if (!dates.length) return undefined;
    out.push({ slot: leg.slot, dates });
  }
  return out;
}

export default async (request) => {
  let store;
  try {
    // Strong consistency: without this, reads served from a different edge
    // node (i.e. the user's other device) can lag behind writes and make
    // saved preferences appear missing across devices.
    store = getStore({ name: STORE, consistency: "strong" });
  } catch (e) {
    return new Response(JSON.stringify({ error: "blob store unavailable" }), { status: 503, headers: JSON_HEADERS });
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const slim = url.searchParams.get("slim") === "1";
    const prefs = (await store.get(PREFS_KEY, { type: "json" })) || {};
    if (slim) return new Response(JSON.stringify({ prefs }), { status: 200, headers: JSON_HEADERS });
    const audit = (await store.get(AUDIT_KEY, { type: "json" })) || [];
    const feedback = (await store.get(FEEDBACK_KEY, { type: "json" })) || [];
    const meta = (await store.get(META_KEY, { type: "json" })) || {};
    return new Response(JSON.stringify({ prefs, audit, feedback, meta }), { status: 200, headers: JSON_HEADERS });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body) return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: JSON_HEADERS });

    // === Audit event ===
    if (body.event) {
      const e = body.event;
      if (!cleanLabel(e.slot) || !cleanAction(e.action)) {
        return new Response(JSON.stringify({ error: "invalid event" }), { status: 400, headers: JSON_HEADERS });
      }
      const audit = (await store.get(AUDIT_KEY, { type: "json" })) || [];
      const entry = {
        slot: e.slot,
        action: e.action,
        ts: new Date().toISOString()
      };
      if (cleanLabel(e.partnerSlot)) entry.partnerSlot = e.partnerSlot;
      if (Array.isArray(e.dates)) entry.dates = cleanIsoList(e.dates).slice(0, 20);
      if (typeof e.kind === "string" && /^[a-z]{1,16}$/.test(e.kind)) entry.kind = e.kind;
      const trade = cleanTrade(e.trade);
      if (trade) entry.trade = trade;
      audit.unshift(entry); // newest first
      if (audit.length > AUDIT_CAP) audit.length = AUDIT_CAP;
      await store.setJSON(AUDIT_KEY, audit);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    }

    // === Feedback / rating ===
    if (body.feedback) {
      const f = body.feedback;
      if (!cleanFeedbackType(f.type)) {
        return new Response(JSON.stringify({ error: "invalid feedback type" }), { status: 400, headers: JSON_HEADERS });
      }
      const feedback = (await store.get(FEEDBACK_KEY, { type: "json" })) || [];
      const entry = { type: f.type, ts: new Date().toISOString() };
      if (cleanLabel(f.slot)) entry.slot = f.slot;
      if (typeof f.slotLabel === "string") entry.slotLabel = cleanText(f.slotLabel, 8);
      const stars = cleanInt(f.stars, 1, 5);
      if (stars != null) entry.stars = stars;
      const text = cleanText(f.text, 1000);
      if (text) entry.text = text;
      feedback.unshift(entry);
      if (feedback.length > FEEDBACK_CAP) feedback.length = FEEDBACK_CAP;
      await store.setJSON(FEEDBACK_KEY, feedback);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    }

    // === Admin PIN set/change ===
    if (body.adminPinHash !== undefined) {
      if (!cleanHash(body.adminPinHash)) {
        return new Response(JSON.stringify({ error: "invalid adminPinHash" }), { status: 400, headers: JSON_HEADERS });
      }
      const meta = (await store.get(META_KEY, { type: "json" })) || {};
      meta.adminPinHash = body.adminPinHash;
      meta.updated = new Date().toISOString().slice(0, 10);
      await store.setJSON(META_KEY, meta);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    }

    // === Small admin config (baseline comparison number, etc.) ===
    if (body.meta) {
      const meta = (await store.get(META_KEY, { type: "json" })) || {};
      const baseline = cleanInt(body.meta.baselineLastYear, 0, 1000000);
      if (baseline != null) meta.baselineLastYear = baseline;
      if (typeof body.meta.baselineNote === "string") meta.baselineNote = cleanText(body.meta.baselineNote, 200);
      meta.updated = new Date().toISOString().slice(0, 10);
      await store.setJSON(META_KEY, meta);
      return new Response(JSON.stringify({ ok: true, meta }), { status: 200, headers: JSON_HEADERS });
    }

    // === Prefs (unavail, wantedOff, usage counters) and/or PIN set ===
    const label = body.label;
    if (!cleanLabel(label)) {
      return new Response(JSON.stringify({ error: "missing/invalid label" }), { status: 400, headers: JSON_HEADERS });
    }
    const all = (await store.get(PREFS_KEY, { type: "json" })) || {};
    const existing = all[label] || {};

    // PIN set or change
    if (body.pinHash !== undefined) {
      if (!cleanHash(body.pinHash)) {
        return new Response(JSON.stringify({ error: "invalid pinHash" }), { status: 400, headers: JSON_HEADERS });
      }
      existing.pinHash = body.pinHash;
      existing.updated = new Date().toISOString().slice(0, 10);
      all[label] = existing;
      await store.setJSON(PREFS_KEY, all);
      return new Response(JSON.stringify({ ok: true, label, pin: "set" }), { status: 200, headers: JSON_HEADERS });
    }

    // Prefs set (unavail/wantedOff arrays + small usage-tracking fields)
    if (body.prefs) {
      const unavail = cleanIsoList(body.prefs.unavail);
      const wantedOff = cleanIsoList(body.prefs.wantedOff);
      const searchCount = cleanInt(body.prefs.searchCount, 0, 1000000);
      const ratedPromptShown = body.prefs.ratedPromptShown === true;
      const ratingSnoozeUntil = cleanInt(body.prefs.ratingSnoozeUntil, 0, 1000000);

      const updated = { updated: new Date().toISOString().slice(0, 10) };
      if (unavail.length) updated.unavail = unavail;
      if (wantedOff.length) updated.wantedOff = wantedOff;
      if (existing.pinHash) updated.pinHash = existing.pinHash; // preserve PIN
      // Usage counters persist even if unavail/wantedOff are both empty —
      // they're not "does this person have active flags", they're a running tally.
      if (searchCount != null) updated.searchCount = searchCount;
      else if (existing.searchCount != null) updated.searchCount = existing.searchCount;
      if (ratedPromptShown) updated.ratedPromptShown = true;
      else if (existing.ratedPromptShown) updated.ratedPromptShown = true;
      if (ratingSnoozeUntil != null) updated.ratingSnoozeUntil = ratingSnoozeUntil;
      else if (existing.ratingSnoozeUntil != null) updated.ratingSnoozeUntil = existing.ratingSnoozeUntil;

      const hasAnyContent = unavail.length || wantedOff.length || existing.pinHash ||
        updated.searchCount || updated.ratedPromptShown || updated.ratingSnoozeUntil;
      if (hasAnyContent) {
        all[label] = updated;
      } else {
        delete all[label];
      }
      await store.setJSON(PREFS_KEY, all);
      return new Response(JSON.stringify({ ok: true, label }), { status: 200, headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ error: "nothing to save" }), { status: 400, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_HEADERS });
};

export const config = { path: "/.netlify/functions/prefs" };
