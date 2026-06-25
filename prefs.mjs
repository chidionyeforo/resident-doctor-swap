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
    // sanitise: keep only an array of ISO date strings
    const raw = (body.prefs && Array.isArray(body.prefs.unavail)) ? body.prefs.unavail : [];
    const unavail = raw
      .filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s))
      .slice(0, 400);

    const all = (await store.get(KEY, { type: "json" })) || {};
    if (unavail.length) {
      all[label] = { unavail, updated: new Date().toISOString().slice(0, 10) };
    } else {
      delete all[label]; // empty list = clear this person's flags
    }
    await store.setJSON(KEY, all);
    return new Response(JSON.stringify({ ok: true, label, count: unavail.length }), { status: 200, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_HEADERS });
};

export const config = { path: "/.netlify/functions/prefs" };
