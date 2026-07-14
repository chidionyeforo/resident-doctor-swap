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
  // Matching group: daytime shifts (Day, weekend Ward, Evening support) are
  // treated as the same kind for swap purposes — a weekend day and a weekend
  // ward are essentially the same shift. Only NIGHT sits on its own, so the
  // only genuine "cross-type" swap is a night traded for a daytime shift.
  function classGroup(cls) {
    return cls === "NIGHT" ? "NIGHT" : "DAY";
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
    // Pre-compute each person's LTFT day (the weekday they're regularly LTFT),
    // or null if they're full-time. Used to prefer swaps between people whose
    // working pattern lines up: two LTFT people who share an LTFT day, or two
    // full-timers, swap cleanly; a full-timer swapping with an LTFT person is
    // workable but less tidy because their week shapes differ.
    this._ltftDay = {};
    this._computeLtftDays();
  }

  Engine.prototype._computeLtftDays = function () {
    var self = this;
    this.data.staff.forEach(function (s) {
      var counts = {};
      (self.data.grid[s.label] || []).forEach(function (c, i) {
        if (c.s === "LTFT") {
          var dow = new Date(self.data.dates[i].iso + "T00:00:00").getDay();
          counts[dow] = (counts[dow] || 0) + 1;
        }
      });
      var best = null, bestN = 0;
      Object.keys(counts).forEach(function (d) { if (counts[d] > bestN) { bestN = counts[d]; best = +d; } });
      // Require at least 3 occurrences to count as a genuine regular LTFT day.
      self._ltftDay[s.label] = bestN >= 3 ? best : null;
    });
  };
  // Returns a compatibility descriptor for two people's working patterns.
  Engine.prototype.ltftCompat = function (a, b) {
    var la = this._ltftDay[a], lb = this._ltftDay[b];
    if (la == null && lb == null) return "both-ft";        // two full-timers
    if (la != null && lb != null) return la === lb ? "ltft-match" : "ltft-diff";
    return "mixed";                                         // one LTFT, one FT
  };

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
      var grp = classGroup(cls);
      // Consecutive daytime shifts (Day / weekend Ward / Evening) group into
      // one block; nights only group with nights.
      if (cur && i === cur.end + 1 && grp === cur.grp) {
        cur.end = i; cur.idxs.push(i);
        // block's display class: NIGHT stays NIGHT; a mixed daytime block
        // takes the class of its majority/first meaningful shift.
        if (cur.cls !== cls && grp === "DAY") {
          // prefer WARD label if any weekend ward present, else keep first
          if (cls === "WARD") cur.cls = "WARD";
        }
      } else {
        cur = { start: i, end: i, idxs: [i], cls: cls, grp: grp };
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
        return { block: b, swaps: r.swaps, chains: r.chains, chainsReason: r.chainsReason };
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

    var swaps = [], ineligible = [];

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
          if (cb.used) return;
          // Equal shift counts only — an uneven swap changes both people's
          // on-call totals and unbalances the rota. Never allowed.
          if (cb.len !== rb.len) return;
          if (cb.idxs.some(function (i) { return unavail[i]; })) return;

          // Blocks match if they're the same group. Day/Ward/E are one group,
          // so a weekend day-for-ward is a normal like-for-like swap. Only a
          // night traded for a daytime shift is a genuine cross-type.
          var cross = cb.grp !== rb.grp;

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
          var lenWarns = reqAssess.warnings.concat(candAssess.warnings);
          if (cross) sc += 500; // cross-type always ranks below like-for-like
          var mutualLeg = cb.idxs.some(function (i) { return myWanted[i]; });
          if (mutualLeg) sc -= 100; // dominate ordering
          if (!best || sc < best.sc) best = { cb: cb, sc: sc, mutualLeg: mutualLeg, warns: lenWarns, cross: cross };
        });

        // Combined return: if a single equal-length block isn't ideal, also
        // try giving back TWO smaller blocks that sum to the same shift count —
        // e.g. 3 nights for (2 nights + 1 E). Only for single-block requests.
        // Constraint: never leave anyone doing a lone single NIGHT (a 1-night
        // block can't be part of the combination). A single E/Ward/Day is fine.
        if (reqBlocks.length === 1 && rb.len >= 3) {
          var avail = cBlocks.filter(function (b) {
            var noLoneNight = !(b.cls === "NIGHT" && b.len < 2);
            return !b.used && b.len < rb.len && noLoneNight &&
                   b.idxs.every(function (i) { return !unavail[i] && !sel[i]; });
          });
          for (var x = 0; x < avail.length; x++) {
            for (var y = x + 1; y < avail.length; y++) {
              var b1 = avail[x], b2 = avail[y];
              if (b1.len + b2.len !== rb.len) continue;
              if (b1.idxs.some(function (i) { return b2.idxs.indexOf(i) >= 0; })) continue;
              var comboIdxs = b1.idxs.concat(b2.idxs);
              var comboAdd = comboIdxs.map(function (i) { return { idx: i, cls: shiftClass(self.cell(cl, i).v) }; });
              // Requester takes both blocks (giving up their single block)
              var ra = self.assessPlacement(reqLabel, comboAdd, selIdxs, null);
              if (!ra.ok) continue;
              // Candidate takes the request block, gives away both blocks
              var ca = self.assessPlacement(cl, rbAdd, comboIdxs, cPref);
              if (!ca.ok) continue;
              var comboGrp = (b1.grp === b2.grp && b1.grp === rb.grp) ? false : true;
              var csc = equity(rb, b1) + equity(rb, b2) + ra.penalty + ca.penalty
                      + 500 /* combined split is always a last resort */;
              if (!best || csc < best.sc) {
                best = { combo: [b1, b2], sc: csc, mutualLeg: false,
                         warns: ra.warnings.concat(ca.warnings), cross: comboGrp, combined: true };
              }
            }
          }
        }

        if (best) {
          if (best.combo) {
            best.combo.forEach(function (b) { b.used = true; });
            assignments.push({ rb: rb, combo: best.combo, sc: best.sc, warns: best.warns, cross: best.cross, combined: true });
          } else {
            best.cb.used = true;
            assignments.push({ rb: rb, cb: best.cb, sc: best.sc, mutualLeg: best.mutualLeg, warns: best.warns, cross: best.cross });
          }
        }
        else allMatched = false;
      });

      if (allMatched && assignments.length) {
        var score = 0;
        var crossClass = assignments.some(function (a) { return a.cross; });
        var combinedSplit = assignments.some(function (a) { return a.combined; });
        // Anything that isn't a plain like-for-like single-block trade is a
        // "last resort" and goes in the collapsed section.
        var lastResort = crossClass || combinedSplit;
        // Did C also flag the requester's selected dates as their wanted-off?
        var cMutualOnReq = cWanted && selIdxs.some(function (i) { return cWanted[i]; });
        assignments.forEach(function (a) {
          score += a.sc;
          (a.warns || []).forEach(function (w) { if (warnings.indexOf(w) < 0) warnings.push(w); });
        });
        // Working-pattern compatibility: two full-timers or two LTFT people who
        // share an LTFT day swap most cleanly. A full-timer paired with an LTFT
        // person (or two LTFT people with different LTFT days) still works but
        // is a little less tidy, so it's nudged down the ranking.
        var compat = self.ltftCompat(reqLabel, cl);
        if (compat === "mixed" || compat === "ltft-diff") score += 8;
        // Classify mutual: strong = both directions, soft = one direction.
        // (Last-resort swaps are never treated as mutual — they belong in the
        // less-preferable section regardless.)
        var anyLegMutual = assignments.some(function (a) { return a.mutualLeg; });
        var mutual = null;
        if (!lastResort) {
          if (cMutualOnReq && anyLegMutual) mutual = "strong";
          else if (cMutualOnReq || anyLegMutual) mutual = "soft";
          if (mutual === "strong") score -= 1000; // top-rank
          else if (mutual === "soft") score -= 50;
        }
        swaps.push({ label: C.label, grade: C.grade, dept: C.dept, assignments: assignments, score: score, warnings: warnings, mutual: mutual, crossClass: lastResort, cross: crossClass });
      }
      // If no return block matched, this candidate is simply not surfaced.
      // A one-sided "they take your shift, you give nothing back" isn't a
      // real swap request anyone actually makes, so it's never suggested —
      // that's what the rota team's own manual cover arrangements are for.
    });

    function rank(a, b) {
      // like-for-like always sorts above cross-type
      if (!!a.crossClass !== !!b.crossClass) return a.crossClass ? 1 : -1;
      // mutual swaps sort above non-mutual (within like-for-like)
      var am = a.mutual === "strong" ? 2 : a.mutual === "soft" ? 1 : 0;
      var bm = b.mutual === "strong" ? 2 : b.mutual === "soft" ? 1 : 0;
      if (am !== bm) return bm - am;
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      if ((a.score || 0) !== (b.score || 0)) return (a.score || 0) - (b.score || 0);
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }
    swaps.sort(rank);

    var chains = [], chainsReason = null;
    var B2B = "This would mean working back-to-back weekends";
    // Three-way is a like-for-like fallback, so it's judged against the
    // like-for-like direct swaps only — cross-type options don't suppress it.
    var likeForLike = swaps.filter(function (s) { return !s.crossClass; });
    if (reqBlocks.length === 1) {
      if (!likeForLike.length) {
        // No like-for-like direct swap — three-way is the fallback.
        chains = this._findChains(reqLabel, reqBlocks[0], sel, unavail, prefs);
        if (chains.length) chainsReason = "no-direct";
      } else if (likeForLike.every(function (s) { return s.warnings.indexOf(B2B) >= 0; })) {
        // Every like-for-like swap would put someone on back-to-back weekends.
        // Look for a three-way route where nobody does.
        chains = this._findChains(reqLabel, reqBlocks[0], sel, unavail, prefs)
          .filter(function (ch) { return ch.warnings.indexOf(B2B) < 0; });
        if (chains.length) chainsReason = "avoid-b2b";
      }
    }

    return { reqBlocks: reqBlocks, swaps: swaps, chains: chains, chainsReason: chainsReason, ineligible: ineligible };
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
    var self = this, KG = rb.grp, out = [], seen = {};

    function prefOf(l) { return (prefs[l] || {}).unavail || null; }
    function blocksOf(l) {
      // Same group AND same length as the requested block — a three-way must
      // move the same number of shifts around the loop, or someone's on-call
      // total changes and the rota is unbalanced. Day/Ward/E count as one group.
      return self.groupBlocks(l, self.oncallShifts(l).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.grp === KG && b.len === rb.len; });
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
  var allPrefs = {};   // keyed by STABLE id (spreadsheet column) — survives renumbering
  var prefsMap = {};   // keyed by display label — consumed by the engine

  // Identity helpers. The display number ("slot 7") can change when the rota
  // changes; the spreadsheet column ("L") never does. Everything persistent
  // (PINs, unavailability, wanted-off, audit, verified-device) keys on id.
  var idByLabel = {}, labelById = {};
  (data.staff || []).forEach(function (s) { idByLabel[s.label] = s.id; labelById[s.id] = s.label; });
  function personId() { return state.person ? idByLabel[state.person] : null; }

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function ukNumeric(iso) {
    // dd/mm/yyyy — unambiguous UK format
    var p = iso.split("-");
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  function ukShort(iso) {
    // dd/mm — no year, for compact contexts
    var p = iso.split("-");
    return p[2] + "/" + p[1];
  }
  function fmt(iso, dow) {
    return (dow ? dow + " " : "") + ukNumeric(iso);
  }
  function fmtShort(iso) {
    return ukShort(iso);
  }
  function fmtNumeric(iso) {
    return ukNumeric(iso);
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
    CACHE: "rds_prefs_cache_launch",
    AUDIT_CACHE: "rds_audit_cache_launch",
    FEEDBACK_CACHE: "rds_feedback_cache_launch",
    META_CACHE: "rds_meta_cache_launch",
    PENDING: "rds_prefs_pending_launch",
    shared: false,
    auditLog: [],
    feedbackLog: [],
    meta: {},
    // Returns object of {id: {unavail, wantedOff, pinHash, updated, ...}}; also
    // populates this.auditLog, this.feedbackLog, this.meta.
    loadAll: function (slim) {
      var self = this;
      var url = this.ENDPOINT + (slim ? "?slim=1" : "");
      return fetch(url, { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("no backend"); return r.json(); })
        .then(function (j) {
          self.shared = true;
          // Shape-tolerant: accept an older deploy's flat-prefs-only response too.
          var prefs, audit, feedback, meta;
          if (j && j.prefs !== undefined) {
            prefs = j.prefs || {}; audit = j.audit || []; feedback = j.feedback || []; meta = j.meta || {};
          } else { prefs = j || {}; audit = []; feedback = []; meta = {}; }
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
          try { localStorage.setItem(self.FEEDBACK_CACHE, JSON.stringify(feedback)); } catch (e) {}
          try { localStorage.setItem(self.META_CACHE, JSON.stringify(meta)); } catch (e) {}
          self.auditLog = audit; self.feedbackLog = feedback; self.meta = meta;
          return prefs;
        })
        .catch(function () {
          self.shared = false;
          try { self.auditLog = JSON.parse(localStorage.getItem(self.AUDIT_CACHE) || "[]"); } catch (e) { self.auditLog = []; }
          try { self.feedbackLog = JSON.parse(localStorage.getItem(self.FEEDBACK_CACHE) || "[]"); } catch (e) { self.feedbackLog = []; }
          try { self.meta = JSON.parse(localStorage.getItem(self.META_CACHE) || "{}"); } catch (e) { self.meta = {}; }
          try { return JSON.parse(localStorage.getItem(self.CACHE) || "{}"); } catch (e) { return {}; }
        });
    },
    save: function (label, prefs) {
      var self = this;
      // Merge into the local cache, don't overwrite — callers routinely save
      // partial prefs objects (e.g. publishWantedOff only sets unavail/wantedOff),
      // and the backend already preserves omitted fields like pinHash and
      // searchCount via its own read-merge-write. The local cache needs the
      // same discipline, or a partial save silently erases those fields from
      // the offline fallback (this was actually happening: every search reset
      // its own searchCount because the parallel publishWantedOff() call was
      // clobbering it in the cache before the increment could be read back).
      try {
        var all = JSON.parse(localStorage.getItem(self.CACHE) || "{}");
        var existing = all[label] || {};
        all[label] = Object.assign({}, existing, prefs);
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
    },
    logFeedback: function (entry) {
      var self = this;
      var full = Object.assign({ ts: new Date().toISOString() }, entry);
      self.feedbackLog.unshift(full);
      if (self.feedbackLog.length > 1000) self.feedbackLog.length = 1000;
      try { localStorage.setItem(self.FEEDBACK_CACHE, JSON.stringify(self.feedbackLog)); } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: entry })
      }).then(function (r) { return r.ok; })
        .catch(function () { return false; });
    },
    saveMeta: function (partial) {
      var self = this;
      self.meta = Object.assign({}, self.meta, partial);
      try { localStorage.setItem(self.META_CACHE, JSON.stringify(self.meta)); } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: partial })
      }).then(function (r) { return r.ok; })
        .catch(function () { return false; });
    },
    setAdminPin: function (hash) {
      var self = this;
      self.meta = Object.assign({}, self.meta, { adminPinHash: hash });
      try { localStorage.setItem(self.META_CACHE, JSON.stringify(self.meta)); } catch (e) {}
      return fetch(this.ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminPinHash: hash })
      }).then(function (r) { return r.ok; })
        .catch(function () { return false; });
    }
  };
  function rebuildPrefsMap() {
    prefsMap = {};
    Object.keys(allPrefs).forEach(function (id) {
      var lbl = labelById[id];
      if (!lbl) return; // a stored id with no current slot (person left) — ignore
      var entry = allPrefs[id] || {};
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
    var myEntry = allPrefs[personId()] || {};
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
    var p = allPrefs[personId()]; if (!p || !p.unavail) return;
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
    var prev = allPrefs[personId()] || {};
    if (JSON.stringify(list) === JSON.stringify(prev.unavail || [])) return;
    var p = {
      unavail: list,
      wantedOff: prev.wantedOff || [],
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[personId()] = p;
    setStatus("Saving your unavailable dates…", "saving");
    Store.save(personId(), p).then(function (ok) {
      rebuildPrefsMap();
      setStatus(ok ? "Saved — visible to everyone using the swap shop." : "Saved on this device only — shared store unreachable.", ok ? "ok" : "local");
    });
  }

  // Publish (or clear) the current user's wanted-off list to the shared store.
  // Called when they hit "Find a swap" (publish their selected dates) and
  // also when they explicitly clear it.
  function publishWantedOff(isoList) {
    if (!state.person) return Promise.resolve(false);
    var prev = allPrefs[personId()] || {};
    var sorted = (isoList || []).slice().sort();
    var p = {
      unavail: prev.unavail || [],
      wantedOff: sorted,
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[personId()] = p;
    rebuildPrefsMap();
    // Audit: was something added or cleared?
    if (sorted.length) {
      Store.logEvent({ slot: personId(), action: "publish_wanted", dates: sorted });
    } else if ((prev.wantedOff || []).length) {
      Store.logEvent({ slot: personId(), action: "clear_wanted" });
    }
    return Store.save(personId(), p);
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
      recordSearchAndMaybeAskForRating();
    });
  });

  // Tracks how many searches this person has run (stored server-side against
  // their stable id, so it's consistent across devices) and, once they've hit
  // the threshold, offers the one-time star rating prompt.
  function recordSearchAndMaybeAskForRating() {
    var pid = personId(); if (!pid) return;
    var prev = allPrefs[pid] || {};
    var count = (prev.searchCount || 0) + 1;
    var entry = {
      unavail: prev.unavail || [],
      wantedOff: prev.wantedOff || [],
      searchCount: count,
      ratedPromptShown: !!prev.ratedPromptShown,
      ratingSnoozeUntil: prev.ratingSnoozeUntil || null,
      updated: new Date().toISOString().slice(0, 10)
    };
    allPrefs[pid] = entry;
    Store.save(pid, entry);

    var RATING_THRESHOLD = 5;
    var alreadyRated = !!entry.ratedPromptShown;
    var snoozed = entry.ratingSnoozeUntil != null && count < entry.ratingSnoozeUntil;
    if (!alreadyRated && !snoozed && count >= RATING_THRESHOLD) {
      openRatingModal();
    }
  }

  // ---- star rating modal (auto-triggered) ----------------------------------
  var ratingState = { stars: 0 };
  function openRatingModal() {
    var m = $("#rating-modal"); if (!m) return;
    ratingState.stars = 0;
    document.querySelectorAll("#star-row .star-btn").forEach(function (b) { b.classList.remove("on"); });
    $("#rating-followup").classList.add("hide");
    $("#rating-text").value = "";
    $("#rating-submit").classList.add("hide");
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeRatingModal() {
    $("#rating-modal").classList.remove("open");
    document.body.style.overflow = "";
  }
  // Snoozing (dismiss without rating) asks again after 5 more searches rather
  // than never — only an actual submitted rating permanently silences it.
  function snoozeRating() {
    var pid = personId();
    if (pid) {
      var prev = allPrefs[pid] || {};
      var count = prev.searchCount || 0;
      var entry = {
        unavail: prev.unavail || [], wantedOff: prev.wantedOff || [],
        searchCount: count, ratedPromptShown: !!prev.ratedPromptShown,
        ratingSnoozeUntil: count + 5,
        updated: new Date().toISOString().slice(0, 10)
      };
      allPrefs[pid] = entry;
      Store.save(pid, entry);
    }
    closeRatingModal();
  }
  function submitRating() {
    if (!ratingState.stars) { snoozeRating(); return; }
    var pid = personId();
    Store.logFeedback({
      slot: pid || undefined,
      slotLabel: state.person || undefined,
      type: "rating",
      stars: ratingState.stars,
      text: ($("#rating-text").value || "").trim()
    });
    if (pid) {
      var prev = allPrefs[pid] || {};
      var entry = {
        unavail: prev.unavail || [], wantedOff: prev.wantedOff || [],
        searchCount: prev.searchCount || 0, ratedPromptShown: true,
        ratingSnoozeUntil: prev.ratingSnoozeUntil || null,
        updated: new Date().toISOString().slice(0, 10)
      };
      allPrefs[pid] = entry;
      Store.save(pid, entry);
    }
    closeRatingModal();
  }
  if ($("#star-row")) {
    document.querySelectorAll("#star-row .star-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var n = +btn.dataset.star;
        ratingState.stars = n;
        document.querySelectorAll("#star-row .star-btn").forEach(function (b) {
          b.classList.toggle("on", +b.dataset.star <= n);
        });
        $("#rating-followup").classList.remove("hide");
        $("#rating-followup-text").textContent = n >= 4
          ? "Glad it's helping — anything that could be even better?"
          : "Sorry to hear that — what would make it better?";
        $("#rating-submit").classList.remove("hide");
      });
    });
  }
  if ($("#rating-dismiss")) $("#rating-dismiss").addEventListener("click", snoozeRating);
  if ($("#rating-submit")) $("#rating-submit").addEventListener("click", submitRating);
  if ($("#rating-modal")) {
    $("#rating-modal").addEventListener("click", function (e) { if (e.target === $("#rating-modal")) snoozeRating(); });
  }

  // ---- feedback modal (always available, footer entry point) ---------------
  function openFeedbackModal() {
    var m = $("#feedback-modal"); if (!m) return;
    $("#feedback-text").value = "";
    $("#feedback-msg").textContent = "";
    $("#feedback-msg").style.color = "";
    document.querySelectorAll("#feedback-type-chips .filter-chip").forEach(function (c, i) {
      c.classList.toggle("active", i === 0);
    });
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeFeedbackModal() {
    $("#feedback-modal").classList.remove("open");
    document.body.style.overflow = "";
  }
  if ($("#feedback-open")) $("#feedback-open").addEventListener("click", openFeedbackModal);
  if ($("#feedback-cancel")) $("#feedback-cancel").addEventListener("click", closeFeedbackModal);
  if ($("#feedback-close")) $("#feedback-close").addEventListener("click", closeFeedbackModal);
  if ($("#feedback-modal")) {
    $("#feedback-modal").addEventListener("click", function (e) { if (e.target === $("#feedback-modal")) closeFeedbackModal(); });
  }
  document.querySelectorAll("#feedback-type-chips .filter-chip").forEach(function (c) {
    c.addEventListener("click", function () {
      document.querySelectorAll("#feedback-type-chips .filter-chip").forEach(function (x) { x.classList.remove("active"); });
      c.classList.add("active");
    });
  });
  if ($("#feedback-submit")) {
    $("#feedback-submit").addEventListener("click", function () {
      var active = document.querySelector("#feedback-type-chips .filter-chip.active");
      var type = active ? active.dataset.type : "suggestion";
      var text = ($("#feedback-text").value || "").trim();
      if (!text) { $("#feedback-msg").textContent = "Add a line so we know what to look at."; return; }
      Store.logFeedback({
        slot: personId() || undefined,
        slotLabel: state.person || undefined,
        type: type,
        text: text
      });
      $("#feedback-msg").style.color = "var(--teal-dark)";
      $("#feedback-msg").textContent = "Thanks — sent.";
      setTimeout(closeFeedbackModal, 900);
    });
  }

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
      var lfl = res.swaps.filter(function (s) { return !s.crossClass; });
      var crossSwaps = res.swaps.filter(function (s) { return s.crossClass; });
      var mutualSwaps = lfl.filter(function (s) { return s.mutual; });
      var otherSwaps = lfl.filter(function (s) { return !s.mutual; });

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

      if (!lfl.length && !(res.chains && res.chains.length)) {
        var none = el("div", "card note");
        none.appendChild(el("strong", null, "No like-for-like swap found."));
        none.appendChild(el("p", null, crossSwaps.length
          ? "Nobody can hand back the same type of shift. There are cross-type options below if you're willing to take a different kind of shift."
          : "Nobody can take all the days you've selected and hand back an equivalent shift. Speak to your rota team — they may be able to arrange cover directly."));
        root.appendChild(none);
      } else if (!lfl.length && res.chains && res.chains.length && res.chainsReason !== "avoid-b2b") {
        var n0 = el("div", "card note");
        n0.appendChild(el("strong", null, "No direct two-way swap available."));
        n0.appendChild(el("p", null, "Try one of the three-way swaps below — the loop closes so everyone keeps the same number of on-calls."));
        root.appendChild(n0);
      }

      if (res.chains && res.chains.length && res.chainsReason !== "avoid-b2b") {
        root.appendChild(el("h3", "res-h", "Three-way swaps"));
        res.chains.slice(0, 5).forEach(function (ch, i) { root.appendChild(chainCard(ch, !lfl.length && i === 0)); });
      }

      // Cross-type swaps: lowest priority, collapsed by default.
      if (crossSwaps.length) {
        root.appendChild(crossSection(crossSwaps));
      }
    }

    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Collapsible section for cross-type (different shift class) swaps — the
  // last-resort option when you're willing to take a less favourable shift.
  function crossSection(crossSwaps) {
    var det = el("details", "combined-fallback cross-fallback");
    var sum = el("summary", null,
      "Last-resort swaps (" + crossSwaps.length +
      (crossSwaps.length === 1 ? " option" : " options") + ")");
    det.appendChild(sum);
    var intro = el("p", "perblock-intro",
      "Nights traded for daytime shifts, or a block split into two smaller ones. Fine to do if you're set on the dates — just less tidy than a straight swap.");
    det.appendChild(intro);
    crossSwaps.slice(0, 6).forEach(function (sw) { det.appendChild(swapCard(sw, false)); });
    return det;
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

    var lfl = pb.swaps.filter(function (s) { return !s.crossClass; });
    var crossSwaps = pb.swaps.filter(function (s) { return s.crossClass; });
    var mutuals = lfl.filter(function (s) { return s.mutual; });
    var others = lfl.filter(function (s) { return !s.mutual; });

    // If every like-for-like swap for this block means back-to-back weekends,
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
    if (!lfl.length) {
      if (pb.chains && pb.chains.length && !avoidB2b) {
        wrap.appendChild(el("p", "perblock-note", "No direct two-way swap for this block — see three-way options below."));
        pb.chains.slice(0, 3).forEach(function (ch, i) { wrap.appendChild(chainCard(ch, i === 0)); });
      } else if (!avoidB2b && !crossSwaps.length) {
        wrap.appendChild(el("p", "perblock-note", "No match found for this block."));
      }
    }
    if (crossSwaps.length) {
      wrap.appendChild(crossSection(crossSwaps));
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
    if (sw.crossClass) cls += " cross";
    else if (sw.mutual === "strong") cls += " mutual-strong";
    else if (sw.mutual === "soft") cls += " mutual-soft";
    var c = el("div", cls);
    if (sw.cross) c.appendChild(el("div", "ribbon cross", "Night ⇄ day"));
    else if (sw.crossClass) c.appendChild(el("div", "ribbon cross", "Split swap"));
    else if (sw.mutual === "strong") c.appendChild(el("div", "ribbon mutual", "Mutual swap"));
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
      ex.appendChild(el("div", "swap-arrow", "⇅"));
      if (a.combined && a.combo) {
        // Return is split across two blocks — show each with a "+" between.
        a.combo.forEach(function (b, bi) {
          if (bi > 0) ex.appendChild(el("div", "combo-plus", "＋ and"));
          ex.appendChild(legRow(bi === 0 ? "You take" : "", b.idxs, sw.label));
        });
      } else {
        ex.appendChild(legRow("You take", a.cb.idxs, sw.label));
      }
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
          : sw.cross ? "Night traded for a daytime shift — last resort" : sw.crossClass ? "Block split into two — last resort" : "Straight like-for-like swap"));
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
    ex.appendChild(el("div", "swap-arrow chain-arrow", "↻"));
    ex.appendChild(legRow("Slot " + ch.D.label + " takes", ch.cb.idxs, ch.C.label));
    ex.appendChild(el("div", "swap-arrow chain-arrow", "↻"));
    ex.appendChild(legRow("You take", ch.db.idxs, ch.D.label));
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
        if (a.combined && a.combo) {
          a.combo.forEach(function (b) {
            lines.push("• In return, I'd take your " + CLASS_LABEL[b.cls] + " — " + emailDates(b.idxs));
          });
        } else {
          lines.push("• In return, I'd take your " + CLASS_LABEL[a.cb.cls] + " — " + emailDates(a.cb.idxs));
        }
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
        if (a.combined && a.combo) {
          a.combo.forEach(function (b) {
            lines.push("• I take their " + CLASS_LABEL[b.cls] + ": " + emailDates(b.idxs));
          });
        } else {
          lines.push("• I take their " + CLASS_LABEL[a.cb.cls] + ": " + emailDates(a.cb.idxs));
        }
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
  $("#email-copy").addEventListener("click", function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var subjEl = $("#email-subject"), bodyEl = $("#email-body");
    var subject = (subjEl && subjEl.value) || "";
    var body = (bodyEl && bodyEl.value) || "";
    var text = subject ? ("Subject: " + subject + "\n\n" + body) : body;
    var btn = $("#email-copy");
    function flashBtn(msg) {
      var orig = btn.textContent; btn.textContent = msg;
      setTimeout(function () { btn.textContent = orig; }, 1500);
    }
    // Primary path: temporary textarea + execCommand. This is the most reliable
    // across browsers (including inside modals) and copies exactly `text`, never
    // a URL or stray selection.
    function textareaCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      var sel = document.getSelection();
      var savedRange = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      ta.focus(); ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (savedRange && sel) { sel.removeAllRanges(); sel.addRange(savedRange); }
      return ok;
    }
    // Try execCommand first (synchronous, reliable), then async clipboard API.
    if (textareaCopy()) { flashBtn("Copied ✓"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { flashBtn("Copied ✓"); })
        .catch(function () {
          if (bodyEl) { bodyEl.focus(); bodyEl.select(); }
          flashBtn("Select all, then copy");
        });
    } else {
      if (bodyEl) { bodyEl.focus(); bodyEl.select(); }
      flashBtn("Select all, then copy");
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
    // Audit log: who drafted what email, plus the full trade (every leg of
    // the swap cycle, by stable id) so a future rota upload can check whether
    // this specific proposed swap was actually confirmed.
    if (state.person) {
      var opts = $("#email-modal")._opts || {};
      var pid = personId();
      var dates = [], trade = null;
      if (opts.assignments) {
        var reqDates = [], partnerDates = [];
        opts.assignments.forEach(function (a) {
          a.rb.idxs.forEach(function (i) { reqDates.push(data.dates[i].iso); dates.push(data.dates[i].iso); });
          if (a.combined && a.combo) {
            a.combo.forEach(function (b) { b.idxs.forEach(function (i) { partnerDates.push(data.dates[i].iso); }); });
          } else if (a.cb) {
            a.cb.idxs.forEach(function (i) { partnerDates.push(data.dates[i].iso); });
          }
        });
        var partnerId = idByLabel[opts.partnerLabel];
        if (pid && partnerId && reqDates.length && partnerDates.length) {
          trade = [{ slot: pid, dates: reqDates }, { slot: partnerId, dates: partnerDates }];
        }
      } else if (opts.chain) {
        var ch = opts.chain;
        ch.rb.idxs.forEach(function (i) { dates.push(data.dates[i].iso); });
        var cId = idByLabel[ch.C.label], dId = idByLabel[ch.D.label];
        if (pid && cId && dId) {
          trade = [
            { slot: pid, dates: ch.rb.idxs.map(function (i) { return data.dates[i].iso; }) },
            { slot: cId, dates: ch.cb.idxs.map(function (i) { return data.dates[i].iso; }) },
            { slot: dId, dates: ch.db.idxs.map(function (i) { return data.dates[i].iso; }) }
          ];
        }
      }
      var event = {
        slot: pid,
        action: kind === "ask" ? "draft_ask_email" : "draft_rota_email",
        partnerSlot: opts.partnerLabel || (opts.chain && opts.chain.C && opts.chain.C.label) || null,
        dates: dates,
        kind: opts.kind || (opts.chain ? "chain" : "direct")
      };
      if (trade) event.trade = trade;
      Store.logEvent(event);
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
  function pinHashFor(id, pin) { return sha256Hex("rds:" + id + ":" + pin); }

  function openPinModal() {
    if (!state.person) return;
    var slot = state.person;          // display label
    var pid = personId();             // stable id
    if (state.verifiedSlot === slot) return; // already verified this session

    // Already remembered on this device?
    try {
      var rem = localStorage.getItem("rds_verified_launch_" + pid);
      if (rem === "1") {
        state.verifiedSlot = slot;
        renderLoginBadge();
        return;
      }
    } catch (e) {}

    var entry = allPrefs[pid] || {};
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
    var pid = personId();
    var pin = ($("#pin-input").value || "").trim();
    if (!/^\d{4}$/.test(pin)) { pinError("PIN must be 4 digits."); return; }
    if (m._firstTime) {
      var confirm = ($("#pin-confirm").value || "").trim();
      if (pin !== confirm) { pinError("PINs don't match."); return; }
      $("#pin-submit").disabled = true;
      pinHashFor(pid, pin).then(function (hash) {
        return Store.setPin(pid, hash).then(function (ok) {
          $("#pin-submit").disabled = false;
          if (!ok && !Store.shared) {
            pinError("PIN saved locally — shared store unreachable, PIN won't transfer to other devices.");
          }
          allPrefs[pid] = allPrefs[pid] || {};
          allPrefs[pid].pinHash = hash;
          rebuildPrefsMap();
          state.verifiedSlot = slot;
          try { localStorage.setItem("rds_verified_launch_" + pid, "1"); } catch (e) {}
          Store.logEvent({ slot: pid, action: "pin_set" });
          Store.logEvent({ slot: pid, action: "login" });
          closePinModal();
          renderLoginBadge();
          renderAdminBanner();
        });
      });
    } else {
      $("#pin-submit").disabled = true;
      pinHashFor(pid, pin).then(function (hash) {
        $("#pin-submit").disabled = false;
        var entry = allPrefs[pid] || {};
        if (entry.pinHash && entry.pinHash === hash) {
          state.verifiedSlot = slot;
          try { localStorage.setItem("rds_verified_launch_" + pid, "1"); } catch (e) {}
          Store.logEvent({ slot: pid, action: "login" });
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
        try { localStorage.removeItem("rds_verified_launch_" + personId()); } catch (e) {}
        state.verifiedSlot = null;
        Store.logEvent({ slot: personId(), action: "logout" });
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

  // Admin content is gated behind a shared admin PIN (separate from per-slot
  // PINs) so ?admin=1 alone doesn't expose usage stats or the audit log to
  // anyone who tries the URL. Same attribution-grade posture as slot PINs —
  // not a hard security boundary, but stops casual access.
  function checkAdminAccess() {
    if (!state.admin) { var w = $("#admin-banner"); if (w) w.classList.add("hide"); return; }
    try {
      if (localStorage.getItem("rds_admin_verified") === "1") { renderAdminBanner(); return; }
    } catch (e) {}
    openAdminPinModal();
  }
  function openAdminPinModal() {
    var m = $("#admin-pin-modal"); if (!m) return;
    var firstTime = !(Store.meta && Store.meta.adminPinHash);
    $("#admin-pin-title").textContent = firstTime ? "Set the admin PIN" : "Admin access";
    $("#admin-pin-help").textContent = firstTime
      ? "Set a PIN for admin access — share it only with whoever manages the rota. You'll need it once per device."
      : "Enter the admin PIN to view usage stats, feedback, and the audit log.";
    $("#admin-pin-input").value = ""; $("#admin-pin-confirm").value = "";
    $("#admin-pin-confirm-row").classList.toggle("hide", !firstTime);
    $("#admin-pin-msg").textContent = "";
    m._firstTime = firstTime;
    m.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(function () { $("#admin-pin-input").focus(); }, 100);
  }
  function closeAdminPinModal() {
    $("#admin-pin-modal").classList.remove("open");
    document.body.style.overflow = "";
  }
  if ($("#admin-pin-cancel")) $("#admin-pin-cancel").addEventListener("click", closeAdminPinModal);
  if ($("#admin-pin-input")) {
    $("#admin-pin-input").addEventListener("keydown", function (e) { if (e.key === "Enter") submitAdminPin(); });
  }
  if ($("#admin-pin-confirm")) {
    $("#admin-pin-confirm").addEventListener("keydown", function (e) { if (e.key === "Enter") submitAdminPin(); });
  }
  if ($("#admin-pin-submit")) $("#admin-pin-submit").addEventListener("click", submitAdminPin);
  function submitAdminPin() {
    var m = $("#admin-pin-modal");
    var pin = ($("#admin-pin-input").value || "").trim();
    if (!/^\d{4,8}$/.test(pin)) { $("#admin-pin-msg").textContent = "PIN must be 4-8 digits."; return; }
    if (m._firstTime) {
      var confirm = ($("#admin-pin-confirm").value || "").trim();
      if (pin !== confirm) { $("#admin-pin-msg").textContent = "PINs don't match."; return; }
      sha256Hex("rds-admin:" + pin).then(function (hash) {
        Store.setAdminPin(hash).then(function () {
          try { localStorage.setItem("rds_admin_verified", "1"); } catch (e) {}
          closeAdminPinModal();
          renderAdminBanner();
        });
      });
    } else {
      sha256Hex("rds-admin:" + pin).then(function (hash) {
        if (Store.meta && Store.meta.adminPinHash === hash) {
          try { localStorage.setItem("rds_admin_verified", "1"); } catch (e) {}
          closeAdminPinModal();
          renderAdminBanner();
        } else {
          $("#admin-pin-msg").textContent = "Wrong PIN. Whoever set it up can reset it if needed.";
        }
      });
    }
  }

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
    var proposedCount = Store.auditLog.filter(function (e) { return e.action === "draft_rota_email"; }).length;
    var ratings = (Store.feedbackLog || []).filter(function (f) { return f.type === "rating" && f.stars; });
    var avgRating = ratings.length ? (ratings.reduce(function (s, f) { return s + f.stars; }, 0) / ratings.length) : null;

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
    addStat(proposedCount, "Swaps proposed");
    addStat(avgRating != null ? avgRating.toFixed(1) : "—", "Avg rating (" + ratings.length + ")");
    wrap.appendChild(stats);

    var auditBtn = el("button", "admin-btn", "View audit log");
    auditBtn.addEventListener("click", function () { openAuditModal(); });
    wrap.appendChild(auditBtn);

    var rosterBtn = el("button", "admin-btn", "Roster record");
    rosterBtn.addEventListener("click", function () { openRosterModal(); });
    wrap.appendChild(rosterBtn);

    var feedbackBtn = el("button", "admin-btn", "Feedback");
    feedbackBtn.addEventListener("click", function () { openFeedbackListModal(); });
    wrap.appendChild(feedbackBtn);

    var metricsBtn = el("button", "admin-btn", "Success metrics");
    metricsBtn.addEventListener("click", function () { openMetricsModal(); });
    wrap.appendChild(metricsBtn);

    var unavailBtn = el("button", "admin-btn", "Unavailability store");
    unavailBtn.addEventListener("click", function () { openUnavailStoreModal(); });
    wrap.appendChild(unavailBtn);
  }

  // Read-only admin view: every slot's currently-stored unavailable dates and
  // any "currently looking" (wanted-off) dates, straight from the shared prefs
  // store. Useful for the rota team to see who's flagged what without having
  // to pick each slot individually.
  function openUnavailStoreModal() {
    var m = $("#audit-modal"); if (!m) return;
    $("#audit-modal-title").textContent = "Unavailability store";
    if ($("#audit-modal-help")) $("#audit-modal-help").textContent = "Live from the shared store. Only shows slots with something flagged.";
    var list = $("#audit-list"); list.innerHTML = "";

    var rows = data.staff.slice().sort(function (a, b) {
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }).map(function (s) {
      var entry = allPrefs[s.id] || {};
      return { s: s, unavail: entry.unavail || [], wantedOff: entry.wantedOff || [], updated: entry.updated };
    }).filter(function (r) { return r.unavail.length || r.wantedOff.length; });

    if (!rows.length) {
      list.appendChild(el("p", "empty", "Nobody has flagged any unavailable or wanted-off dates yet."));
    } else {
      rows.forEach(function (r) {
        var row = el("div", "audit-row");
        row.style.flexWrap = "wrap";
        var head = el("span", "audit-slot", "Slot " + r.s.label);
        row.appendChild(head);
        row.appendChild(el("span", null, (r.s.grade || "—") + " · " + (r.s.dept || "—")));
        if (r.unavail.length) {
          var u = el("div", null);
          u.style.width = "100%"; u.style.fontSize = ".8rem"; u.style.color = "var(--ink-soft)"; u.style.marginTop = "4px";
          u.textContent = "Unavailable: " + r.unavail.map(fmtShort).join(", ");
          row.appendChild(u);
        }
        if (r.wantedOff.length) {
          var w = el("div", null);
          w.style.width = "100%"; w.style.fontSize = ".8rem"; w.style.color = "var(--coral-dark)"; w.style.marginTop = "2px";
          w.textContent = "Currently looking: " + r.wantedOff.map(fmtShort).join(", ");
          row.appendChild(w);
        }
        if (r.updated) {
          var d = el("span", null, "updated " + ukNumeric(r.updated));
          d.style.color = "var(--muted)"; d.style.fontSize = ".72rem"; d.style.width = "100%";
          row.appendChild(d);
        }
        list.appendChild(row);
      });
    }
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  // Shows the slot → grade/specialty record, keyed by permanent column id,
  // plus any historical snapshots. This is the running note of who held which
  // slot each time the rota spreadsheet changed.
  function openRosterModal() {
    var m = $("#audit-modal"); if (!m) return;
    $("#audit-modal-title").textContent = "Roster record";
    if ($("#audit-modal-help")) $("#audit-modal-help").textContent = "Every slot's grade and specialty, keyed to its permanent spreadsheet column so it survives renumbering.";
    var list = $("#audit-list"); list.innerHTML = "";
    var history = (data.rosterHistory || []).slice().reverse();
    if (!history.length) {
      // fall back to current live roster
      history = [{ date: (data.generated || "").slice(0, 10), note: "Current", slots: data.staff.map(function (s) { return { id: s.id, label: s.label, grade: s.grade, dept: s.dept }; }) }];
    }
    history.forEach(function (snap) {
      var hdr = el("div", "audit-row");
      hdr.style.background = "var(--paper-warm)";
      hdr.appendChild(el("span", "audit-action", (snap.note || "Snapshot") + " — " + (snap.date ? ukNumeric(snap.date) : "")));
      list.appendChild(hdr);
      snap.slots.forEach(function (sl) {
        var row = el("div", "audit-row");
        row.appendChild(el("span", "audit-slot", "Slot " + sl.label));
        row.appendChild(el("span", "audit-action", (sl.grade || "—") + " · " + (sl.dept || "—")));
        var idTag = el("span", null, "col " + sl.id);
        idTag.style.color = "var(--muted)"; idTag.style.fontSize = ".72rem"; idTag.style.fontFamily = "var(--mono)";
        row.appendChild(idTag);
        list.appendChild(row);
      });
    });
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  // ---- feedback list viewer (admin) -----------------------------------------
  function openFeedbackListModal() {
    var m = $("#audit-modal"); if (!m) return;
    $("#audit-modal-title").textContent = "Feedback & ratings";
    if ($("#audit-modal-help")) $("#audit-modal-help").textContent = "Most recent first — from the footer link and the 5-uses rating prompt.";
    var list = $("#audit-list"); list.innerHTML = "";
    var entries = (Store.feedbackLog || []).slice(0, 200);
    if (!entries.length) {
      list.appendChild(el("p", "empty", "No feedback yet."));
    } else {
      var typeLabel = { bug: "Bug report", suggestion: "Suggestion", other: "Other", rating: "Rating" };
      entries.forEach(function (f) {
        var row = el("div", "audit-row");
        row.appendChild(el("span", "audit-time", fmtAuditTime(f.ts)));
        row.appendChild(el("span", "audit-slot", "Slot " + (f.slotLabel || labelById[f.slot] || f.slot || "—")));
        if (f.stars) {
          row.appendChild(el("span", "stars-mini", "★".repeat(f.stars) + "☆".repeat(5 - f.stars)));
        } else {
          row.appendChild(el("span", "audit-action", typeLabel[f.type] || f.type));
        }
        if (f.text) {
          var t = el("span", null, f.text);
          t.style.color = "var(--ink-soft)"; t.style.fontSize = ".82rem"; t.style.flexBasis = "100%"; t.style.width = "100%";
          row.appendChild(t);
        }
        list.appendChild(row);
      });
    }
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  // ---- success metrics (admin) ----------------------------------------------
  // Compares proposed swaps (from the audit log's "draft_rota_email" trade
  // cycles) against the live rota vs the snapshot taken at the last rota
  // update, to estimate how many proposed swaps actually made it into the
  // official rota. Needs at least one prior snapshot to say anything — until
  // the rota's been refreshed once since go-live, "confirmed" stays at 0.
  function computeSwapMetrics() {
    var snaps = data.oncallSnapshots || [];
    var proposed = Store.auditLog.filter(function (e) { return e.action === "draft_rota_email" && e.trade; });
    var result = { proposedCount: proposed.length, confirmedCount: 0, pendingCount: proposed.length, hasHistory: snaps.length > 0 };
    if (!snaps.length) return result;

    var prevSnap = snaps[snaps.length - 1];
    var prevById = prevSnap.byId || {};
    var currById = {};
    data.staff.forEach(function (s) { currById[s.id] = data.grid[s.label]; });

    var confirmed = 0;
    proposed.forEach(function (e) {
      var trade = e.trade, n = trade.length, ok = true;
      for (var i = 0; i < n && ok; i++) {
        var giver = trade[i].slot, dates = trade[i].dates, taker = trade[(i + 1) % n].slot;
        for (var d = 0; d < dates.length; d++) {
          var idx = engine.idxByIso[dates[d]];
          if (idx == null) { ok = false; break; }
          var prevGiverHadOC = !!(prevById[giver] && prevById[giver][idx]);
          var currGiverCell = currById[giver] && currById[giver][idx];
          var currTakerCell = currById[taker] && currById[taker][idx];
          var giverStillOC = currGiverCell && currGiverCell.s === "OC";
          var takerNowOC = currTakerCell && currTakerCell.s === "OC";
          if (!prevGiverHadOC || giverStillOC || !takerNowOC) { ok = false; break; }
        }
      }
      if (ok) confirmed++;
    });
    result.confirmedCount = confirmed;
    result.pendingCount = proposed.length - confirmed;
    return result;
  }

  function openMetricsModal() {
    var m = $("#audit-modal"); if (!m) return;
    $("#audit-modal-title").textContent = "Success metrics";
    if ($("#audit-modal-help")) $("#audit-modal-help").textContent = "";
    var list = $("#audit-list"); list.innerHTML = "";

    var metrics = computeSwapMetrics();
    var wrap = el("div");

    var statsRow = el("div", "metrics-stats");
    function stat(container, n, label) {
      var s = el("div", "metrics-stat");
      s.appendChild(el("strong", null, String(n)));
      s.appendChild(el("span", null, label));
      container.appendChild(s);
    }
    stat(statsRow, metrics.proposedCount, "Swaps proposed");
    stat(statsRow, metrics.confirmedCount, "Confirmed in rota");
    stat(statsRow, metrics.pendingCount, "Not yet confirmed");
    wrap.appendChild(statsRow);

    var note = el("p", "step-help");
    note.style.margin = "0 4px 18px";
    note.textContent = !metrics.hasHistory
      ? "No prior rota snapshot to compare against yet — this starts showing real numbers once the rota's been refreshed at least once since go-live."
      : "\u201cConfirmed\u201d checks whether a proposed swap's exact dates now show in the live rota, compared with the snapshot taken at the last rota update.";
    wrap.appendChild(note);

    var ratings = (Store.feedbackLog || []).filter(function (f) { return f.type === "rating" && f.stars; });
    var avg = ratings.length ? (ratings.reduce(function (s, f) { return s + f.stars; }, 0) / ratings.length) : null;
    var ratingRow = el("div", "metrics-stats");
    stat(ratingRow, avg != null ? avg.toFixed(1) : "—", "Avg rating (" + ratings.length + " responses)");
    wrap.appendChild(ratingRow);

    var baseWrap = el("div", "card");
    baseWrap.style.marginTop = "16px"; baseWrap.style.boxShadow = "none"; baseWrap.style.border = "1px solid var(--line)";
    baseWrap.appendChild(el("div", "kicker", "Baseline comparison"));
    var p2 = el("p", "step-help");
    p2.style.marginBottom = "12px";
    p2.textContent = "For comparing against last year's swap-request emails, counted retrospectively by the rota team.";
    baseWrap.appendChild(p2);
    var lbl = el("label", "fld", "Swap requests handled last year (same period)");
    lbl.setAttribute("for", "baseline-input");
    baseWrap.appendChild(lbl);
    var input = document.createElement("input");
    input.type = "number"; input.id = "baseline-input"; input.min = "0";
    input.value = (Store.meta && Store.meta.baselineLastYear != null) ? Store.meta.baselineLastYear : "";
    baseWrap.appendChild(input);
    var saveBtn = el("button", "metrics-save-btn", "Save baseline");
    saveBtn.addEventListener("click", function () {
      var n = parseInt(input.value, 10);
      if (!Number.isFinite(n) || n < 0) return;
      Store.saveMeta({ baselineLastYear: n }).then(function () {
        saveBtn.textContent = "Saved ✓";
        setTimeout(function () { saveBtn.textContent = "Save baseline"; }, 1200);
      });
    });
    baseWrap.appendChild(saveBtn);
    wrap.appendChild(baseWrap);

    list.appendChild(wrap);
    m.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function openAuditModal() {
    var m = $("#audit-modal"); if (!m) return;
    $("#audit-modal-title").textContent = "Audit log";
    if ($("#audit-modal-help")) $("#audit-modal-help").textContent = "Most recent first. Each entry shows who did what when.";
    var list = $("#audit-list"); list.innerHTML = "";
    var entries = Store.auditLog.slice(0, 200);
    if (!entries.length) {
      list.appendChild(el("p", "empty", "No audit events recorded yet."));
    } else {
      entries.forEach(function (e) {
        var row = el("div", "audit-row");
        row.appendChild(el("span", "audit-time", fmtAuditTime(e.ts)));
        row.appendChild(el("span", "audit-slot", "Slot " + (labelById[e.slot] || e.slot)));
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
    return ukNumeric(iso.slice(0, 10))
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
  // Wait for Store.loadAll to resolve before checking admin access — otherwise
  // Store.meta.adminPinHash isn't loaded yet and a device that's never verified
  // locally would be wrongly offered "set a new admin PIN" even when one
  // already exists on the server.
  Store.loadAll().then(function (j) {
    allPrefs = j || {}; rebuildPrefsMap();
    if (state.person) { seedUnavailFromPrefs(); }
    checkAdminAccess();
  });
})(typeof window !== "undefined" ? window : globalThis);
