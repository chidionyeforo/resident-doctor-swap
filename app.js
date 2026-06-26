/* Resident Doctor Swap — matching engine + UI
   Data shipped in window.ROTA_DATA (see data.js).
   Engine is written as pure functions so it can be unit-tested in Node. */

(function (global) {
  "use strict";

  // ---- class / compatibility ---------------------------------------------
  // Swappable on-call shifts and their "class". Same class = swappable.
  // N1 and N2 are both nights, so they share the NIGHT class (interchangeable).
  function shiftClass(v) {
    v = (v || "").toUpperCase();
    if (v === "N1" || v === "N2") return "NIGHT";
    if (v === "DAY") return "DAY";
    if (v === "WARD") return "WARD";
    if (v === "E") return "E";
    return null;
  }
  var CLASS_LABEL = {
    NIGHT: "Night (N1/N2)",
    DAY: "Day (08:00–21:00)",
    WARD: "Ward (weekend/BH 08:00–21:00)",
    E: "Evening support (E)"
  };

  // ---- Engine -------------------------------------------------------------
  // Threshold (days) for treating a no-on-call stretch as "off the on-call rota".
  // Picked from the real data: most candidates have ≤30-day gaps as normal
  // between-block spacing; runs of NWD/OFF/LTFT longer than this almost
  // always mean the person is on a day-team or other non-on-call rotation
  // for that period.
  var OFF_ROTA_GAP_DAYS = 28;

  function Engine(data) {
    this.data = data;
    this.idxByIso = {};
    data.dates.forEach(function (d, i) { this.idxByIso[d.iso] = i; }, this);
    this.staffByLabel = {};
    data.staff.forEach(function (s) { this.staffByLabel[s.label] = s; }, this);
    // Pre-compute "on-call active windows" per candidate: contiguous spans
    // where they're actually on the on-call rota (used to gate candidates
    // when a staff member is structurally off the on-call rota for weeks).
    this._oncallWindows = {};
    this._buildOncallWindows();
  }

  // For each candidate, build a list of [startIdx, endIdx] inclusive ranges
  // representing periods they're on the on-call rota. Long gaps without any
  // OC days split the active window into separate ranges.
  Engine.prototype._buildOncallWindows = function () {
    var self = this;
    this.data.staff.forEach(function (s) {
      if (!s.candidate) { self._oncallWindows[s.label] = []; return; }
      var g = self.data.grid[s.label] || [];
      var ocIdxs = [];
      g.forEach(function (c, i) { if (c.s === "OC") ocIdxs.push(i); });
      if (!ocIdxs.length) { self._oncallWindows[s.label] = []; return; }

      // First and last non-INACTIVE indices define the "on the rota at all" range.
      var actFrom = 0, actTo = g.length - 1;
      while (actFrom < g.length && g[actFrom].s === "INACTIVE") actFrom++;
      while (actTo >= 0 && g[actTo].s === "INACTIVE") actTo--;

      // Build OC-windows: start at first OC, extend to next OC unless gap ≥ threshold,
      // then start a new window. Bracket each window with the surrounding rest envelope
      // so a swap *into* the day right before/after a known on-call sequence is OK.
      var windows = [];
      var winStart = ocIdxs[0];
      for (var k = 1; k < ocIdxs.length; k++) {
        var gap = ocIdxs[k] - ocIdxs[k - 1] - 1;
        if (gap >= OFF_ROTA_GAP_DAYS) {
          windows.push([winStart, ocIdxs[k - 1]]);
          winStart = ocIdxs[k];
        }
      }
      windows.push([winStart, ocIdxs[ocIdxs.length - 1]]);

      // Expand each window outwards by 3 days on either side (within the active
      // range and bounded by neighbouring windows) so OFF/NWD days that are part
      // of the same rota block count as on-rota. Three days handles the typical
      // post-nights rest envelope cleanly.
      windows = windows.map(function (w, idx) {
        var lo = w[0], hi = w[1];
        var loFloor = idx === 0 ? actFrom : windows[idx - 1][1] + 1;
        var hiCeil = idx === windows.length - 1 ? actTo : windows[idx + 1][0] - 1;
        return [Math.max(loFloor, lo - 3), Math.min(hiCeil, hi + 3)];
      });
      self._oncallWindows[s.label] = windows;
    });
  };

  // Is this person actually on the on-call rota on day `idx`?
  // (Outside their on-call window they're treated as INACTIVE for swap purposes.)
  Engine.prototype.isOnOncallRota = function (label, idx) {
    var ws = this._oncallWindows[label]; if (!ws) return false;
    for (var i = 0; i < ws.length; i++) if (idx >= ws[i][0] && idx <= ws[i][1]) return true;
    return false;
  };

  Engine.prototype.cell = function (label, idx) {
    var g = this.data.grid[label];
    if (!g || idx < 0 || idx >= g.length) return { s: "INACTIVE", v: "", b: false };
    return g[idx];
  };

  // On-call shifts a person currently holds, in date order.
  Engine.prototype.oncallShifts = function (label) {
    var g = this.data.grid[label] || [], out = [], self = this;
    g.forEach(function (c, i) {
      if (c.s === "OC") {
        out.push({
          idx: i, iso: self.data.dates[i].iso, dow: self.data.dates[i].dow,
          type: c.v, cls: shiftClass(c.v)
        });
      }
    });
    return out;
  };

  // Group day-indices into consecutive same-class blocks.
  Engine.prototype.groupBlocks = function (label, idxs) {
    var self = this;
    var sorted = idxs.slice().sort(function (a, b) { return a - b; });
    var blocks = [], cur = null;
    sorted.forEach(function (i) {
      var cls = shiftClass(self.cell(label, i).v);
      if (cur && i === cur.end + 1 && cls === cur.cls) {
        cur.end = i; cur.idxs.push(i);
      } else {
        cur = { start: i, end: i, idxs: [i], cls: cls };
        blocks.push(cur);
      }
    });
    blocks.forEach(function (b) { self._annotateRest(label, b); });
    return blocks;
  };

  // Record protected rest days either side, and the explicit OFF-day indices
  // that travel with a like-for-like swap.
  Engine.prototype._annotateRest = function (label, block) {
    var offish = { OFF: 1, LTFT: 1, INACTIVE: 1 };
    var before = 0, i = block.start - 1;
    while (i >= 0 && offish[this.cell(label, i).s]) { before++; i--; }
    var after = 0, j = block.end + 1, n = this.data.dates.length;
    while (j < n && offish[this.cell(label, j).s]) { after++; j++; }
    block.offBefore = before; block.offAfter = after;
    block.len = block.idxs.length;

    var rb = [], k = block.start - 1, CAP = 3;
    while (k >= 0 && this.cell(label, k).s === "OFF" && rb.length < CAP) { rb.unshift(k); k--; }
    var ra = [], m = block.end + 1;
    while (m < n && this.cell(label, m).s === "OFF" && ra.length < CAP) { ra.push(m); m++; }
    block.restBeforeIdxs = rb; block.restAfterIdxs = ra;
  };

  // Night indices a person currently works.
  Engine.prototype._nightSet = function (label) {
    var set = {}, g = this.data.grid[label] || [];
    g.forEach(function (c, i) { if (c.s === "OC" && shiftClass(c.v) === "NIGHT") set[i] = 1; });
    return set;
  };
  function maxRun(setObj) {
    var ks = Object.keys(setObj).map(Number).sort(function (a, b) { return a - b; });
    var best = 0, run = 0, prev = null;
    ks.forEach(function (k) { run = (prev !== null && k === prev + 1) ? run + 1 : 1; prev = k; if (run > best) best = run; });
    return best;
  }
  Engine.prototype._nightRunOk = function (label, removeIdxs, addIdxs) {
    var set = this._nightSet(label);
    (removeIdxs || []).forEach(function (i) { delete set[i]; });
    (addIdxs || []).forEach(function (i) { set[i] = 1; });
    return maxRun(set) <= 4;
  };
  function nightIdxsOf(self, label, block) {
    return block.idxs.filter(function (i) { return shiftClass(self.cell(label, i).v) === "NIGHT"; });
  }

  // Can `label` work a NEW shift on day `idx`? Returns {ok, warn, reason}.
  Engine.prototype.freeToWork = function (label, idx, pref) {
    if (pref && pref[idx]) return { ok: false, reason: "flagged themselves unavailable on this date" };
    if (!this.isOnOncallRota(label, idx)) return { ok: false, reason: "not on the on-call rota during this period" };
    var c = this.cell(label, idx);
    if (c.s === "INACTIVE") return { ok: false, reason: "not on the rota on this date" };
    if (c.b) return { ok: false, reason: "protected (black-outlined) day — must stay off" };
    if (c.s === "LTFT") return { ok: false, reason: "LTFT non-working day" };
    if (c.s === "OC") return { ok: false, reason: "already on-call (" + c.v + ") that day" };
    if (c.s === "OTHER") return { ok: false, reason: "unavailable (" + c.v + ")" };
    if (c.s === "OFF") {
      var prev = this.cell(label, idx - 1);
      if (prev.s === "OC") return { ok: false, reason: "protected rest day after an on-call block" };
      return { ok: true, warn: "currently a day off — taking it uses a rest day" };
    }
    return { ok: true }; // NWD
  };

  function equity(a, b) {
    return Math.abs(a.offBefore - b.offBefore)
         + Math.abs(a.offAfter - b.offAfter)
         + Math.abs(a.len - b.len) * 0.5;
  }
  function restMatches(a, b) {
    return a.restBeforeIdxs.length === b.restBeforeIdxs.length
        && a.restAfterIdxs.length === b.restAfterIdxs.length;
  }

  /* Core search.
     prefs: { label: { unavail:{idx:1}, wantedOff:{idx:1} } } */
  Engine.prototype.findSwaps = function (reqLabel, selIdxs, unavail, prefs) {
    unavail = unavail || {};
    prefs = prefs || {};
    var self = this;
    var sel = {}; selIdxs.forEach(function (i) { sel[i] = 1; });
    var reqBlocks = this.groupBlocks(reqLabel, selIdxs);
    var selNight = {}; selIdxs.forEach(function (i) { if (shiftClass(self.cell(reqLabel, i).v) === "NIGHT") selNight[i] = 1; });
    var myWanted = (prefs[reqLabel] || {}).wantedOff || {};

    var swaps = [], coverOnly = [], ineligible = [];

    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var cl = C.label;
      var cPref = (prefs[cl] || {}).unavail || null;
      var cWanted = (prefs[cl] || {}).wantedOff || null;
      var warnings = [], reasons = [];

      // INCOMING: can C take every selected day?
      var incomingOk = true;
      selIdxs.forEach(function (i) {
        var f = self.freeToWork(cl, i, cPref);
        if (!f.ok) { incomingOk = false; reasons.push("can't take " + self.data.dates[i].iso + ": " + f.reason); }
        else if (f.warn) warnings.push("On " + self.data.dates[i].iso + ", " + f.warn);
      });
      if (incomingOk && Object.keys(selNight).length) {
        var cn = self._nightSet(cl);
        Object.keys(selNight).forEach(function (i) { cn[i] = 1; });
        if (maxRun(cn) > 4) { incomingOk = false; reasons.push("would exceed 4 nights in a row by taking these nights"); }
      }
      if (!incomingOk) { ineligible.push({ label: C.label, reasons: reasons }); return; }

      // RETURN: a compatible shift from C the requester can take
      var cBlocks = self.groupBlocks(cl, self.oncallShifts(cl).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.idxs.every(function (i) { return !sel[i]; }); });
      var assignments = [], allMatched = true;

      reqBlocks.forEach(function (rb) {
        var best = null;
        cBlocks.forEach(function (cb) {
          if (cb.used || cb.cls !== rb.cls) return;
          var rOk = true, rWarn = [];
          cb.idxs.forEach(function (i) {
            if (unavail[i]) { rOk = false; return; }
            var f = self.freeToWork(reqLabel, i);
            if (!f.ok) rOk = false; else if (f.warn) rWarn.push("On " + self.data.dates[i].iso + ", " + f.warn + " (you)");
          });
          if (!rOk) return;
          // Bonus to equity if the requester has flagged THIS exact block as
          // wanted-off — mutual desire on this leg is a near-perfect match.
          var sc = equity(rb, cb);
          var mutualLeg = cb.idxs.some(function (i) { return myWanted[i]; });
          if (mutualLeg) sc -= 100; // dominate ordering
          if (!best || sc < best.sc) best = { cb: cb, sc: sc, rWarn: rWarn, mutualLeg: mutualLeg };
        });
        if (best) { best.cb.used = true; assignments.push({ rb: rb, cb: best.cb, sc: best.sc, rWarn: best.rWarn, mutualLeg: best.mutualLeg }); }
        else allMatched = false;
      });

      if (allMatched) {
        var rn = self._nightSet(reqLabel);
        Object.keys(selNight).forEach(function (i) { delete rn[i]; });
        assignments.forEach(function (a) { if (a.rb.cls === "NIGHT") a.cb.idxs.forEach(function (i) { rn[i] = 1; }); });
        if (maxRun(rn) > 4) { ineligible.push({ label: C.label, reasons: ["This swap would put you over 4 nights in a row"] }); return; }

        var score = 0;
        // Did C also flag the requester's selected dates as their wanted-off?
        // (mutual on the "they take your shift" leg)
        var cMutualOnReq = cWanted && selIdxs.some(function (i) { return cWanted[i]; });
        assignments.forEach(function (a) {
          score += a.sc;
          a.rWarn.forEach(function (w) { warnings.push(w); });
          if (!restMatches(a.rb, a.cb)) {
            warnings.push("Rest days either side differ (" + a.rb.restBeforeIdxs.length + "/" + a.rb.restAfterIdxs.length +
              " vs " + a.cb.restBeforeIdxs.length + "/" + a.cb.restAfterIdxs.length + ") — the off days travel with the shift, so one of you changes rest");
          }
        });
        // Classify mutual: strong = both directions, soft = one direction.
        var anyLegMutual = assignments.some(function (a) { return a.mutualLeg; });
        var mutual = null;
        if (cMutualOnReq && anyLegMutual) mutual = "strong";
        else if (cMutualOnReq || anyLegMutual) mutual = "soft";
        if (mutual === "strong") score -= 1000; // top-rank
        else if (mutual === "soft") score -= 50;
        swaps.push({ label: C.label, grade: C.grade, dept: C.dept, assignments: assignments, score: score, warnings: warnings, mutual: mutual });
      } else {
        coverOnly.push({ label: C.label, grade: C.grade, dept: C.dept, warnings: warnings });
      }
    });

    function rank(a, b) {
      // mutual swaps always sort above non-mutual (even with warnings)
      var am = a.mutual === "strong" ? 2 : a.mutual === "soft" ? 1 : 0;
      var bm = b.mutual === "strong" ? 2 : b.mutual === "soft" ? 1 : 0;
      if (am !== bm) return bm - am;
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      if ((a.score || 0) !== (b.score || 0)) return (a.score || 0) - (b.score || 0);
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }
    swaps.sort(rank); coverOnly.sort(function (a, b) {
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    });

    var chains = [];
    if (!swaps.length && reqBlocks.length === 1) {
      chains = this._findChains(reqLabel, reqBlocks[0], sel, unavail, prefs);
    }

    return { reqBlocks: reqBlocks, swaps: swaps, chains: chains, coverOnly: coverOnly, ineligible: ineligible };
  };

  /* Standalone mutual-match scan. For a given person, returns any other
     candidate whose wantedOff overlaps with one of this person's on-calls
     AND vice-versa — the strongest signal we have without anyone running
     a search. Used for the opening banner. */
  Engine.prototype.findMutualOpportunities = function (reqLabel, prefs) {
    prefs = prefs || {};
    var self = this;
    var myOcs = this.oncallShifts(reqLabel).map(function (s) { return s.idx; });
    var myOcsSet = {}; myOcs.forEach(function (i) { myOcsSet[i] = 1; });
    var myWanted = (prefs[reqLabel] || {}).wantedOff || {};
    var out = [];
    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var theirWanted = (prefs[C.label] || {}).wantedOff;
      if (!theirWanted) return;
      // They want one of MY on-call days off?
      var theyWantMine = Object.keys(theirWanted).map(Number).filter(function (i) { return myOcsSet[i]; });
      if (!theyWantMine.length) return;
      // Do I want one of THEIR on-call days off (strong)?
      var theirOcsSet = {}; self.oncallShifts(C.label).forEach(function (s) { theirOcsSet[s.idx] = 1; });
      var iWantTheirs = Object.keys(myWanted).map(Number).filter(function (i) { return theirOcsSet[i]; });
      out.push({
        label: C.label, grade: C.grade, dept: C.dept,
        theyWantMine: theyWantMine,                // their wantedOff ∩ my on-calls
        iWantTheirs: iWantTheirs,                  // my wantedOff   ∩ their on-calls
        strong: iWantTheirs.length > 0
      });
    });
    out.sort(function (a, b) {
      if (a.strong !== b.strong) return b.strong - a.strong;
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    });
    return out;
  };

  /* Three-way cyclic swap for a single request block. */
  Engine.prototype._findChains = function (reqLabel, rb, sel, unavail, prefs) {
    var self = this, K = rb.cls, out = [], seen = {};
    var rbNights = nightIdxsOf(self, reqLabel, rb);

    function prefOf(l) { return (prefs[l] || {}).unavail || null; }
    function blocksOf(l) {
      return self.groupBlocks(l, self.oncallShifts(l).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.cls === K; });
    }
    function freeAll(l, block, pref, excludeSel) {
      return block.idxs.every(function (i) {
        if (excludeSel && sel[i]) return false;
        return self.freeToWork(l, i, pref).ok;
      });
    }

    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var cPref = prefOf(C.label);
      if (!freeAll(C.label, rb, cPref, false)) return;
      if (!self._nightRunOk(C.label, [], rbNights)) return;

      var cBlocks = blocksOf(C.label).filter(function (b) { return b.idxs.every(function (i) { return !sel[i]; }); });

      cBlocks.forEach(function (cb) {
        var cbNights = nightIdxsOf(self, C.label, cb);
        if (!self._nightRunOk(C.label, cbNights, rbNights)) return;

        self.data.staff.forEach(function (D) {
          if (!D.candidate || D.label === reqLabel || D.label === C.label) return;
          var dPref = prefOf(D.label);
          if (!freeAll(D.label, cb, dPref, true)) return;

          var dBlocks = blocksOf(D.label).filter(function (b) {
            return b.idxs.every(function (i) { return !sel[i] && cb.idxs.indexOf(i) < 0; });
          });

          dBlocks.forEach(function (db) {
            var dbNights = nightIdxsOf(self, D.label, db);
            if (!self._nightRunOk(D.label, dbNights, cbNights)) return;
            var youOk = db.idxs.every(function (i) {
              if (unavail[i] || sel[i]) return false;
              return self.freeToWork(reqLabel, i).ok;
            });
            if (!youOk) return;
            if (!self._nightRunOk(reqLabel, rbNights, dbNights)) return;

            var key = C.label + ">" + D.label + ":" + cb.start + ":" + db.start;
            if (seen[key]) return; seen[key] = 1;

            var score = equity(rb, cb) + equity(cb, db) + equity(db, rb);
            var warnings = [];
            if (!restMatches(rb, cb) || !restMatches(cb, db) || !restMatches(db, rb))
              warnings.push("Rest days either side aren't identical across all three — check the off days travel cleanly");

            out.push({
              C: { label: C.label, grade: C.grade, dept: C.dept },
              D: { label: D.label, grade: D.grade, dept: D.dept },
              rb: rb, cb: cb, db: db, score: score, warnings: warnings
            });
          });
        });
      });
    });

    out.sort(function (a, b) {
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      return a.score - b.score;
    });
    return out.slice(0, 6);
  };

  global.RotaEngine = Engine;
  global.RotaEngine.shiftClass = shiftClass;
  global.RotaEngine.CLASS_LABEL = CLASS_LABEL;
  global.RotaEngine.OFF_ROTA_GAP_DAYS = OFF_ROTA_GAP_DAYS;

  // ---- UI (browser only) --------------------------------------------------
  if (typeof document === "undefined") return;

  var data = global.ROTA_DATA;
  var engine = new Engine(data);
  var state = {
    person: null,
    selected: {},          // {idx:1} - requester's own on-call days they want off
    unavailRanges: [],     // [{start:iso,end:iso}, ...] - dates THEY (the active user) can't take a swap onto
    rotaTeamEmail: ""      // optional, persisted in localStorage
  };
  var allPrefs = {};
  var prefsMap = {};

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fmt(iso, dow) {
    var d = new Date(iso + "T00:00:00");
    var s = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return (dow ? dow + " " : "") + s;
  }
  function fmtShort(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  function chip(type) { return el("span", "chip chip-" + shiftClass(type), type); }

  function isoOfIdx(i) { return data.dates[i] ? data.dates[i].iso : null; }
  function idxOfIso(iso) { return engine.idxByIso[iso]; }

  // unavail set used at search-time: union of stored prefs + ad-hoc ranges
  function unavailSet() {
    var set = {};
    state.unavailRanges.forEach(function (r) {
      var s = idxOfIso(r.start), e = idxOfIso(r.end);
      if (s == null || e == null) return;
      if (s > e) { var t = s; s = e; e = t; }
      for (var i = s; i <= e; i++) set[i] = 1;
    });
    return set;
  }

  // ---- shared preference store -------------------------------------------
  var Store = {
    ENDPOINT: "/.netlify/functions/prefs",
    CACHE: "rds_prefs_cache",
    shared: false,
    loadAll: function () {
      var self = this;
      return fetch(this.ENDPOINT, { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("no backend"); return r.json(); })
        .then(function (j) { self.shared = true; try { localStorage.setItem(self.CACHE, JSON.stringify(j)); } catch (e) {} return j || {}; })
        .catch(function () { self.shared = false; try { return JSON.parse(localStorage.getItem(self.CACHE) || "{}"); } catch (e) { return {}; } });
    },
    save: function (label, prefs) {
      var self = this;
      try { var all = JSON.parse(localStorage.getItem(self.CACHE) || "{}"); all[label] = prefs; localStorage.setItem(self.CACHE, JSON.stringify(all)); } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label, prefs: prefs })
      }).then(function (r) { self.shared = r.ok; return r.ok; })
        .catch(function () { self.shared = false; return false; });
    }
  };
  function rebuildPrefsMap() {
    prefsMap = {};
    Object.keys(allPrefs).forEach(function (lbl) {
      var entry = allPrefs[lbl] || {};
      var u = {}; (entry.unavail || []).forEach(function (iso) { var i = idxOfIso(iso); if (i != null) u[i] = 1; });
      var w = {}; (entry.wantedOff || []).forEach(function (iso) { var i = idxOfIso(iso); if (i != null) w[i] = 1; });
      prefsMap[lbl] = { unavail: u, wantedOff: w };
    });
  }

  // ---- person picker ------------------------------------------------------
  (function initPicker() {
    var sel = $("#person");
    data.staff.slice().sort(function (a, b) {
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }).forEach(function (s) {
      var o = el("option"); o.value = s.label;
      o.textContent = "Slot " + s.label + " — " + s.grade + " · " + s.dept + (s.hasOncall ? "" : " (no on-calls)");
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      state.person = sel.value || null;
      state.selected = {};
      state.unavailRanges = [];
      renderPerson();
      renderUnavail();
      // Refresh from the shared store so seeded data is up-to-date and we can
      // check whether anyone is currently looking for one of this person's shifts.
      Store.loadAll().then(function (j) {
        allPrefs = j || {}; rebuildPrefsMap();
        seedUnavailFromPrefs();
        renderMutualBanner();
        renderPerson(); // re-render to show "wanted off" badges on shifts
      });
    });
  })();

  function renderPerson() {
    var wrap = $("#shifts"); wrap.innerHTML = "";
    $("#results").innerHTML = "";
    $("#find").classList.add("hide");
    if (!state.person) {
      $("#step2").classList.add("hide");
      $("#step3").classList.add("hide");
      $("#person-card").classList.remove("active");
      return;
    }
    $("#person-card").classList.add("active");
    var s = engine.staffByLabel[state.person];
    var shifts = engine.oncallShifts(state.person);
    $("#step2").classList.remove("hide");
    $("#step3").classList.remove("hide");

    var meta = $("#person-meta");
    meta.innerHTML = "";
    meta.appendChild(el("span", "tag", s.grade));
    meta.appendChild(el("span", "tag", s.dept));
    meta.appendChild(el("span", "tag", "On rota " + fmtShort(s.active[0]) + " – " + fmtShort(s.active[1])));

    if (!shifts.length) {
      wrap.appendChild(el("p", "empty", "This person holds no swappable on-call shifts in the rota period."));
      return;
    }

    // Which dates has THIS user already advertised as wanted-off?
    var myEntry = allPrefs[state.person] || {};
    var myAdvertised = {};
    (myEntry.wantedOff || []).forEach(function (iso) { myAdvertised[iso] = 1; });

    // Show a status strip if they're currently advertising any wanted-off
    var statusStrip = $("#looking-status"); statusStrip.innerHTML = "";
    if (myEntry.wantedOff && myEntry.wantedOff.length) {
      statusStrip.classList.remove("hide");
      var line = el("div", "looking-status-line");
      var icon = el("span", "looking-dot");
      line.appendChild(icon);
      line.appendChild(el("span", "looking-text",
        "You're currently advertising as looking on " + myEntry.wantedOff.length +
        (myEntry.wantedOff.length === 1 ? " date" : " dates")));
      var clearBtn = el("button", "looking-clear", "Stop looking");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", function () {
        publishWantedOff([]).then(function () {
          renderPerson();
          renderMutualBanner();
        });
      });
      line.appendChild(clearBtn);
      statusStrip.appendChild(line);
    } else {
      statusStrip.classList.add("hide");
    }

    // Group on-calls into blocks for display
    var blocks = engine.groupBlocks(state.person, shifts.map(function (x) { return x.idx; }));
    blocks.forEach(function (b) {
      var card = el("div", "shift-row");
      card.dataset.idxs = b.idxs.join(",");
      var alreadyAdvertised = b.idxs.every(function (i) { return myAdvertised[data.dates[i].iso]; });
      if (alreadyAdvertised) card.classList.add("advertised");

      var left = el("div", "shift-main");
      var topLine = el("div", "shift-toplabel");
      topLine.appendChild(chip(engine.cell(state.person, b.idxs[0]).v));
      topLine.appendChild(el("span", "shift-cls-label", b.len > 1 ? b.len + "-day block" : ""));
      if (alreadyAdvertised) {
        var flag = el("span", "looking-flag", "Looking");
        topLine.appendChild(flag);
      }
      left.appendChild(topLine);

      var dates = el("div", "shift-dates");
      b.idxs.forEach(function (i) {
        var d = data.dates[i];
        var pill = el("span", "shift-pill");
        pill.appendChild(el("span", "shift-dow", d.dow));
        pill.appendChild(el("span", "shift-date", fmtShort(d.iso)));
        if (b.idxs.length > 1) pill.appendChild(chip(engine.cell(state.person, i).v));
        dates.appendChild(pill);
      });
      left.appendChild(dates);

      var rest = el("div", "shift-rest");
      rest.textContent = b.offBefore + " off before · " + b.offAfter + " off after";
      left.appendChild(rest);

      card.appendChild(left);

      var btn = el("button", "pick");
      btn.innerHTML = '<span class="pick-label">Swap this</span>';
      btn.addEventListener("click", function () { toggleBlock(b, card, btn); });
      card.appendChild(btn);
      wrap.appendChild(card);
    });
  }

  function toggleBlock(b, card, btn) {
    var on = b.idxs.every(function (i) { return state.selected[i]; });
    b.idxs.forEach(function (i) { if (on) delete state.selected[i]; else state.selected[i] = 1; });
    card.classList.toggle("selected", !on);
    btn.querySelector(".pick-label").textContent = on ? "Swap this" : "Selected";
    var any = Object.keys(state.selected).length > 0;
    $("#find").classList.toggle("hide", !any);
    if (!any) $("#results").innerHTML = "";
  }

  // Surface a "someone is currently looking" banner above step 2 if any
  // other staff has published wanted-off dates that overlap with this
  // user's on-call shifts. Auto-selects those shifts when tapped.
  function renderMutualBanner() {
    var wrap = $("#mutual-banner"); wrap.innerHTML = "";
    if (!state.person) { wrap.classList.add("hide"); return; }
    var opps = engine.findMutualOpportunities(state.person, prefsMap);
    if (!opps.length) { wrap.classList.add("hide"); return; }
    wrap.classList.remove("hide");

    var head = el("div", "banner-head");
    head.appendChild(el("div", "banner-kicker", "Mutual swap opportunity"));
    head.appendChild(el("div", "banner-title",
      opps.length === 1
        ? "Slot " + opps[0].label + " is currently looking for a swap on one of your shifts"
        : opps.length + " colleagues are looking for a swap on one of your shifts"));
    wrap.appendChild(head);

    var list = el("div", "banner-list");
    opps.slice(0, 6).forEach(function (o) {
      var row = el("button", "banner-row" + (o.strong ? " strong" : ""));
      row.type = "button";
      var lhs = el("div", "banner-row-main");
      var labelLine = el("div", "banner-row-label");
      labelLine.appendChild(el("strong", null, "Slot " + o.label));
      labelLine.appendChild(el("span", "banner-row-meta", o.grade + " · " + o.dept));
      if (o.strong) {
        var b = el("span", "mutual-pill strong", "Both ways");
        labelLine.appendChild(b);
      }
      lhs.appendChild(labelLine);

      var datesLine = el("div", "banner-row-dates");
      o.theyWantMine.forEach(function (i) {
        var d = data.dates[i];
        var px = el("span", "banner-date");
        px.appendChild(chip(engine.cell(state.person, i).v));
        px.appendChild(el("span", null, fmtShort(d.iso)));
        datesLine.appendChild(px);
      });
      lhs.appendChild(datesLine);
      row.appendChild(lhs);
      row.appendChild(el("span", "banner-row-cta", "Tap to swap →"));

      row.addEventListener("click", function () {
        // Pre-select the overlapping dates and trigger search
        state.selected = {};
        o.theyWantMine.forEach(function (i) { state.selected[i] = 1; });
        // Update visual state in the shifts list
        document.querySelectorAll(".shift-row").forEach(function (sr) {
          var idxs = (sr.dataset.idxs || "").split(",").map(Number);
          var allIn = idxs.every(function (i) { return state.selected[i]; });
          sr.classList.toggle("selected", allIn);
          var btn = sr.querySelector(".pick-label");
          if (btn) btn.textContent = allIn ? "Selected" : "Swap this";
        });
        $("#find").classList.remove("hide");
        $("#find").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  // ---- unavail ranges (multi-range picker) -------------------------------
  // Single combined panel — also seeds from the person's stored preferences,
  // so they don't have to enter them twice.
  function seedUnavailFromPrefs() {
    if (!state.person) return;
    var p = allPrefs[state.person]; if (!p || !p.unavail) return;
    // Reconstruct ranges from the stored ISO list by coalescing consecutive
    // dates back into multi-day ranges. Preserves whatever the user originally
    // typed in the common case (a single range entered as a range).
    var isos = (p.unavail || []).slice().sort();
    if (!isos.length) { state.unavailRanges = []; renderUnavail(); return; }
    var ranges = [];
    var cur = { start: isos[0], end: isos[0] };
    for (var i = 1; i < isos.length; i++) {
      var prev = idxOfIso(cur.end), next = idxOfIso(isos[i]);
      if (prev != null && next === prev + 1) cur.end = isos[i];
      else { ranges.push(cur); cur = { start: isos[i], end: isos[i] }; }
    }
    ranges.push(cur);
    state.unavailRanges = ranges;
    renderUnavail();
  }

  (function initUnavail() {
    $("#unavail-from").min = data.dateStart; $("#unavail-from").max = data.dateEnd;
    $("#unavail-to").min = data.dateStart; $("#unavail-to").max = data.dateEnd;
    $("#unavail-from").addEventListener("change", function (e) {
      if (!$("#unavail-to").value || $("#unavail-to").value < e.target.value) $("#unavail-to").value = e.target.value;
    });
    $("#unavail-add").addEventListener("click", function () {
      var s = $("#unavail-from").value, e = $("#unavail-to").value || s;
      if (!s) { flash($("#unavail-msg"), "Pick a start date first."); return; }
      if (idxOfIso(s) == null || idxOfIso(e) == null) { flash($("#unavail-msg"), "Dates must fall inside the rota period."); return; }
      state.unavailRanges.push({ start: s, end: e });
      $("#unavail-from").value = ""; $("#unavail-to").value = "";
      $("#unavail-from").focus();
      persistRangesToPrefs();
      renderUnavail();
    });
  })();

  // Whenever the unavailability list changes, mirror it back to the shared
  // store so other people see this person's flagged dates.
  function persistRangesToPrefs() {
    if (!state.person) return;
    var iso = {};
    state.unavailRanges.forEach(function (r) {
      var s = idxOfIso(r.start), e = idxOfIso(r.end);
      if (s == null || e == null) return;
      if (s > e) { var t = s; s = e; e = t; }
      for (var i = s; i <= e; i++) iso[isoOfIdx(i)] = 1;
    });
    var list = Object.keys(iso).sort();
    var prev = allPrefs[state.person] || {};
    if (JSON.stringify(list) === JSON.stringify(prev.unavail || [])) return;
    var p = {
      unavail: list,
      wantedOff: prev.wantedOff || [],
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[state.person] = p;
    setStatus("Saving your unavailable dates…", "saving");
    Store.save(state.person, p).then(function (ok) {
      rebuildPrefsMap();
      setStatus(ok ? "Saved — visible to everyone using the swap shop." : "Saved on this device only — shared store unreachable.", ok ? "ok" : "local");
    });
  }

  // Publish (or clear) the current user's wanted-off list to the shared store.
  // Called when they hit "Find a swap" (publish their selected dates) and
  // also when they explicitly clear it.
  function publishWantedOff(isoList) {
    if (!state.person) return Promise.resolve(false);
    var prev = allPrefs[state.person] || {};
    var p = {
      unavail: prev.unavail || [],
      wantedOff: (isoList || []).slice().sort(),
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[state.person] = p;
    rebuildPrefsMap();
    return Store.save(state.person, p);
  }

  function setStatus(msg, cls) {
    var n = $("#unavail-status"); n.textContent = msg || ""; n.className = "savestatus " + (cls || "");
  }

  function renderUnavail() {
    var list = $("#unavail-list"); list.innerHTML = "";
    if (!state.unavailRanges.length) {
      list.appendChild(el("p", "subtle", "No unavailable dates flagged yet."));
      return;
    }
    state.unavailRanges
      .slice()
      .sort(function (a, b) { return a.start.localeCompare(b.start); })
      .forEach(function (r, displayIdx) {
        var realIdx = state.unavailRanges.indexOf(r);
        var pill = el("span", "range-pill");
        var label = r.start === r.end ? fmtShort(r.start) : fmtShort(r.start) + " – " + fmtShort(r.end);
        pill.appendChild(el("span", "range-text", label));
        var x = el("button", "range-x", "✕");
        x.addEventListener("click", function () {
          state.unavailRanges.splice(realIdx, 1);
          persistRangesToPrefs();
          renderUnavail();
        });
        pill.appendChild(x);
        list.appendChild(pill);
      });
  }

  function flash(node, msg) { node.textContent = msg; setTimeout(function () { node.textContent = ""; }, 3000); }

  // ---- find ---------------------------------------------------------------
  $("#find").addEventListener("click", function () {
    var selIdxs = Object.keys(state.selected).map(Number);
    if (!selIdxs.length) return;
    $("#find").disabled = true;
    var label = $("#find").querySelector(".btn-label");
    var old = label.textContent;
    label.textContent = "Finding matches…";
    // Publish wanted-off intent + refresh shared store in parallel.
    var isoList = selIdxs.map(isoOfIdx).filter(Boolean);
    Promise.all([publishWantedOff(isoList), Store.loadAll()]).then(function (out) {
      allPrefs = out[1] || {}; rebuildPrefsMap();
      seedUnavailFromPrefs();
      var res = engine.findSwaps(state.person, selIdxs, unavailSet(), prefsMap);
      renderResults(res);
      $("#find").disabled = false;
      label.textContent = old;
    });
  });

  function renderResults(res) {
    var root = $("#results"); root.innerHTML = "";
    root.appendChild(summaryCard(res.reqBlocks));

    var mutualSwaps = res.swaps.filter(function (s) { return s.mutual; });
    var otherSwaps = res.swaps.filter(function (s) { return !s.mutual; });

    if (mutualSwaps.length) {
      root.appendChild(el("h3", "res-h mutual-h", "Mutual swap — both of you are looking"));
      mutualSwaps.slice(0, 5).forEach(function (sw, i) { root.appendChild(swapCard(sw, i === 0)); });
    }

    if (otherSwaps.length) {
      root.appendChild(el("h3", "res-h", mutualSwaps.length ? "Other direct swaps" : "Direct swaps"));
      otherSwaps.slice(0, 8).forEach(function (sw, i) { root.appendChild(swapCard(sw, i === 0 && !mutualSwaps.length)); });
    }

    if (!res.swaps.length) {
      if (res.chains && res.chains.length) {
        var n0 = el("div", "card note");
        n0.appendChild(el("strong", null, "No direct two-way swap available."));
        n0.appendChild(el("p", null, "Try one of the three-way swaps below — the loop closes so everyone keeps the same number of on-calls."));
        root.appendChild(n0);
      } else {
        var none = el("div", "card note");
        none.appendChild(el("strong", null, "No clean swap found."));
        none.appendChild(el("p", null, "Nobody can take all the days you've selected and hand back an equivalent shift. The people below could cover your shift — your rota team can arrange a return manually."));
        root.appendChild(none);
      }
    }

    if (res.chains && res.chains.length) {
      root.appendChild(el("h3", "res-h", "Three-way swaps"));
      res.chains.slice(0, 5).forEach(function (ch, i) { root.appendChild(chainCard(ch, !res.swaps.length && i === 0)); });
    }

    if (res.coverOnly.length) {
      root.appendChild(el("h3", "res-h", "Could cover (no return shift)"));
      res.coverOnly.slice(0, 6).forEach(function (c) { root.appendChild(coverCard(c)); });
    }

    var det = el("details", "why");
    det.appendChild(el("summary", null, "Why others weren't suggested (" + res.ineligible.length + ")"));
    var ul = el("ul");
    res.ineligible.slice(0, 50).forEach(function (x) {
      var li = el("li"); li.appendChild(el("strong", null, "Slot " + x.label + ": "));
      li.appendChild(document.createTextNode(x.reasons.join("; ")));
      ul.appendChild(li);
    });
    det.appendChild(ul); root.appendChild(det);
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function summaryCard(reqBlocks) {
    var c = el("div", "card summary");
    c.appendChild(el("div", "kicker", "You want off"));
    reqBlocks.forEach(function (b) {
      var row = el("div", "sum-row");
      row.appendChild(chip(engine.cell(state.person, b.idxs[0]).v));
      row.appendChild(el("span", "sum-dates", b.idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(" · ")));
      c.appendChild(row);
    });
    return c;
  }

  function datesLine(idxs) { return idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(" · "); }
  function restTravel(block) {
    var n = block.restBeforeIdxs.length + block.restAfterIdxs.length;
    if (!n) return null;
    var parts = [];
    if (block.restBeforeIdxs.length) parts.push(block.restBeforeIdxs.length + " before");
    if (block.restAfterIdxs.length) parts.push(block.restAfterIdxs.length + " after");
    return "Rest days (" + parts.join(", ") + ") travel with the shift";
  }

  function legRow(who, idxs, ownerLabel) {
    var r = el("div", "leg");
    r.appendChild(el("span", "leg-label", who));
    var inner = el("div", "leg-content");
    idxs.forEach(function (i) { inner.appendChild(chip(engine.cell(ownerLabel, i).v)); });
    inner.appendChild(el("span", "leg-dates", datesLine(idxs)));
    r.appendChild(inner);
    return r;
  }

  function swapCard(sw, top) {
    var cls = "card swap";
    if (top) cls += " top";
    if (sw.mutual === "strong") cls += " mutual-strong";
    else if (sw.mutual === "soft") cls += " mutual-soft";
    var c = el("div", cls);
    if (sw.mutual === "strong") c.appendChild(el("div", "ribbon mutual", "Mutual swap"));
    else if (sw.mutual === "soft") c.appendChild(el("div", "ribbon mutual-soft", "They're also looking"));
    else if (top) c.appendChild(el("div", "ribbon", "Best match"));
    var head = el("div", "swap-head");
    head.appendChild(el("span", "slot", "Slot " + sw.label));
    head.appendChild(el("span", "tag", sw.grade));
    head.appendChild(el("span", "tag", sw.dept));
    c.appendChild(head);

    sw.assignments.forEach(function (a) {
      var ex = el("div", "exchange");
      ex.appendChild(legRow("They take", a.rb.idxs, state.person));
      var rt1 = restTravel(a.rb); if (rt1) ex.appendChild(el("div", "rest-travel", rt1));
      ex.appendChild(el("div", "swap-arrow", "⇅"));
      ex.appendChild(legRow("You take", a.cb.idxs, sw.label));
      var rt2 = restTravel(a.cb); if (rt2) ex.appendChild(el("div", "rest-travel", rt2));
      c.appendChild(ex);
    });

    if (sw.warnings.length) {
      var w = el("div", "warns");
      sw.warnings.forEach(function (m) { w.appendChild(el("div", "warn", "⚠ " + m)); });
      c.appendChild(w);
    } else {
      c.appendChild(el("div", "clean", sw.mutual === "strong"
        ? "Both of you have flagged this swap — easy yes"
        : sw.mutual === "soft"
          ? "They've also flagged this date — likely to say yes"
          : "Like-for-like with matching rest days"));
    }

    c.appendChild(buildEmailFooter({
      kind: "direct",
      partnerLabel: sw.label,
      partnerGrade: sw.grade,
      partnerDept: sw.dept,
      assignments: sw.assignments
    }));
    return c;
  }

  function chainCard(ch, top) {
    var c = el("div", "card swap chain" + (top ? " top" : ""));
    if (top) c.appendChild(el("div", "ribbon", "Best option"));
    var head = el("div", "swap-head");
    head.appendChild(el("span", "slot", "3-way: Slot " + ch.C.label + " + Slot " + ch.D.label));
    c.appendChild(head);

    var ex = el("div", "exchange");
    ex.appendChild(legRow("Slot " + ch.C.label + " takes", ch.rb.idxs, state.person));
    var rtA = restTravel(ch.rb); if (rtA) ex.appendChild(el("div", "rest-travel", rtA));
    ex.appendChild(el("div", "swap-arrow chain-arrow", "↻"));
    ex.appendChild(legRow("Slot " + ch.D.label + " takes", ch.cb.idxs, ch.C.label));
    var rtB = restTravel(ch.cb); if (rtB) ex.appendChild(el("div", "rest-travel", rtB));
    ex.appendChild(el("div", "swap-arrow chain-arrow", "↻"));
    ex.appendChild(legRow("You take", ch.db.idxs, ch.D.label));
    var rtC = restTravel(ch.db); if (rtC) ex.appendChild(el("div", "rest-travel", rtC));
    c.appendChild(ex);

    if (ch.warnings.length) {
      var w = el("div", "warns");
      ch.warnings.forEach(function (m) { w.appendChild(el("div", "warn", "⚠ " + m)); });
      c.appendChild(w);
    } else {
      c.appendChild(el("div", "clean", "Loop closes cleanly — same on-calls for everyone"));
    }

    c.appendChild(buildEmailFooter({
      kind: "chain",
      chain: ch
    }));
    return c;
  }

  function coverCard(c0) {
    var c = el("div", "card cover");
    var head = el("div", "swap-head");
    head.appendChild(el("span", "slot", "Slot " + c0.label));
    head.appendChild(el("span", "tag", c0.grade));
    head.appendChild(el("span", "tag", c0.dept));
    c.appendChild(head);
    c.appendChild(el("div", "cover-note", "Free to take your shift on every selected date."));
    if (c0.warnings.length) c0.warnings.forEach(function (m) { c.appendChild(el("div", "warn", "⚠ " + m)); });
    return c;
  }

  // ---- email generation ---------------------------------------------------
  function buildEmailFooter(opts) {
    var foot = el("div", "card-foot");
    var actions = el("div", "card-actions");

    var askBtn = el("button", "btn-ghost", "Draft “ask them” email");
    askBtn.addEventListener("click", function () { openEmailModal("ask", opts); });
    actions.appendChild(askBtn);

    var confirmBtn = el("button", "btn-solid", "Draft rota-team email");
    confirmBtn.addEventListener("click", function () { openEmailModal("confirm", opts); });
    actions.appendChild(confirmBtn);

    foot.appendChild(actions);
    return foot;
  }

  function emailDates(idxs) {
    return idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(", ");
  }

  function buildAskEmail(opts) {
    var me = engine.staffByLabel[state.person];
    var lines = [];
    if (opts.kind === "direct") {
      lines.push("Hi,");
      lines.push("");
      lines.push("I'm trying to arrange an on-call swap and the swap shop has flagged you as a good match. Would you be willing to swap?");
      lines.push("");
      opts.assignments.forEach(function (a) {
        var cls = CLASS_LABEL[a.rb.cls];
        lines.push("• You'd take my " + cls + " — " + emailDates(a.rb.idxs));
        lines.push("• In return, I'd take your " + cls + " — " + emailDates(a.cb.idxs));
      });
      lines.push("");
      lines.push("If that works, let me know and we'll send it to the rota team to make official.");
      lines.push("");
      lines.push("Thanks,");
      lines.push("Slot " + me.label + " (" + me.grade + ", " + me.dept + ")");
      return {
        subject: "On-call swap request — Slot " + me.label + " ↔ Slot " + opts.partnerLabel,
        body: lines.join("\n"),
        to: ""
      };
    } else {
      var ch = opts.chain;
      lines.push("Hi both,");
      lines.push("");
      lines.push("Putting you both on the same email — the swap shop's suggested a three-way swap that works for all of us:");
      lines.push("");
      lines.push("• Slot " + ch.C.label + " takes my " + CLASS_LABEL[ch.rb.cls] + " — " + emailDates(ch.rb.idxs));
      lines.push("• Slot " + ch.D.label + " takes Slot " + ch.C.label + "'s " + CLASS_LABEL[ch.cb.cls] + " — " + emailDates(ch.cb.idxs));
      lines.push("• I take Slot " + ch.D.label + "'s " + CLASS_LABEL[ch.db.cls] + " — " + emailDates(ch.db.idxs));
      lines.push("");
      lines.push("Everyone keeps the same number of on-calls. If you're both happy, let me know and we'll send it to the rota team.");
      lines.push("");
      lines.push("Thanks,");
      lines.push("Slot " + me.label + " (" + me.grade + ", " + me.dept + ")");
      return {
        subject: "Three-way on-call swap — Slots " + me.label + " / " + ch.C.label + " / " + ch.D.label,
        body: lines.join("\n"),
        to: ""
      };
    }
  }

  function buildConfirmEmail(opts) {
    var me = engine.staffByLabel[state.person];
    var lines = [];
    if (opts.kind === "direct") {
      var partnerSummary = "Slot " + opts.partnerLabel + " (" + opts.partnerGrade + ", " + opts.partnerDept + ")";
      lines.push("Hi rota team,");
      lines.push("");
      lines.push("Please could you action the following on-call swap. " + partnerSummary + " has agreed to it:");
      lines.push("");
      opts.assignments.forEach(function (a) {
        var cls = CLASS_LABEL[a.rb.cls];
        lines.push("• " + partnerSummary + " takes my " + cls + ": " + emailDates(a.rb.idxs));
        lines.push("• I take their " + cls + ": " + emailDates(a.cb.idxs));
      });
      lines.push("");
      lines.push("Rest days either side travel with the shift in the usual way.");
      lines.push("");
      lines.push("Thanks,");
      lines.push("Slot " + me.label + " (" + me.grade + ", " + me.dept + ")");
      return {
        subject: "Please action: on-call swap — Slot " + me.label + " ↔ Slot " + opts.partnerLabel,
        body: lines.join("\n"),
        to: state.rotaTeamEmail || ""
      };
    } else {
      var ch = opts.chain;
      lines.push("Hi rota team,");
      lines.push("");
      lines.push("Please could you action the following three-way on-call swap. Both other parties have agreed:");
      lines.push("");
      lines.push("• Slot " + ch.C.label + " (" + ch.C.grade + ", " + ch.C.dept + ") takes my " + CLASS_LABEL[ch.rb.cls] + ": " + emailDates(ch.rb.idxs));
      lines.push("• Slot " + ch.D.label + " (" + ch.D.grade + ", " + ch.D.dept + ") takes Slot " + ch.C.label + "'s " + CLASS_LABEL[ch.cb.cls] + ": " + emailDates(ch.cb.idxs));
      lines.push("• I take Slot " + ch.D.label + "'s " + CLASS_LABEL[ch.db.cls] + ": " + emailDates(ch.db.idxs));
      lines.push("");
      lines.push("Rest days either side travel with each shift in the usual way. Everyone keeps the same number of on-calls.");
      lines.push("");
      lines.push("Thanks,");
      lines.push("Slot " + me.label + " (" + me.grade + ", " + me.dept + ")");
      return {
        subject: "Please action: three-way on-call swap — Slots " + me.label + " / " + ch.C.label + " / " + ch.D.label,
        body: lines.join("\n"),
        to: state.rotaTeamEmail || ""
      };
    }
  }

  function openEmailModal(kind, opts) {
    var draft = kind === "ask" ? buildAskEmail(opts) : buildConfirmEmail(opts);
    $("#email-subject").value = draft.subject;
    $("#email-body").value = draft.body;
    $("#email-to").value = draft.to;
    $("#email-modal").dataset.kind = kind;
    $("#email-modal").classList.add("open");
    $("#email-modal-title").textContent = kind === "ask" ? "Email to the other doctor" : "Email to the rota team";
    document.body.style.overflow = "hidden";
  }
  function closeEmailModal() {
    $("#email-modal").classList.remove("open");
    document.body.style.overflow = "";
  }
  $("#email-close").addEventListener("click", closeEmailModal);
  $("#email-modal").addEventListener("click", function (e) { if (e.target === $("#email-modal")) closeEmailModal(); });
  $("#email-copy").addEventListener("click", function () {
    var text = "Subject: " + $("#email-subject").value + "\n\n" + $("#email-body").value;
    navigator.clipboard.writeText(text).then(function () {
      var b = $("#email-copy"); var t = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = t; }, 1500);
    });
  });
  $("#email-open").addEventListener("click", function () {
    var to = encodeURIComponent($("#email-to").value || "");
    var subject = encodeURIComponent($("#email-subject").value);
    var body = encodeURIComponent($("#email-body").value);
    if ($("#email-modal").dataset.kind === "confirm" && $("#email-to").value) {
      try { localStorage.setItem("rds_rota_email", $("#email-to").value); state.rotaTeamEmail = $("#email-to").value; } catch (e) {}
    }
    window.location.href = "mailto:" + to + "?subject=" + subject + "&body=" + body;
  });

  // load saved rota team email
  try {
    var saved = localStorage.getItem("rds_rota_email");
    if (saved) state.rotaTeamEmail = saved;
  } catch (e) {}

  // ---- help modal ---------------------------------------------------------
  $("#help-open").addEventListener("click", function () {
    $("#help-modal").classList.add("open");
    document.body.style.overflow = "hidden";
  });
  $("#help-close").addEventListener("click", function () {
    $("#help-modal").classList.remove("open");
    document.body.style.overflow = "";
  });
  $("#help-modal").addEventListener("click", function (e) { if (e.target === $("#help-modal")) {
    $("#help-modal").classList.remove("open");
    document.body.style.overflow = "";
  }});

  // ---- footer / init ------------------------------------------------------
  $("#rota-range").textContent = fmt(data.dateStart) + " – " + fmt(data.dateEnd);
  Store.loadAll().then(function (j) {
    allPrefs = j || {}; rebuildPrefsMap();
    if (state.person) { seedUnavailFromPrefs(); }
  });
})(typeof window !== "undefined" ? window : globalThis);
