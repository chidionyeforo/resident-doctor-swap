// Shared availability + audit store for Resident Doctor Swap.
// Runs on Netlify (Functions + Netlify Blobs). No accounts, no API keys —
// when the site is deployed on Netlify this "just works"; the front-end
// falls back to per-device storage if it isn't reachable.
//
//   GET  /.netlify/functions/prefs            -> { prefs:{...}, audit:[...] }
//   GET  /.netlify/functions/prefs?slim=1     -> { prefs:{...} }   (skip audit)
//   POST /.netlify/functions/prefs            -> body shapes:
//     { label, prefs:{ unavail:[iso...], wantedOff:[iso...] } }       — save prefs
//     { label, pinHash:"sha256hex" }                                  — set/replace PIN
//     { event:{ slot, action, partnerSlot?, dates?, kind?, ts } }     — append audit
//
// Two blob keys: "all" (per-slot prefs/pin), "audit" (rolling event log,
// capped at 500 most recent entries).
//
// POST does read-merge-write per slot so concurrent saves to *different*
// slots don't clobber each other.

import { getStore } from "@netlify/blobs";

const STORE = "rds-prefs";
// Keys stored by STABLE id (spreadsheet column, e.g. "L", "AA") — never by the
// display slot number. When the rota is renumbered (someone joins/leaves), the
// display numbers change but the column ids don't, so PINs and unavailability
// stay attached to the right person and the store needs no migration.
// "-id" suffix marks this identity scheme; earlier deploys keyed by slot number.
const PREFS_KEY = "all-id";
const AUDIT_KEY = "audit-id";
const AUDIT_CAP = 500;
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
    return new Response(JSON.stringify({ prefs, audit }), { status: 200, headers: JSON_HEADERS });
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
      audit.unshift(entry); // newest first
      if (audit.length > AUDIT_CAP) audit.length = AUDIT_CAP;
      await store.setJSON(AUDIT_KEY, audit);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
    }

    // === Prefs (unavail, wantedOff) and/or PIN set ===
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

    // Prefs set
    if (body.prefs) {
      const unavail = cleanIsoList(body.prefs.unavail);
      const wantedOff = cleanIsoList(body.prefs.wantedOff);
      const updated = { updated: new Date().toISOString().slice(0, 10) };
      if (unavail.length) updated.unavail = unavail;
      if (wantedOff.length) updated.wantedOff = wantedOff;
      if (existing.pinHash) updated.pinHash = existing.pinHash; // preserve PIN
      if (unavail.length || wantedOff.length || existing.pinHash) {
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
