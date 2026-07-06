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
  //
  // A Saturday/Sunday/BH OFF day does NOT travel: those days are off by
  // default in the standard rota pattern, not a consequence of the on-call.
  // Only weekday OFF days count as consequential rest that moves with the
  // shift. Multi-day on-call blocks that span weekends are unaffected because
  // those weekend dates are OC (in the block), not OFF (adjacent rest).
  Engine.prototype._annotateRest = function (label, block) {
    var offish = { OFF: 1, LTFT: 1, INACTIVE: 1 };
    var self = this;
    function isStandardWeekend(idx) {
      var d = self.data.dates[idx];
      return d && (d.wknd || d.bh);
    }
    var before = 0, i = block.start - 1;
    while (i >= 0 && offish[this.cell(label, i).s]) { before++; i--; }
    var after = 0, j = block.end + 1, n = this.data.dates.length;
    while (j < n && offish[this.cell(label, j).s]) { after++; j++; }
    block.offBefore = before; block.offAfter = after;
    block.len = block.idxs.length;

    // Only weekday OFFs travel — weekends/BH were off anyway.
    var rb = [], k = block.start - 1, CAP = 3;
    while (k >= 0 && this.cell(label, k).s === "OFF" && rb.length < CAP) {
      if (!isStandardWeekend(k)) rb.unshift(k);
      k--;
    }
    var ra = [], m = block.end + 1;
    while (m < n && this.cell(label, m).s === "OFF" && ra.length < CAP) {
      if (!isStandardWeekend(m)) ra.push(m);
      m++;
    }
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

  // Can `label` work a NEW shift on day `idx` of class `shiftCls`?
  // Returns {ok, reason}. Removed the soft "you'd be using a rest day"
  // warn — too noisy when the OFF is a standard weekend.
  Engine.prototype.freeToWork = function (label, idx, pref, shiftCls) {
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
    }
    // 48-hour post-nights rule: a non-NIGHT shift can't fall within 3 calendar
    // days of a NIGHT on-call. Thursday N1 (ends Fri 09:30) → earliest day/E/ward
    // shift is Monday. Saturday ward would be only ~22h post-nights, which is
    // too soon. NIGHT → NIGHT swaps are unaffected (rest pattern transfers).
    if (shiftCls && shiftCls !== "NIGHT") {
      for (var k = 1; k <= 3; k++) {
        var pc = this.cell(label, idx - k);
        if (pc.s === "OC" && shiftClass(pc.v) === "NIGHT") {
          return { ok: false, reason: "less than 48h after a night shift on " + this.data.dates[idx - k].iso + " — need at least 3 clear days" };
        }
      }
    }
    return { ok: true };
  };

  function equity(a, b) {
    return Math.abs(a.offBefore - b.offBefore)
         + Math.abs(a.offAfter - b.offAfter)
         + Math.abs(a.len - b.len) * 0.5;
  }

  // ---- merged-schedule placement validator --------------------------------
  // The critical safety layer. Checks whether `label` can legally hold the
  // schedule that results from ADDING the shifts in addList ([{idx, cls}])
  // and REMOVING the days in removeIdxs (a block they are giving away).
  // Validates the WHOLE merged schedule, not days in isolation, so a swap
  // can never create back-to-back on-call blocks that eat required rest.
  //
  // Hard rules (from the rota's working pattern):
  //  - A contiguous on-call run containing nights must be nights only —
  //    nights always have a rest day before and can't butt against other shifts.
  //  - Night runs are max 4, and need 2 clear days after (46h rest).
  //  - Weekend ward blocks (runs containing WARD) need 2 clear days after,
  //    a clear day immediately before, and a clear day 2 days before
  //    (unless that day is the person's LTFT day, when 1 day before suffices).
  // Soft rules (allowed, but warned and deprioritised):
  //  - New back-to-back on-call adjacency (e.g. day shift next to a day shift).
  //  - Working back-to-back weekends.
  //  - Another on-call in the same week (penalty only, no warning).
  Engine.prototype.assessPlacement = function (label, addList, removeIdxs, pref) {
    var self = this;
    var reasons = [], warnings = [], penalty = 0;

    // Per-day gate first (unavailability, LTFT, blocked, 48h post-nights…)
    for (var q = 0; q < addList.length; q++) {
      var f = this.freeToWork(label, addList[q].idx, pref, addList[q].cls);
      if (!f.ok) return { ok: false, reasons: ["can't take " + this.data.dates[addList[q].idx].iso + ": " + f.reason], warnings: [], penalty: 0 };
    }

    // Build the merged on-call map idx -> class
    var merged = {}, g = this.data.grid[label] || [];
    g.forEach(function (c, i) { if (c.s === "OC") merged[i] = shiftClass(c.v); });
    (removeIdxs || []).forEach(function (i) { delete merged[i]; });
    var addSet = {};
    addList.forEach(function (a) { merged[a.idx] = a.cls; addSet[a.idx] = 1; });

    // Contiguous runs over the merged schedule
    var idxs = Object.keys(merged).map(Number).sort(function (a, b) { return a - b; });
    var runs = [], cur = null;
    idxs.forEach(function (i) {
      if (cur && i === cur.end + 1) { cur.end = i; cur.days.push(i); }
      else { cur = { start: i, end: i, days: [i] }; runs.push(cur); }
    });

    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      // Only validate runs the swap actually touches (adds inside or adjacent);
      // pre-existing rota quirks aren't this swap's problem.
      var touched = run.days.some(function (i) { return addSet[i]; });
      if (!touched) continue;

      var classes = {}; run.days.forEach(function (i) { classes[merged[i]] = 1; });
      var hasNight = !!classes.NIGHT, hasWard = !!classes.WARD;

      if (hasNight) {
        if (Object.keys(classes).length > 1) {
          return { ok: false, reasons: ["would create on-call shifts immediately next to a night block — nights always need a rest day before and 46h rest after"], warnings: [], penalty: 0 };
        }
        if (run.days.length > 4) {
          return { ok: false, reasons: ["would mean more than 4 nights in a row"], warnings: [], penalty: 0 };
        }
        if (merged[run.end + 2] != null) {
          return { ok: false, reasons: ["less than 46h rest after the night block ending " + this.data.dates[run.end].iso], warnings: [], penalty: 0 };
        }
      }

      if (hasWard) {
        if (merged[run.end + 2] != null) {
          return { ok: false, reasons: ["weekend block needs two rest days after it — there's an on-call on " + this.data.dates[run.end + 2].iso], warnings: [], penalty: 0 };
        }
        // Rest day 2 days before block start (1 day before if the 2-days-before is their LTFT day)
        var pre2 = run.start - 2;
        if (pre2 >= 0 && merged[pre2] != null && this.cell(label, pre2).s !== "LTFT") {
          return { ok: false, reasons: ["weekend block needs a rest day two days before it — there's an on-call on " + this.data.dates[pre2].iso], warnings: [], penalty: 0 };
        }
      }
    }

    // Soft: new adjacency created by the added days (legal classes only reach here)
    var adjacencyWarned = false;
    addList.forEach(function (a) {
      [a.idx - 1, a.idx + 1].forEach(function (n) {
        if (merged[n] != null && !addSet[n] && !adjacencyWarned) {
          warnings.push("This would mean back-to-back on-call shifts (" + self.data.dates[Math.min(a.idx, n)].iso + " and " + self.data.dates[Math.max(a.idx, n)].iso + ")");
          penalty += 5;
          adjacencyWarned = true;
        }
      });
    });

    // Soft: back-to-back weekends
    function weekendOf(i) {
      // returns index of the Saturday of the weekend containing i, or null
      var d = self.data.dates[i]; if (!d) return null;
      if (d.dow === "Sat") return i;
      if (d.dow === "Sun") return i - 1;
      return null;
    }
    var addedWkndSats = {};
    addList.forEach(function (a) { var w = weekendOf(a.idx); if (w != null) addedWkndSats[w] = 1; });
    var wkndWarned = false;
    Object.keys(addedWkndSats).map(Number).forEach(function (sat) {
      if (wkndWarned) return;
      [sat - 7, sat + 7].forEach(function (adjSat) {
        if (wkndWarned) return;
        // any on-call in the merged schedule on the adjacent weekend?
        if (merged[adjSat] != null || merged[adjSat + 1] != null) {
          warnings.push("This would mean working back-to-back weekends");
          penalty += 4;
          wkndWarned = true;
        }
      });
    });

    // Soft: another on-call in the same working week (Mon–Sun), penalty only
    function weekKey(i) {
      var d = new Date(self.data.dates[i].iso + "T00:00:00");
      var day = (d.getDay() + 6) % 7; // Mon=0
      d.setDate(d.getDate() - day);
      return d.toISOString().slice(0, 10);
    }
    var addedWeeks = {}; addList.forEach(function (a) { addedWeeks[weekKey(a.idx)] = 1; });
    var sameWeekHit = false;
    idxs.forEach(function (i) {
      if (addSet[i] || sameWeekHit) return;
      if (addedWeeks[weekKey(i)]) { penalty += 2; sameWeekHit = true; }
    });

    return { ok: true, reasons: reasons, warnings: warnings, penalty: penalty };
  };

  function restMatches(a, b) {
    return a.restBeforeIdxs.length === b.restBeforeIdxs.length
        && a.restAfterIdxs.length === b.restAfterIdxs.length;
  }

  /* Core search.
     prefs: { label: { unavail:{idx:1}, wantedOff:{idx:1} } }
     If selIdxs spans multiple non-contiguous blocks of on-call, also runs
     each block independently and returns per-block matches. People most
     commonly swap one block at a time with whoever fits that block — they
     don't need a single partner to take everything. */
  Engine.prototype.findSwaps = function (reqLabel, selIdxs, unavail, prefs) {
    var combined = this._searchFor(reqLabel, selIdxs, unavail, prefs);
    if (combined.reqBlocks.length > 1) {
      // Independent per-block searches
      var self = this;
      combined.perBlock = combined.reqBlocks.map(function (b) {
        var r = self._searchFor(reqLabel, b.idxs, unavail, prefs);
        return { block: b, swaps: r.swaps, chains: r.chains, chainsReason: r.chainsReason, coverOnly: r.coverOnly };
      });
    }
    return combined;
  };

  Engine.prototype._searchFor = function (reqLabel, selIdxs, unavail, prefs) {
    unavail = unavail || {};
    prefs = prefs || {};
    var self = this;
    var sel = {}; selIdxs.forEach(function (i) { sel[i] = 1; });
    var reqBlocks = this.groupBlocks(reqLabel, selIdxs);
    var myWanted = (prefs[reqLabel] || {}).wantedOff || {};

    var swaps = [], coverOnly = [], ineligible = [];

    // The selected days as an addList (idx + class from the requester's grid)
    var selAdd = selIdxs.map(function (i) { return { idx: i, cls: shiftClass(self.cell(reqLabel, i).v) }; });

    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var cl = C.label;
      var cPref = (prefs[cl] || {}).unavail || null;
      var cWanted = (prefs[cl] || {}).wantedOff || null;
      var warnings = [], reasons = [];

      // INCOMING gate: could C take the selected days at all (cover-only case,
      // giving nothing away)? Full merged-schedule check — this is what
      // prevents e.g. handing someone a weekend ward right before their own
      // night block.
      var coverAssess = self.assessPlacement(cl, selAdd, [], cPref);
      if (!coverAssess.ok) { ineligible.push({ label: C.label, reasons: coverAssess.reasons }); return; }

      // RETURN: a compatible shift from C the requester can take
      var cBlocks = self.groupBlocks(cl, self.oncallShifts(cl).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.idxs.every(function (i) { return !sel[i]; }); });
      var assignments = [], allMatched = true;

      reqBlocks.forEach(function (rb) {
        var rbAdd = rb.idxs.map(function (i) { return { idx: i, cls: shiftClass(self.cell(reqLabel, i).v) }; });
        var best = null;
        cBlocks.forEach(function (cb) {
          if (cb.used || cb.cls !== rb.cls) return;
          if (cb.idxs.some(function (i) { return unavail[i]; })) return;

          var cbAdd = cb.idxs.map(function (i) { return { idx: i, cls: shiftClass(self.cell(cl, i).v) }; });

          // Requester side: their merged schedule after giving up ALL selected
          // days and taking this return block.
          var reqAssess = self.assessPlacement(reqLabel, cbAdd, selIdxs, null);
          if (!reqAssess.ok) return;

          // Candidate side: their merged schedule after taking this request
          // block and giving away this return block.
          var candAssess = self.assessPlacement(cl, rbAdd, cb.idxs, cPref);
          if (!candAssess.ok) return;

          var sc = equity(rb, cb) + reqAssess.penalty + candAssess.penalty;
          var mutualLeg = cb.idxs.some(function (i) { return myWanted[i]; });
          if (mutualLeg) sc -= 100; // dominate ordering
          if (!best || sc < best.sc) best = { cb: cb, sc: sc, mutualLeg: mutualLeg, warns: reqAssess.warnings.concat(candAssess.warnings) };
        });
        if (best) { best.cb.used = true; assignments.push({ rb: rb, cb: best.cb, sc: best.sc, mutualLeg: best.mutualLeg, warns: best.warns }); }
        else allMatched = false;
      });

      if (allMatched && assignments.length) {
        var score = 0;
        // Did C also flag the requester's selected dates as their wanted-off?
        var cMutualOnReq = cWanted && selIdxs.some(function (i) { return cWanted[i]; });
        assignments.forEach(function (a) {
          score += a.sc;
          (a.warns || []).forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });
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
        // Cover is legal (checked above) but no clean return shift exists.
        coverOnly.push({ label: C.label, grade: C.grade, dept: C.dept, warnings: coverAssess.warnings || [] });
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

    var chains = [], chainsReason = null;
    var B2B = "This would mean working back-to-back weekends";
    if (reqBlocks.length === 1) {
      if (!swaps.length) {
        // No direct swap at all — three-way is the fallback.
        chains = this._findChains(reqLabel, reqBlocks[0], sel, unavail, prefs);
        if (chains.length) chainsReason = "no-direct";
      } else if (swaps.every(function (s) { return s.warnings.indexOf(B2B) >= 0; })) {
        // Direct swaps exist but EVERY one would put someone on back-to-back
        // weekends. Look for a three-way route where nobody does — and only
        // offer chains that actually achieve that.
        chains = this._findChains(reqLabel, reqBlocks[0], sel, unavail, prefs)
          .filter(function (ch) { return ch.warnings.indexOf(B2B) < 0; });
        if (chains.length) chainsReason = "avoid-b2b";
      }
    }

    return { reqBlocks: reqBlocks, swaps: swaps, chains: chains, chainsReason: chainsReason, coverOnly: coverOnly, ineligible: ineligible };
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

  /* Three-way cyclic swap for a single request block. Each leg's merged
     schedule is validated with assessPlacement, same as direct swaps. */
  Engine.prototype._findChains = function (reqLabel, rb, sel, unavail, prefs) {
    var self = this, K = rb.cls, out = [], seen = {};

    function prefOf(l) { return (prefs[l] || {}).unavail || null; }
    function blocksOf(l) {
      return self.groupBlocks(l, self.oncallShifts(l).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.cls === K; });
    }
    function addListOf(owner, block) {
      return block.idxs.map(function (i) { return { idx: i, cls: shiftClass(self.cell(owner, i).v) }; });
    }
    var rbAdd = addListOf(reqLabel, rb);

    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var cPref = prefOf(C.label);

      var cBlocks = blocksOf(C.label).filter(function (b) { return b.idxs.every(function (i) { return !sel[i]; }); });

      cBlocks.forEach(function (cb) {
        var cbAdd = addListOf(C.label, cb);
        // C takes rb, gives cb — full merged check
        var cAssess = self.assessPlacement(C.label, rbAdd, cb.idxs, cPref);
        if (!cAssess.ok) return;

        self.data.staff.forEach(function (D) {
          if (!D.candidate || D.label === reqLabel || D.label === C.label) return;
          var dPref = prefOf(D.label);
          if (cb.idxs.some(function (i) { return sel[i]; })) return;

          var dBlocks = blocksOf(D.label).filter(function (b) {
            return b.idxs.every(function (i) { return !sel[i] && cb.idxs.indexOf(i) < 0; });
          });

          dBlocks.forEach(function (db) {
            if (db.idxs.some(function (i) { return unavail[i] || sel[i]; })) return;
            var dbAdd = addListOf(D.label, db);
            // D takes cb, gives db
            var dAssess = self.assessPlacement(D.label, cbAdd, db.idxs, dPref);
            if (!dAssess.ok) return;
            // Requester takes db, gives rb
            var rAssess = self.assessPlacement(reqLabel, dbAdd, rb.idxs, null);
            if (!rAssess.ok) return;

            var key = C.label + ">" + D.label + ":" + cb.start + ":" + db.start;
            if (seen[key]) return; seen[key] = 1;

            var score = equity(rb, cb) + equity(cb, db) + equity(db, rb)
                      + cAssess.penalty + dAssess.penalty + rAssess.penalty;
            var warnings = [];
            [cAssess, dAssess, rAssess].forEach(function (a) {
              a.warnings.forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });
            });
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
    rotaTeamEmail: "",     // optional, persisted in localStorage
    shiftFilter: "ALL",    // filter chip: ALL | NIGHT | DAY | WARD | E
    verifiedSlot: null,    // slot label confirmed by PIN this session
    admin: false           // ?admin=1 in URL enables admin banner + audit view
  };
  var allPrefs = {};
  var prefsMap = {};

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fmt(iso, dow) {
    var d = new Date(iso + "T00:00:00");
    // UK format with padded day (dd Mmm yyyy) for unambiguous display.
    var s = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    return (dow ? dow + " " : "") + s;
  }
  function fmtShort(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  }
  // Pure numeric dd/mm/yyyy for compact contexts
  function fmtNumeric(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB"); // returns dd/mm/yyyy
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
    AUDIT_CACHE: "rds_audit_cache",
    PENDING: "rds_prefs_pending",
    shared: false,
    auditLog: [],
    // Returns object of {label: {unavail, wantedOff, pinHash, updated}}; populates this.auditLog
    loadAll: function (slim) {
      var self = this;
      var url = this.ENDPOINT + (slim ? "?slim=1" : "");
      return fetch(url, { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("no backend"); return r.json(); })
        .then(function (j) {
          self.shared = true;
          // Shape-tolerant: current backend returns {prefs, audit}; an older
          // deployed function returns the flat prefs map directly. Reading
          // the wrong shape here made saved prefs silently vanish on other
          // devices, so accept both.
          var prefs, audit;
          if (j && j.prefs !== undefined) { prefs = j.prefs || {}; audit = j.audit || []; }
          else { prefs = j || {}; audit = []; }
          // Reconcile: if this device has prefs that never reached the server
          // (saved while offline / backend briefly down), push them up now
          // rather than letting the server copy silently win.
          try {
            var pending = JSON.parse(localStorage.getItem(self.PENDING) || "{}");
            Object.keys(pending).forEach(function (lbl) {
              prefs[lbl] = pending[lbl];
              self.save(lbl, pending[lbl]); // re-attempt upload
            });
          } catch (e) {}
          try { localStorage.setItem(self.CACHE, JSON.stringify(prefs)); } catch (e) {}
          try { localStorage.setItem(self.AUDIT_CACHE, JSON.stringify(audit)); } catch (e) {}
          self.auditLog = audit;
          return prefs;
        })
        .catch(function () {
          self.shared = false;
          try { self.auditLog = JSON.parse(localStorage.getItem(self.AUDIT_CACHE) || "[]"); } catch (e) { self.auditLog = []; }
          try { return JSON.parse(localStorage.getItem(self.CACHE) || "{}"); } catch (e) { return {}; }
        });
    },
    save: function (label, prefs) {
      var self = this;
      // optimistic local cache update so it survives a reload either way
      try {
        var all = JSON.parse(localStorage.getItem(self.CACHE) || "{}");
        all[label] = prefs;
        localStorage.setItem(self.CACHE, JSON.stringify(all));
      } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label, prefs: prefs })
      }).then(function (r) {
        self.shared = r.ok;
        try {
          var pending = JSON.parse(localStorage.getItem(self.PENDING) || "{}");
          if (r.ok) delete pending[label]; else pending[label] = prefs;
          localStorage.setItem(self.PENDING, JSON.stringify(pending));
        } catch (e) {}
        return r.ok;
      })
        .catch(function () { self.shared = false; return false; });
    },
    setPin: function (label, pinHash) {
      var self = this;
      // update local cache so the verify flow works offline
      try {
        var all = JSON.parse(localStorage.getItem(self.CACHE) || "{}");
        all[label] = all[label] || {};
        all[label].pinHash = pinHash;
        localStorage.setItem(self.CACHE, JSON.stringify(all));
      } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label, pinHash: pinHash })
      }).then(function (r) { self.shared = r.ok; return r.ok; })
        .catch(function () { self.shared = false; return false; });
    },
    logEvent: function (event) {
      var self = this;
      // also append to local audit cache so it shows up immediately
      var entry = Object.assign({ ts: new Date().toISOString() }, event);
      self.auditLog.unshift(entry);
      if (self.auditLog.length > 500) self.auditLog.length = 500;
      try { localStorage.setItem(self.AUDIT_CACHE, JSON.stringify(self.auditLog)); } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: event })
      }).then(function (r) { return r.ok; })
        .catch(function () { return false; });
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
      state.shiftFilter = "ALL";
      state.verifiedSlot = null; // require fresh PIN when switching slots
      renderPerson();
      renderUnavail();
      renderLoginBadge();
      updateRestartVis();
      // Refresh from the shared store so seeded data is up-to-date and we can
      // check whether anyone is currently looking for one of this person's shifts.
      Store.loadAll().then(function (j) {
        allPrefs = j || {}; rebuildPrefsMap();
        seedUnavailFromPrefs();
        renderMutualBanner();
        renderPerson();
        // Trigger PIN modal once we know whether this slot has set a PIN before
        if (state.person) openPinModal();
      });
    });
  })();

  // ---- back / start again --------------------------------------------------
  // Resets the whole flow to the slot picker (reuses the picker's own change
  // handler for a full state reset) and scrolls back to the top.
  function resetToStart() {
    var sel = $("#person");
    sel.value = "";
    sel.dispatchEvent(new Event("change"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $("#restart").addEventListener("click", resetToStart);
  $("#restart-float").addEventListener("click", resetToStart);

  // Inline button shows whenever a slot is picked; the floating pill only
  // once you've scrolled away from the picker (that's when you need it).
  function updateRestartVis() {
    $("#restart").classList.toggle("hide", !state.person);
    var showFloat = !!state.person && window.scrollY > 350;
    $("#restart-float").classList.toggle("hide", !showFloat);
  }
  window.addEventListener("scroll", updateRestartVis, { passive: true });

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

    // Hide blocks entirely in the past — passed shifts can't be swapped.
    var todayIso = isoFromDate(new Date());
    blocks = blocks.filter(function (b) {
      var lastIso = data.dates[b.end].iso;
      return lastIso >= todayIso;
    });

    if (!blocks.length) {
      wrap.appendChild(el("p", "empty", "No upcoming swappable on-call shifts in the rota period."));
      $("#shift-filter").classList.add("hide");
      return;
    }

    // Render shift-class filter chips (only if there's more than one class)
    var classCounts = { NIGHT: 0, DAY: 0, WARD: 0, E: 0 };
    blocks.forEach(function (b) { classCounts[b.cls] = (classCounts[b.cls] || 0) + 1; });
    var classes = Object.keys(classCounts).filter(function (k) { return classCounts[k] > 0; });
    var filterWrap = $("#shift-filter"); filterWrap.innerHTML = "";
    if (classes.length > 1) {
      filterWrap.classList.remove("hide");
      var labels = { NIGHT: "Nights", DAY: "Days", WARD: "Ward", E: "Evening (E)" };
      var allChip = el("button", "filter-chip" + (state.shiftFilter === "ALL" ? " active" : ""), "All");
      allChip.dataset.cls = "ALL";
      allChip.appendChild(el("span", "filter-chip-count", String(blocks.length)));
      filterWrap.appendChild(allChip);
      classes.forEach(function (cls) {
        var chip = el("button", "filter-chip" + (state.shiftFilter === cls ? " active" : ""), labels[cls] || cls);
        chip.dataset.cls = cls;
        chip.appendChild(el("span", "filter-chip-count", String(classCounts[cls])));
        filterWrap.appendChild(chip);
      });
      filterWrap.querySelectorAll(".filter-chip").forEach(function (c) {
        c.addEventListener("click", function () {
          state.shiftFilter = c.dataset.cls;
          renderPerson();
        });
      });
    } else {
      filterWrap.classList.add("hide");
    }

    var filtered = state.shiftFilter && state.shiftFilter !== "ALL"
      ? blocks.filter(function (b) { return b.cls === state.shiftFilter; })
      : blocks;

    filtered.forEach(function (b) {
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
      var beforeTxt = b.offBefore + " rest day" + (b.offBefore === 1 ? "" : "s") + " before";
      var afterTxt = b.offAfter + " rest day" + (b.offAfter === 1 ? "" : "s") + " after";
      rest.textContent = beforeTxt + " · " + afterTxt;
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

  // ---- calendar picker (multi-day + range modes) ------------------------
  var Cal = {
    mode: "single",           // "single" or "range"
    viewMonth: null,          // Date set to 1st of currently-shown month
    pending: {},              // {iso:1} - dates selected in this session, not yet saved
    rangeStart: null          // iso, set on first click in range mode
  };

  function isoFromDate(d) {
    var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }
  function ymOfIso(iso) { return iso.slice(0, 7); }
  function clampMonth(d) {
    // clamp to rota range; return Date at start of that month or null if out of range
    var first = new Date(d.getFullYear(), d.getMonth(), 1);
    var lastValid = new Date(data.dateEnd + "T00:00:00");
    var firstValid = new Date(data.dateStart + "T00:00:00");
    var endMonth = new Date(lastValid.getFullYear(), lastValid.getMonth(), 1);
    var startMonth = new Date(firstValid.getFullYear(), firstValid.getMonth(), 1);
    if (first < startMonth) return startMonth;
    if (first > endMonth) return endMonth;
    return first;
  }

  (function initCalendar() {
    // initial month = first rota month
    Cal.viewMonth = new Date(data.dateStart + "T00:00:00");
    Cal.viewMonth = new Date(Cal.viewMonth.getFullYear(), Cal.viewMonth.getMonth(), 1);

    // mode toggle
    document.querySelectorAll(".cal-mode").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".cal-mode").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        Cal.mode = b.dataset.mode;
        Cal.rangeStart = null;
        renderCalendar();
        updateCalHelp();
      });
    });

    $("#cal-prev").addEventListener("click", function () {
      var d = new Date(Cal.viewMonth.getFullYear(), Cal.viewMonth.getMonth() - 1, 1);
      var c = clampMonth(d); if (c) { Cal.viewMonth = c; renderCalendar(); }
    });
    $("#cal-next").addEventListener("click", function () {
      var d = new Date(Cal.viewMonth.getFullYear(), Cal.viewMonth.getMonth() + 1, 1);
      var c = clampMonth(d); if (c) { Cal.viewMonth = c; renderCalendar(); }
    });

    $("#cal-clear-pending").addEventListener("click", function () {
      Cal.pending = {}; Cal.rangeStart = null;
      renderCalendar(); renderPending();
    });
    $("#cal-save-pending").addEventListener("click", function () {
      var pendingList = Object.keys(Cal.pending).sort();
      if (!pendingList.length) return;
      // collapse contiguous ISO dates into ranges (matches existing seedUnavail logic)
      var ranges = [];
      var cur = { start: pendingList[0], end: pendingList[0] };
      for (var i = 1; i < pendingList.length; i++) {
        var prevI = idxOfIso(cur.end), nextI = idxOfIso(pendingList[i]);
        if (prevI != null && nextI === prevI + 1) cur.end = pendingList[i];
        else { ranges.push(cur); cur = { start: pendingList[i], end: pendingList[i] }; }
      }
      ranges.push(cur);
      // merge with existing state.unavailRanges
      ranges.forEach(function (r) { state.unavailRanges.push(r); });
      Cal.pending = {}; Cal.rangeStart = null;
      persistRangesToPrefs();
      renderCalendar(); renderPending(); renderUnavail();
    });

    updateCalHelp();
    renderCalendar();
  })();

  function updateCalHelp() {
    var t = $("#cal-help-text");
    if (Cal.mode === "single") {
      t.textContent = "Tap any days you can’t take a swap onto. Tap again to unselect.";
    } else {
      t.textContent = Cal.rangeStart
        ? "Now tap the end of the range."
        : "Tap the first day of the range, then the last.";
    }
  }

  function savedDatesSet() {
    // Dates already SAVED as unavailable (existing committed selections)
    var set = {};
    state.unavailRanges.forEach(function (r) {
      var s = idxOfIso(r.start), e = idxOfIso(r.end);
      if (s == null || e == null) return;
      if (s > e) { var t = s; s = e; e = t; }
      for (var i = s; i <= e; i++) set[isoOfIdx(i)] = 1;
    });
    return set;
  }

  function renderCalendar() {
    var grid = $("#cal-grid"); grid.innerHTML = "";
    var year = Cal.viewMonth.getFullYear(), month = Cal.viewMonth.getMonth();
    var first = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0).getDate();
    // Monday-first weekday index
    var firstWd = (first.getDay() + 6) % 7;
    $("#cal-month-label").textContent = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    // prev/next disabled when at extremes
    var minMonth = new Date(data.dateStart + "T00:00:00");
    var maxMonth = new Date(data.dateEnd + "T00:00:00");
    $("#cal-prev").disabled = (year === minMonth.getFullYear() && month === minMonth.getMonth())
      || (new Date(year, month, 1) < new Date(minMonth.getFullYear(), minMonth.getMonth(), 1));
    $("#cal-next").disabled = (year === maxMonth.getFullYear() && month === maxMonth.getMonth())
      || (new Date(year, month, 1) > new Date(maxMonth.getFullYear(), maxMonth.getMonth(), 1));

    var saved = savedDatesSet();
    var today = isoFromDate(new Date());
    for (var p = 0; p < firstWd; p++) {
      var b = el("button", "cal-day cal-empty"); b.type = "button"; b.disabled = true; grid.appendChild(b);
    }
    for (var d = 1; d <= lastDay; d++) {
      var iso = isoFromDate(new Date(year, month, d));
      var idx = idxOfIso(iso);
      var btn = el("button", "cal-day"); btn.type = "button"; btn.textContent = d;
      var inRange = (idx != null);
      var dayDate = new Date(year, month, d);
      var isWknd = dayDate.getDay() === 0 || dayDate.getDay() === 6;
      if (isWknd) btn.classList.add("cal-wknd");
      if (!inRange) btn.classList.add("cal-outside");
      if (iso === today) btn.classList.add("cal-today");
      if (saved[iso]) btn.classList.add("cal-saved");
      if (Cal.pending[iso]) btn.classList.add("cal-pending");
      // range preview
      if (Cal.mode === "range" && Cal.rangeStart && !Cal.pending[iso]) {
        if (iso === Cal.rangeStart) btn.classList.add("cal-range-start");
      }
      if (inRange) {
        (function (iso) {
          btn.addEventListener("click", function () { onDayClick(iso); });
        })(iso);
      } else {
        btn.disabled = true;
      }
      grid.appendChild(btn);
    }
  }

  function onDayClick(iso) {
    var saved = savedDatesSet();
    if (saved[iso]) {
      // Already saved — tapping a saved date removes it from the saved list
      // (people get a quick way to unflag a date that's already stored).
      removeSavedDate(iso);
      return;
    }
    if (Cal.mode === "single") {
      if (Cal.pending[iso]) delete Cal.pending[iso];
      else Cal.pending[iso] = 1;
      renderCalendar(); renderPending();
    } else {
      // range mode
      if (!Cal.rangeStart) {
        Cal.rangeStart = iso;
        updateCalHelp(); renderCalendar();
      } else {
        var s = Cal.rangeStart, e = iso;
        if (s > e) { var t = s; s = e; e = t; }
        var si = idxOfIso(s), ei = idxOfIso(e);
        if (si != null && ei != null) {
          for (var i = si; i <= ei; i++) Cal.pending[isoOfIdx(i)] = 1;
        }
        Cal.rangeStart = null;
        updateCalHelp(); renderCalendar(); renderPending();
      }
    }
  }

  function removeSavedDate(iso) {
    // Split any existing range that contains this date so the date is dropped
    var idx = idxOfIso(iso); if (idx == null) return;
    var next = [];
    state.unavailRanges.forEach(function (r) {
      var rs = idxOfIso(r.start), re = idxOfIso(r.end);
      if (rs == null || re == null) { next.push(r); return; }
      if (rs > re) { var t = rs; rs = re; re = t; }
      if (idx < rs || idx > re) { next.push(r); return; }
      // split
      if (idx > rs) next.push({ start: isoOfIdx(rs), end: isoOfIdx(idx - 1) });
      if (idx < re) next.push({ start: isoOfIdx(idx + 1), end: isoOfIdx(re) });
    });
    state.unavailRanges = next;
    persistRangesToPrefs();
    renderCalendar(); renderUnavail();
  }

  function renderPending() {
    var p = $("#cal-pending"); p.innerHTML = "";
    var count = Object.keys(Cal.pending).length;
    var btn = $("#cal-save-pending");
    if (!count) {
      btn.disabled = true; btn.textContent = "Save selection";
      return;
    }
    btn.disabled = false;
    btn.textContent = "Save " + count + (count === 1 ? " date" : " dates");
    p.textContent = count + (count === 1 ? " date selected" : " dates selected") + " — not yet saved";
  }

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
    var sorted = (isoList || []).slice().sort();
    var p = {
      unavail: prev.unavail || [],
      wantedOff: sorted,
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[state.person] = p;
    rebuildPrefsMap();
    // Audit: was something added or cleared?
    if (sorted.length) {
      Store.logEvent({ slot: state.person, action: "publish_wanted", dates: sorted });
    } else if ((prev.wantedOff || []).length) {
      Store.logEvent({ slot: state.person, action: "clear_wanted" });
    }
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

    var multi = res.perBlock && res.perBlock.length > 1;

    if (multi) {
      // Per-block matching is the primary view — no explainer needed,
      // people know how swaps work.
      res.perBlock.forEach(function (pb) {
        root.appendChild(perBlockSection(pb));
      });

      // Combined fallback: only show if there's at least one one-person-handles-all match
      if (res.swaps.length) {
        var combo = el("details", "combined-fallback");
        var sum = el("summary", null,
          "Or one person for everything (" + res.swaps.length +
          (res.swaps.length === 1 ? " option" : " options") + ")");
        combo.appendChild(sum);
        var mutuals = res.swaps.filter(function (s) { return s.mutual; });
        var others = res.swaps.filter(function (s) { return !s.mutual; });
        if (mutuals.length) {
          combo.appendChild(el("h4", "res-subh mutual-h", "Mutual — both of you are looking"));
          mutuals.slice(0, 3).forEach(function (sw) { combo.appendChild(swapCard(sw, false)); });
        }
        if (others.length) {
          combo.appendChild(el("h4", "res-subh", mutuals.length ? "Other" : "Direct swaps"));
          others.slice(0, 5).forEach(function (sw) { combo.appendChild(swapCard(sw, false)); });
        }
        root.appendChild(combo);
      }
    } else {
      // Single-block view
      var mutualSwaps = res.swaps.filter(function (s) { return s.mutual; });
      var otherSwaps = res.swaps.filter(function (s) { return !s.mutual; });

      // When every direct swap means back-to-back weekends, the three-way
      // routes that avoid it are the better recommendation — show them first.
      if (res.chainsReason === "avoid-b2b" && res.chains.length) {
        var nb = el("div", "card note");
        nb.appendChild(el("strong", null, "Every direct swap here means someone working back-to-back weekends."));
        nb.appendChild(el("p", null, "These three-way swaps get you the same dates off without anyone working consecutive weekends."));
        root.appendChild(nb);
        root.appendChild(el("h3", "res-h", "Three-way swaps — no back-to-back weekends"));
        res.chains.slice(0, 5).forEach(function (ch, i) { root.appendChild(chainCard(ch, i === 0)); });
      }

      if (mutualSwaps.length) {
        root.appendChild(el("h3", "res-h mutual-h", "Mutual swap — both of you are looking"));
        mutualSwaps.slice(0, 5).forEach(function (sw, i) { root.appendChild(swapCard(sw, i === 0 && res.chainsReason !== "avoid-b2b")); });
      }

      if (otherSwaps.length) {
        root.appendChild(el("h3", "res-h", mutualSwaps.length ? "Other direct swaps" : "Direct swaps"));
        otherSwaps.slice(0, 8).forEach(function (sw, i) { root.appendChild(swapCard(sw, i === 0 && !mutualSwaps.length && res.chainsReason !== "avoid-b2b")); });
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

      if (res.chains && res.chains.length && res.chainsReason !== "avoid-b2b") {
        root.appendChild(el("h3", "res-h", "Three-way swaps"));
        res.chains.slice(0, 5).forEach(function (ch, i) { root.appendChild(chainCard(ch, !res.swaps.length && i === 0)); });
      }

      if (res.coverOnly.length) {
        root.appendChild(el("h3", "res-h", "Could cover (no return shift)"));
        res.coverOnly.slice(0, 6).forEach(function (c) { root.appendChild(coverCard(c)); });
      }
    }

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

  // Renders a section per requested block when multiple blocks were selected.
  // Each section shows that block plus its own ranked partners.
  function perBlockSection(pb) {
    var wrap = el("div", "perblock");
    var header = el("div", "perblock-header");
    var label = el("div", "perblock-label");
    label.appendChild(el("span", "perblock-kicker", "Block"));
    pb.block.idxs.forEach(function (i) {
      var p = el("span", "perblock-pill");
      p.appendChild(chip(engine.cell(state.person, i).v));
      p.appendChild(el("span", null, fmtShort(data.dates[i].iso)));
      label.appendChild(p);
    });
    header.appendChild(label);
    wrap.appendChild(header);

    var mutuals = pb.swaps.filter(function (s) { return s.mutual; });
    var others = pb.swaps.filter(function (s) { return !s.mutual; });

    // If every direct swap for this block means back-to-back weekends,
    // lead with the three-way routes that avoid it.
    var avoidB2b = pb.chainsReason === "avoid-b2b" && pb.chains && pb.chains.length;
    if (avoidB2b) {
      wrap.appendChild(el("p", "perblock-note", "Every direct swap for this block means back-to-back weekends — these three-way swaps avoid that:"));
      pb.chains.slice(0, 3).forEach(function (ch, i) { wrap.appendChild(chainCard(ch, i === 0)); });
    }

    if (mutuals.length) {
      mutuals.slice(0, 3).forEach(function (sw, i) { wrap.appendChild(swapCard(sw, i === 0 && !avoidB2b)); });
    }
    if (others.length) {
      others.slice(0, 5).forEach(function (sw, i) {
        wrap.appendChild(swapCard(sw, !mutuals.length && i === 0 && !avoidB2b));
      });
    }
    if (!pb.swaps.length) {
      if (pb.chains && pb.chains.length && !avoidB2b) {
        wrap.appendChild(el("p", "perblock-note", "No direct two-way swap for this block — see three-way options below."));
        pb.chains.slice(0, 3).forEach(function (ch, i) { wrap.appendChild(chainCard(ch, i === 0)); });
      } else if (pb.coverOnly && pb.coverOnly.length) {
        wrap.appendChild(el("p", "perblock-note", "No clean swap — these people could cover but with no return shift."));
        pb.coverOnly.slice(0, 3).forEach(function (c) { wrap.appendChild(coverCard(c)); });
      } else if (!avoidB2b) {
        wrap.appendChild(el("p", "perblock-note", "No match found for this block."));
      }
    }
    return wrap;
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
    var lines = [];
    if (opts.kind === "direct") {
      lines.push("Hi (name),");
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
      lines.push("(name)");
      return {
        subject: "On-call swap request",
        body: lines.join("\n"),
        to: ""
      };
    } else {
      var ch = opts.chain;
      lines.push("Hi both,");
      lines.push("");
      lines.push("Putting you both on the same email — the swap shop's suggested a three-way swap that works for all of us:");
      lines.push("");
      lines.push("• (name) takes my " + CLASS_LABEL[ch.rb.cls] + " — " + emailDates(ch.rb.idxs));
      lines.push("• (name) takes their " + CLASS_LABEL[ch.cb.cls] + " — " + emailDates(ch.cb.idxs));
      lines.push("• I take the " + CLASS_LABEL[ch.db.cls] + " — " + emailDates(ch.db.idxs));
      lines.push("");
      lines.push("Everyone keeps the same number of on-calls. If you're both happy, let me know and we'll send it to the rota team.");
      lines.push("");
      lines.push("Thanks,");
      lines.push("(name)");
      return {
        subject: "Three-way on-call swap",
        body: lines.join("\n"),
        to: ""
      };
    }
  }

  function buildConfirmEmail(opts) {
    var lines = [];
    if (opts.kind === "direct") {
      lines.push("Hi,");
      lines.push("");
      lines.push("Please could you action the following on-call swap that (name) and I have agreed to:");
      lines.push("");
      opts.assignments.forEach(function (a) {
        var cls = CLASS_LABEL[a.rb.cls];
        lines.push("• (name) takes my " + cls + ": " + emailDates(a.rb.idxs));
        lines.push("• I take their " + cls + ": " + emailDates(a.cb.idxs));
      });
      lines.push("");
      lines.push("Thanks,");
      lines.push("(name)");
      return {
        subject: "On-call swap to action",
        body: lines.join("\n"),
        to: state.rotaTeamEmail || ""
      };
    } else {
      var ch = opts.chain;
      lines.push("Hi,");
      lines.push("");
      lines.push("Please could you action the following three-way on-call swap that (name), (name) and I have agreed to:");
      lines.push("");
      lines.push("• (name) takes my " + CLASS_LABEL[ch.rb.cls] + ": " + emailDates(ch.rb.idxs));
      lines.push("• (name) takes their " + CLASS_LABEL[ch.cb.cls] + ": " + emailDates(ch.cb.idxs));
      lines.push("• I take the " + CLASS_LABEL[ch.db.cls] + ": " + emailDates(ch.db.idxs));
      lines.push("");
      lines.push("Thanks,");
      lines.push("(name)");
      return {
        subject: "Three-way on-call swap to action",
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
    $("#email-modal")._opts = opts;
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
    var btn = $("#email-copy");
    function flashBtn(msg) {
      var t = btn.textContent; btn.textContent = msg;
      setTimeout(function () { btn.textContent = t; }, 1500);
    }
    // Fallback path: select-and-copy via a temporary textarea. Works on
    // browsers where the async Clipboard API silently rejects.
    function legacyCopy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length); // iOS needs the explicit range
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) { flashBtn("Copied"); return true; }
      } catch (e) {}
      // Last resort: select the visible body so the user can copy manually
      var body = $("#email-body");
      body.focus(); body.select();
      try { body.setSelectionRange(0, body.value.length); } catch (e) {}
      flashBtn("Press copy on your keyboard");
      return false;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { flashBtn("Copied"); })
        .catch(function () { legacyCopy(); });
    } else {
      legacyCopy();
    }
  });
  $("#email-open").addEventListener("click", function () {
    var to = encodeURIComponent($("#email-to").value || "");
    var subject = encodeURIComponent($("#email-subject").value);
    var body = encodeURIComponent($("#email-body").value);
    var kind = $("#email-modal").dataset.kind;
    if (kind === "confirm" && $("#email-to").value) {
      try { localStorage.setItem("rds_rota_email", $("#email-to").value); state.rotaTeamEmail = $("#email-to").value; } catch (e) {}
    }
    // Audit log: who drafted what email
    if (state.person) {
      var opts = $("#email-modal")._opts || {};
      var dates = [];
      if (opts.assignments) {
        opts.assignments.forEach(function (a) {
          a.rb.idxs.forEach(function (i) { dates.push(data.dates[i].iso); });
        });
      } else if (opts.chain) {
        opts.chain.rb.idxs.forEach(function (i) { dates.push(data.dates[i].iso); });
      }
      Store.logEvent({
        slot: state.person,
        action: kind === "ask" ? "draft_ask_email" : "draft_rota_email",
        partnerSlot: opts.partnerLabel || (opts.chain && opts.chain.C && opts.chain.C.label) || null,
        dates: dates,
        kind: opts.kind || (opts.chain ? "chain" : "direct")
      });
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

  // ---- PIN-based login (per-slot, 4 digits, salted-hashed) ----------------
  function sha256Hex(s) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function pinHashFor(slot, pin) { return sha256Hex("rds:" + slot + ":" + pin); }

  function openPinModal() {
    if (!state.person) return;
    var slot = state.person;
    if (state.verifiedSlot === slot) return; // already verified this session

    // Already remembered on this device?
    try {
      var rem = localStorage.getItem("rds_verified_" + slot);
      if (rem === "1") {
        state.verifiedSlot = slot;
        renderLoginBadge();
        return;
      }
    } catch (e) {}

    var entry = allPrefs[slot] || {};
    var firstTime = !entry.pinHash;
    var m = $("#pin-modal");
    $("#pin-modal-title").textContent = firstTime
      ? "Set a PIN for Slot " + slot
      : "PIN for Slot " + slot;
    $("#pin-help").textContent = firstTime
      ? "Pick a 4-digit PIN. You'll enter it next time you use this slot on a new device."
      : "Enter the 4-digit PIN you set for this slot.";
    $("#pin-input").value = "";
    $("#pin-confirm").value = "";
    $("#pin-confirm-row").classList.toggle("hide", !firstTime);
    $("#pin-msg").textContent = "";
    $("#pin-submit").textContent = firstTime ? "Set PIN" : "Log in";
    m._firstTime = firstTime;
    m.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(function () { $("#pin-input").focus(); }, 100);
  }
  function closePinModal() {
    $("#pin-modal").classList.remove("open");
    document.body.style.overflow = "";
  }
  function pinError(msg) {
    var n = $("#pin-msg"); n.textContent = msg;
  }

  if ($("#pin-modal")) {
    $("#pin-cancel").addEventListener("click", function () {
      // Cancel: reset person picker so they can re-pick. They can browse but
      // actions are gated.
      closePinModal();
    });
    $("#pin-modal").addEventListener("click", function (e) {
      if (e.target === $("#pin-modal")) closePinModal();
    });
    $("#pin-submit").addEventListener("click", function () { handlePinSubmit(); });
    $("#pin-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") handlePinSubmit();
    });
    $("#pin-confirm").addEventListener("keydown", function (e) {
      if (e.key === "Enter") handlePinSubmit();
    });
  }

  function handlePinSubmit() {
    var m = $("#pin-modal");
    var slot = state.person; if (!slot) return;
    var pin = ($("#pin-input").value || "").trim();
    if (!/^\d{4}$/.test(pin)) { pinError("PIN must be 4 digits."); return; }
    if (m._firstTime) {
      var confirm = ($("#pin-confirm").value || "").trim();
      if (pin !== confirm) { pinError("PINs don't match."); return; }
      $("#pin-submit").disabled = true;
      pinHashFor(slot, pin).then(function (hash) {
        return Store.setPin(slot, hash).then(function (ok) {
          $("#pin-submit").disabled = false;
          if (!ok && !Store.shared) {
            // Backend unreachable — keep the local cache but warn the user
            pinError("PIN saved locally — shared store unreachable, PIN won't transfer to other devices.");
          }
          // Update local prefs cache
          allPrefs[slot] = allPrefs[slot] || {};
          allPrefs[slot].pinHash = hash;
          rebuildPrefsMap();
          state.verifiedSlot = slot;
          try { localStorage.setItem("rds_verified_" + slot, "1"); } catch (e) {}
          Store.logEvent({ slot: slot, action: "pin_set" });
          Store.logEvent({ slot: slot, action: "login" });
          closePinModal();
          renderLoginBadge();
          renderAdminBanner();
        });
      });
    } else {
      // Verify against stored hash
      $("#pin-submit").disabled = true;
      pinHashFor(slot, pin).then(function (hash) {
        $("#pin-submit").disabled = false;
        var entry = allPrefs[slot] || {};
        if (entry.pinHash && entry.pinHash === hash) {
          state.verifiedSlot = slot;
          try { localStorage.setItem("rds_verified_" + slot, "1"); } catch (e) {}
          Store.logEvent({ slot: slot, action: "login" });
          closePinModal();
          renderLoginBadge();
          renderAdminBanner();
        } else {
          pinError("Wrong PIN. If you've forgotten it, contact your rota team to reset.");
        }
      });
    }
  }

  function renderLoginBadge() {
    var el0 = $("#login-badge"); if (!el0) return;
    if (!state.person) { el0.classList.add("hide"); return; }
    el0.classList.remove("hide");
    el0.innerHTML = "";
    var dot = el("span", "login-dot");
    el0.appendChild(dot);
    if (state.verifiedSlot === state.person) {
      el0.className = "login-badge";
      el0.appendChild(el("span", null, "Slot " + state.person + " · verified"));
      var btn = el("button", null, "Log out");
      btn.addEventListener("click", function () {
        try { localStorage.removeItem("rds_verified_" + state.person); } catch (e) {}
        state.verifiedSlot = null;
        Store.logEvent({ slot: state.person, action: "logout" });
        renderLoginBadge();
      });
      el0.appendChild(btn);
    } else {
      el0.className = "login-badge unverified";
      el0.appendChild(el("span", null, "Slot " + state.person + " · not verified"));
      var bv = el("button", null, "Log in");
      bv.addEventListener("click", openPinModal);
      el0.appendChild(bv);
    }
  }

  // ---- admin mode (URL flag) ----------------------------------------------
  state.admin = new URLSearchParams(window.location.search).get("admin") === "1";

  function renderAdminBanner() {
    var wrap = $("#admin-banner"); if (!wrap) return;
    if (!state.admin) { wrap.classList.add("hide"); return; }
    wrap.classList.remove("hide");
    var todayIso = isoFromDate(new Date());
    var endIso = data.dateEnd;
    var daysLeft = Math.round((new Date(endIso + "T00:00:00") - new Date(todayIso + "T00:00:00")) / 86400000);

    // Stats
    var distinctVerified = {};
    Store.auditLog.forEach(function (e) { if (e.action === "login") distinctVerified[e.slot] = 1; });
    var distinctActed = {};
    Store.auditLog.forEach(function (e) { if (e.action === "draft_rota_email" || e.action === "draft_ask_email") distinctActed[e.slot] = 1; });

    wrap.innerHTML = "";
    wrap.appendChild(el("div", "step-num", "Admin"));
    wrap.appendChild(el("div", "admin-title", "Rota administration"));
    var body = el("div", "admin-body");
    if (daysLeft < 0) body.appendChild(el("p", null, "This rota ended " + (-daysLeft) + " days ago. Drop in the new spreadsheet to refresh data.js."));
    else if (daysLeft <= 28) body.appendChild(el("p", null, "This rota ends in " + daysLeft + " days. Time to ask for the next one."));
    else body.appendChild(el("p", null, "Rota ends " + fmt(endIso) + " (" + daysLeft + " days away)."));
    wrap.appendChild(body);

    var stats = el("div", "admin-stats");
    function addStat(num, label) {
      var s = el("div", "admin-stat");
      s.appendChild(el("strong", null, String(num)));
      s.appendChild(el("span", null, label));
      stats.appendChild(s);
    }
    addStat(Object.keys(distinctVerified).length, "Verified slots");
    addStat(Object.keys(distinctActed).length, "Active swappers");
    addStat(Store.auditLog.length, "Events logged");
    wrap.appendChild(stats);

    var auditBtn = el("button", "admin-btn", "View audit log");
    auditBtn.addEventListener("click", function () { openAuditModal(); });
    wrap.appendChild(auditBtn);
  }

  function openAuditModal() {
    var m = $("#audit-modal"); if (!m) return;
    var list = $("#audit-list"); list.innerHTML = "";
    var entries = Store.auditLog.slice(0, 200);
    if (!entries.length) {
      list.appendChild(el("p", "empty", "No audit events recorded yet."));
    } else {
      entries.forEach(function (e) {
        var row = el("div", "audit-row");
        row.appendChild(el("span", "audit-time", fmtAuditTime(e.ts)));
        row.appendChild(el("span", "audit-slot", "Slot " + e.slot));
        row.appendChild(el("span", "audit-action", actionLabel(e.action)));
        if (e.partnerSlot) row.appendChild(el("span", null, "↔ Slot " + e.partnerSlot));
        if (e.dates && e.dates.length) {
          var d = el("span", null, e.dates.map(function (x) { return fmtShort(x); }).join(", "));
          d.style.color = "var(--muted)"; d.style.fontSize = ".78rem";
          row.appendChild(d);
        }
        list.appendChild(row);
      });
    }
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function actionLabel(a) {
    var m = {
      login: "logged in",
      logout: "logged out",
      pin_set: "set PIN",
      publish_wanted: "published wanted-off",
      clear_wanted: "cleared wanted-off",
      draft_ask_email: "drafted partner email",
      draft_rota_email: "drafted rota email"
    };
    return m[a] || a;
  }
  function fmtAuditTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  if ($("#audit-close")) {
    $("#audit-close").addEventListener("click", function () {
      $("#audit-modal").classList.remove("open");
      document.body.style.overflow = "";
    });
    $("#audit-modal").addEventListener("click", function (e) {
      if (e.target === $("#audit-modal")) {
        $("#audit-modal").classList.remove("open");
        document.body.style.overflow = "";
      }
    });
  }

  // ---- footer / init ------------------------------------------------------
  $("#rota-range").textContent = fmt(data.dateStart) + " – " + fmt(data.dateEnd);
  renderAdminBanner();
  Store.loadAll().then(function (j) {
    allPrefs = j || {}; rebuildPrefsMap();
    if (state.person) { seedUnavailFromPrefs(); }
    renderAdminBanner();
  });
})(typeof window !== "undefined" ? window : globalThis);
