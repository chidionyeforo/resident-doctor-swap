/* Resident Doctor Swap — matching engine + UI
   Data shipped in window.ROTA_DATA (see data.js).
   Engine is written as pure functions so it can be unit-tested in Node. */

(function (global) {
  "use strict";

  // ---- class / compatibility ---------------------------------------------
  // The swappable on-call shifts and their "class". Same class = swappable.
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
  function Engine(data) {
    this.data = data;
    this.idxByIso = {};
    data.dates.forEach(function (d, i) { this.idxByIso[d.iso] = i; }, this);
    this.staffByLabel = {};
    data.staff.forEach(function (s) { this.staffByLabel[s.label] = s; }, this);
  }

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

  // Group a sorted list of day-indices for a person into blocks of
  // consecutive days that share the same shift class.
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

  // Count protected rest days (OFF / LTFT / not-on-rota) immediately before & after a block.
  Engine.prototype._annotateRest = function (label, block) {
    var offish = { OFF: 1, LTFT: 1, INACTIVE: 1 };
    var before = 0, i = block.start - 1;
    while (i >= 0 && offish[this.cell(label, i).s]) { before++; i--; }
    var after = 0, j = block.end + 1, n = this.data.dates.length;
    while (j < n && offish[this.cell(label, j).s]) { after++; j++; }
    block.offBefore = before; block.offAfter = after;
    block.len = block.idxs.length;
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

  // Can `label` work a NEW shift on day `idx`? Returns {ok, hard, warn, reason}.
  Engine.prototype.freeToWork = function (label, idx) {
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

  // Equity score between two blocks of the same class (lower = closer match).
  function equity(a, b) {
    var s = Math.abs(a.offBefore - b.offBefore)
          + Math.abs(a.offAfter - b.offAfter)
          + Math.abs(a.len - b.len) * 0.5;
    return s;
  }

  /* Core search.
     reqLabel: requester's slot label
     selIdxs: array of day-indices the requester wants off (each is one of their on-call days)
     unavail: object set of day-indices the requester cannot swap INTO (optional)
     Returns { reqBlocks, swaps:[...], coverOnly:[...], ineligible:[...] } */
  Engine.prototype.findSwaps = function (reqLabel, selIdxs, unavail) {
    unavail = unavail || {};
    var self = this;
    var sel = {}; selIdxs.forEach(function (i) { sel[i] = 1; });
    var reqBlocks = this.groupBlocks(reqLabel, selIdxs);
    var selNight = {}; selIdxs.forEach(function (i) { if (shiftClass(self.cell(reqLabel, i).v) === "NIGHT") selNight[i] = 1; });

    var swaps = [], coverOnly = [], ineligible = [];

    this.data.staff.forEach(function (C) {
      if (!C.candidate || C.label === reqLabel) return;
      var cl = C.label;
      var warnings = [], reasons = [];

      // --- INCOMING: can C take every selected day? ---
      var incomingOk = true;
      selIdxs.forEach(function (i) {
        var f = self.freeToWork(cl, i);
        if (!f.ok) { incomingOk = false; reasons.push(C.label + " can't take " + self.data.dates[i].iso + ": " + f.reason); }
        else if (f.warn) warnings.push("On " + self.data.dates[i].iso + ", " + f.warn);
      });
      // nights ceiling for C after taking the selected nights
      if (incomingOk && Object.keys(selNight).length) {
        var cn = self._nightSet(cl);
        Object.keys(selNight).forEach(function (i) { cn[i] = 1; });
        if (maxRun(cn) > 4) { incomingOk = false; reasons.push(C.label + " would exceed 4 nights in a row by taking these nights"); }
      }
      if (!incomingOk) { ineligible.push({ label: C.label, reasons: reasons }); return; }

      // --- RETURN: a compatible shift from C that the requester can take ---
      var cBlocks = self.groupBlocks(cl, self.oncallShifts(cl).map(function (s) { return s.idx; }))
        .filter(function (b) { return b.idxs.every(function (i) { return !sel[i]; }); });
      var usedReturnNight = {};               // nights R would gain
      var assignments = [], allMatched = true;

      reqBlocks.forEach(function (rb) {
        var best = null;
        cBlocks.forEach(function (cb) {
          if (cb.used || cb.cls !== rb.cls) return;
          // requester must be free on every day of this return block
          var rOk = true, rWarn = [];
          cb.idxs.forEach(function (i) {
            if (unavail[i]) { rOk = false; return; }
            var f = self.freeToWork(reqLabel, i);
            if (!f.ok) rOk = false; else if (f.warn) rWarn.push("On " + self.data.dates[i].iso + ", " + f.warn + " (you)");
          });
          if (!rOk) return;
          var sc = equity(rb, cb);
          if (!best || sc < best.sc) best = { cb: cb, sc: sc, rWarn: rWarn };
        });
        if (best) { best.cb.used = true; assignments.push({ rb: rb, cb: best.cb, sc: best.sc, rWarn: best.rWarn }); }
        else allMatched = false;
      });

      if (allMatched) {
        // requester nights ceiling after the swap
        var rn = self._nightSet(reqLabel);
        Object.keys(selNight).forEach(function (i) { delete rn[i]; });
        assignments.forEach(function (a) { if (a.rb.cls === "NIGHT") a.cb.idxs.forEach(function (i) { rn[i] = 1; }); });
        if (maxRun(rn) > 4) { ineligible.push({ label: C.label, reasons: ["This swap would put you over 4 nights in a row"] }); return; }

        var score = 0; assignments.forEach(function (a) { score += a.sc; a.rWarn.forEach(function (w) { warnings.push(w); }); });
        swaps.push({ label: C.label, grade: C.grade, dept: C.dept, assignments: assignments, score: score, warnings: warnings });
      } else {
        coverOnly.push({ label: C.label, grade: C.grade, dept: C.dept, warnings: warnings });
      }
    });

    function rank(a, b) {
      if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
      if ((a.score || 0) !== (b.score || 0)) return (a.score || 0) - (b.score || 0);
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }
    swaps.sort(rank); coverOnly.sort(rank);
    return { reqBlocks: reqBlocks, swaps: swaps, coverOnly: coverOnly, ineligible: ineligible };
  };

  global.RotaEngine = Engine;
  global.RotaEngine.shiftClass = shiftClass;
  global.RotaEngine.CLASS_LABEL = CLASS_LABEL;

  // ---- UI (browser only) --------------------------------------------------
  if (typeof document === "undefined") return;

  var data = global.ROTA_DATA;
  var engine = new Engine(data);
  var state = { person: null, selected: {}, unavail: {} };

  var $ = function (s) { return document.querySelector(s); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fmt(iso, dow) {
    var d = new Date(iso + "T00:00:00");
    var s = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    return (dow ? dow + " " : "") + s;
  }
  function chip(type) { var c = el("span", "chip chip-" + shiftClass(type), type); return c; }

  // Populate the person picker
  (function initPicker() {
    var sel = $("#person");
    data.staff.slice().sort(function (a, b) {
      return ("" + a.label).localeCompare("" + b.label, undefined, { numeric: true });
    }).forEach(function (s) {
      var o = el("option"); o.value = s.label;
      o.textContent = s.label + "  ·  " + s.grade + "  ·  " + s.dept + (s.hasOncall ? "" : "  (no on-calls)");
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { state.person = sel.value || null; state.selected = {}; state.unavail = {}; renderPerson(); });
  })();

  function renderPerson() {
    var wrap = $("#shifts"); wrap.innerHTML = "";
    $("#results").innerHTML = "";
    $("#unavail-wrap").style.display = "none";
    if (!state.person) { $("#step2").style.display = "none"; return; }
    var s = engine.staffByLabel[state.person];
    var shifts = engine.oncallShifts(state.person);
    $("#step2").style.display = "block";
    var meta = $("#person-meta");
    meta.innerHTML = "";
    meta.appendChild(el("span", "tag", s.grade));
    meta.appendChild(el("span", "tag", s.dept));
    meta.appendChild(el("span", "tag", "On rota " + fmt(s.active[0]) + " – " + fmt(s.active[1])));

    if (!shifts.length) { wrap.appendChild(el("p", "empty", "This person holds no swappable on-call shifts in the rota.")); return; }

    // group into blocks for display
    var blocks = engine.groupBlocks(state.person, shifts.map(function (x) { return x.idx; }));
    blocks.forEach(function (b) {
      var card = el("div", "shift-row");
      card.dataset.idxs = b.idxs.join(",");
      var left = el("div", "shift-main");
      var dates = el("div", "shift-dates");
      b.idxs.forEach(function (i) {
        var d = data.dates[i];
        var t = el("span", "shift-day");
        t.appendChild(chip(engine.cell(state.person, i).v));
        t.appendChild(el("span", "shift-date", fmt(d.iso, d.dow)));
        dates.appendChild(t);
      });
      left.appendChild(dates);
      left.appendChild(el("div", "rest", restText(b)));
      card.appendChild(left);
      var btn = el("button", "pick", "Want this off");
      btn.addEventListener("click", function () { toggleBlock(b, card, btn); });
      card.appendChild(btn);
      wrap.appendChild(card);
    });
  }

  function restText(b) {
    return CLASS_LABEL[b.cls] + " · " + b.len + (b.len > 1 ? " days" : " day")
      + " · " + b.offBefore + " off before, " + b.offAfter + " off after";
  }

  function toggleBlock(b, card, btn) {
    var on = b.idxs.every(function (i) { return state.selected[i]; });
    b.idxs.forEach(function (i) { if (on) delete state.selected[i]; else state.selected[i] = 1; });
    card.classList.toggle("selected", !on);
    btn.textContent = on ? "Want this off" : "Selected ✓";
    var any = Object.keys(state.selected).length > 0;
    $("#unavail-wrap").style.display = any ? "block" : "none";
    $("#find").style.display = any ? "inline-flex" : "none";
    if (!any) $("#results").innerHTML = "";
  }

  // Optional "unavailable to swap into" date picker
  (function initUnavail() {
    var input = $("#unavail-date");
    input.min = data.dateStart; input.max = data.dateEnd;
    $("#unavail-add").addEventListener("click", function () {
      var iso = input.value; if (!iso) return;
      var idx = engine.idxByIso[iso];
      if (idx == null) { flash($("#unavail-msg"), "That date isn't in the rota period."); return; }
      state.unavail[idx] = 1; input.value = ""; renderUnavail();
    });
  })();
  function renderUnavail() {
    var list = $("#unavail-list"); list.innerHTML = "";
    Object.keys(state.unavail).map(Number).sort(function (a, b) { return a - b; }).forEach(function (idx) {
      var t = el("span", "pill", fmt(data.dates[idx].iso, data.dates[idx].dow));
      var x = el("button", "pill-x", "×"); x.addEventListener("click", function () { delete state.unavail[idx]; renderUnavail(); });
      t.appendChild(x); list.appendChild(t);
    });
  }
  function flash(node, msg) { node.textContent = msg; setTimeout(function () { node.textContent = ""; }, 3000); }

  $("#find").addEventListener("click", function () {
    var selIdxs = Object.keys(state.selected).map(Number);
    if (!selIdxs.length) return;
    var res = engine.findSwaps(state.person, selIdxs, state.unavail);
    renderResults(res);
  });

  function renderResults(res) {
    var root = $("#results"); root.innerHTML = "";
    root.appendChild(summaryCard(res.reqBlocks));

    if (res.swaps.length) {
      root.appendChild(el("h3", "res-h", "Best people to ask (full swap)"));
      res.swaps.slice(0, 8).forEach(function (sw, i) { root.appendChild(swapCard(sw, i === 0)); });
    } else {
      var none = el("div", "card note");
      none.appendChild(el("strong", null, "No clean reciprocal swap found."));
      none.appendChild(el("p", null, "No one currently has a matching shift to trade back for every block you selected. The people below could cover your shift; the rota team would arrange a return shift manually."));
      root.appendChild(none);
    }

    if (res.coverOnly.length) {
      root.appendChild(el("h3", "res-h", "Could cover your shift (no automatic return shift)"));
      res.coverOnly.slice(0, 6).forEach(function (c) { root.appendChild(coverCard(c)); });
    }

    var det = el("details", "why");
    det.appendChild(el("summary", null, "Why others weren't suggested (" + res.ineligible.length + ")"));
    var ul = el("ul");
    res.ineligible.slice(0, 40).forEach(function (x) {
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
      b.idxs.forEach(function (i) { row.appendChild(chip(engine.cell(state.person, i).v)); });
      row.appendChild(el("span", "sum-dates", b.idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(" · ")));
      c.appendChild(row);
    });
    return c;
  }

  function swapCard(sw, top) {
    var c = el("div", "card swap" + (top ? " top" : ""));
    if (top) c.appendChild(el("div", "ribbon", "Best match"));
    var head = el("div", "swap-head");
    head.appendChild(el("span", "slot", "Slot " + sw.label));
    head.appendChild(el("span", "tag", sw.grade));
    head.appendChild(el("span", "tag", sw.dept));
    c.appendChild(head);

    sw.assignments.forEach(function (a) {
      var ex = el("div", "exchange");
      var r1 = el("div", "leg");
      r1.appendChild(el("span", "leg-label", "They take"));
      a.rb.idxs.forEach(function (i) { r1.appendChild(chip(engine.cell(state.person, i).v)); });
      r1.appendChild(el("span", "leg-dates", a.rb.idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(" · ")));
      var r2 = el("div", "leg");
      r2.appendChild(el("span", "leg-label", "You take"));
      a.cb.idxs.forEach(function (i) { r2.appendChild(chip(engine.cell(sw.label, i).v)); });
      r2.appendChild(el("span", "leg-dates", a.cb.idxs.map(function (i) { return fmt(data.dates[i].iso, data.dates[i].dow); }).join(" · ")));
      ex.appendChild(r1); ex.appendChild(el("div", "swap-arrow", "⇅")); ex.appendChild(r2);
      ex.appendChild(el("div", "equity", "Rest match: " + a.rb.offBefore + "/" + a.rb.offAfter + " vs " + a.cb.offBefore + "/" + a.cb.offAfter + " off before/after"));
      c.appendChild(ex);
    });

    if (sw.warnings.length) {
      var w = el("div", "warns");
      sw.warnings.forEach(function (m) { w.appendChild(el("div", "warn", "⚠ " + m)); });
      c.appendChild(w);
    } else {
      c.appendChild(el("div", "clean", "✓ No rest-day or night-limit issues for either of you"));
    }
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

  // footer meta
  $("#rota-range").textContent = fmt(data.dateStart) + " – " + fmt(data.dateEnd);
})(typeof window !== "undefined" ? window : globalThis);
