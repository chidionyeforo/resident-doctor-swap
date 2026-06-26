// Shared availability store for Resident Doctor Swap.
// Runs on Netlify (Functions + Netlify Blobs). No accounts, no API keys —
// when the site is deployed on Netlify this "just works"; the front-end
// falls back to per-device storage if it isn't reachable.
//
//   GET  /.netlify/functions/prefs           -> { "<slot>": { unavail:[iso...], updated }, ... }
//   POST /.netlify/functions/prefs  body:    { label:"<slot>", prefs:{ unavail:[iso...] } }
//
// All prefs live in a single JSON blob ("all") under store "rds-prefs".
// POST does read-merge-write on one slot so concurrent saves to *different*
// slots don't clobber each other.

import { getStore } from "@netlify/blobs";

const STORE = "rds-prefs";
const KEY = "all";
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export default async (request) => {
  let store;
  try {
    store = getStore(STORE);
  } catch (e) {
    return new Response(JSON.stringify({ error: "blob store unavailable" }), { status: 503, headers: JSON_HEADERS });
  }

  if (request.method === "GET") {
    const all = (await store.get(KEY, { type: "json" })) || {};
    return new Response(JSON.stringify(all), { status: 200, headers: JSON_HEADERS });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    const label = body && body.label;
    if (!label || typeof label !== "string") {
      return new Response(JSON.stringify({ error: "missing label" }), { status: 400, headers: JSON_HEADERS });
    }
    // sanitise: keep ISO date strings only, capped per list
    function cleanIsoList(arr) {
      if (!Array.isArray(arr)) return [];
      return arr.filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)).slice(0, 400);
    }
    const unavail = cleanIsoList(body.prefs && body.prefs.unavail);
    const wantedOff = cleanIsoList(body.prefs && body.prefs.wantedOff);

    const all = (await store.get(KEY, { type: "json" })) || {};
    if (unavail.length || wantedOff.length) {
      const entry = { updated: new Date().toISOString().slice(0, 10) };
      if (unavail.length) entry.unavail = unavail;
      if (wantedOff.length) entry.wantedOff = wantedOff;
      all[label] = entry;
    } else {
      delete all[label]; // both empty = clear this person entirely
    }
    await store.setJSON(KEY, all);
    return new Response(JSON.stringify({ ok: true, label, unavailCount: unavail.length, wantedCount: wantedOff.length }), { status: 200, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_HEADERS });
};

export const config = { path: "/.netlify/functions/prefs" };
