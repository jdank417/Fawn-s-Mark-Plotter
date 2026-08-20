(function () {
  "use strict";

  const EARTH_RADIUS_NM = 3440.065;
  const GPS_COLOR = "#1a73e8";
  const SEPARATOR_RE = /[\s,;>→-]+/;

  const state = {
    data: null,
    listKey: null,
    course: [], // { uid, mark, overrideLat, overrideLon }
    committed: false,
    lastTotalNm: 0,
    myPosition: null, // { lat, lon, accuracy }
    watching: false,
    gpsCentered: false,
    startPickMode: false,
    legsData: [], // [{ legIndex, fromLabel, toLabel, toMark, distNm, trueHdg, magHdg, missing }]
    currentLegIndex: null,
    entryMode: "classic", // "classic" | "committee" (beta committee-boat board)
    // Course-wide rounding from the RC's green flag: null = not signalled,
    // "S" = leave marks to starboard, "P" = leave marks to port. Individual
    // marks can override this via their own slot flag.
    defaultRounding: null,
    // Code flag T flown by the RC: sail the course twice.
    twiceAround: false,
    // uid of the course entry acting as the start line, once one has been
    // set from GPS or a charted mark.
    startUid: null,
    // uid of the entry currently being given a position, when the user picked
    // a specific mark to place rather than the start.
    positionTargetUid: null,
  };

  let uidCounter = 0;
  let map = null;
  let courseLayer = null;
  let gpsLayer = null;
  let watchId = null;
  // Which input the suggestion list is attached to, and what picking from it
  // should do. Lets the same list serve the classic input and the committee
  // board's slots.
  let suggestAnchor = null;
  let suggestTarget = null;
  let lastGeometryKey = null; // skips map teardown when only text changed
  let lastPositionKey = null; // skips re-fitting the view when nothing moved
  let legLayers = []; // parallel to legsData: [{ polyline, arrow, targetMarker } | null]
  let markerByIndex = []; // parallel to state.course / mapPoints: [L.Marker | null]

  const el = {
    clubSelect: document.getElementById("club-select"),
    seriesSelect: document.getElementById("series-select"),
    mbsaListSelect: document.getElementById("mbsa-list-select"),
    listHint: document.getElementById("list-hint"),
    markInput: document.getElementById("mark-input"),
    markInputWrap: document.querySelector(".mark-input-wrap"),
    suggestions: document.getElementById("mark-suggestions"),
    addMarkBtn: document.getElementById("add-mark-btn"),
    courseChips: document.getElementById("course-chips"),
    useMagnetic: document.getElementById("use-magnetic"),
    variation: document.getElementById("variation"),
    clearCourseBtn: document.getElementById("clear-course-btn"),
    gpsStartBtn: document.getElementById("gps-start-btn"),
    markStartBtn: document.getElementById("mark-start-btn"),
    setCourseBtn: document.getElementById("set-course-btn"),
    buildStatus: document.getElementById("build-status"),
    sheet: document.getElementById("sheet"),
    sheetToggle: document.getElementById("sheet-toggle"),
    sheetToggleLabel: document.getElementById("sheet-toggle-label"),
    sheetToggleIcon: document.getElementById("sheet-toggle-icon"),
    legStrip: document.getElementById("leg-strip"),
    infoBtn: document.getElementById("info-btn"),
    locateBtn: document.getElementById("locate-btn"),
    legNav: document.getElementById("leg-nav"),
    legPrevBtn: document.getElementById("leg-prev-btn"),
    legNextBtn: document.getElementById("leg-next-btn"),
    legNavStep: document.getElementById("leg-nav-step"),
    legNavTargetBadge: document.getElementById("leg-nav-target-badge"),
    legNavHeading: document.getElementById("leg-nav-heading"),
    legNavDist: document.getElementById("leg-nav-dist"),
    legNavRound: document.getElementById("leg-nav-round"),
    modeClassicBtn: document.getElementById("mode-classic-btn"),
    modeCommitteeBtn: document.getElementById("mode-committee-btn"),
    classicEntry: document.getElementById("classic-entry"),
    committeeEntry: document.getElementById("committee-entry"),
    rcBoard: document.getElementById("rc-board"),
    rcGreenFlag: document.getElementById("rc-green-flag"),
    rcGreenCaption: document.getElementById("rc-green-caption"),
    rcTwiceFlag: document.getElementById("rc-twice-flag"),
    rcHint: document.getElementById("rc-hint"),
  };

  fetch("data/marks.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      state.data = data;
      init();
    })
    .catch((err) => {
      setStatus("Could not load mark data (" + err.message + "). Try reloading.", true);
    });

  function init() {
    populateClubs();
    el.clubSelect.addEventListener("change", onClubChange);
    el.seriesSelect.addEventListener("change", onSeriesOrListChange);
    el.mbsaListSelect.addEventListener("change", onSeriesOrListChange);
    el.addMarkBtn.addEventListener("click", addMarkToCourse);
    el.markInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (state.startPickMode) {
          const mark = resolveMark(el.markInput.value);
          if (mark) {
            finishPickStartFromMark(mark);
          } else {
            setStatus("No charted mark found for “" + el.markInput.value + "”.", true);
            el.markInput.select();
          }
          return;
        }
        addMarkToCourse();
      } else if (e.key === "Escape") {
        cancelStartPickMode();
        hideSuggestions();
      }
    });
    el.markInput.addEventListener("input", () => showSuggestions(el.markInput.value));
    el.markInput.addEventListener("focus", () => showSuggestions(el.markInput.value));
    // Also reopen on tap: once the input already has focus no focus event
    // fires, so tapping it again would otherwise leave the list closed.
    el.markInput.addEventListener("click", () => showSuggestions(el.markInput.value));
    // Selection fires on click, not pointerdown: on a touch screen a scroll
    // gesture begins with a pointerdown on a list item, so selecting there
    // made the list impossible to scroll without picking something.
    el.suggestions.addEventListener("click", onSuggestionClick);
    // Keep the input focused when picking with a mouse (mousedown would
    // otherwise blur it and close the list before the click lands). Touch
    // scrolling is unaffected because this only suppresses the blur.
    el.suggestions.addEventListener("mousedown", (e) => e.preventDefault());
    // Dismiss on click rather than pointerdown: the list sits in the layout
    // flow, so collapsing it on pointerdown shifted everything below it
    // upward before the tap resolved, and taps landed on the wrong control.
    document.addEventListener("click", (e) => {
      if (el.markInputWrap.contains(e.target) || el.suggestions.contains(e.target)) return;
      // Board slot inputs drive the same list; clicking one must not close it.
      if (e.target.closest(".rc-slot-input")) return;
      // The start buttons open the picker themselves; since this runs on the
      // bubble phase it would otherwise close what they just opened.
      if (e.target.closest("#mark-start-btn, #gps-start-btn")) return;
      hideSuggestions();
      cancelStartPickMode();
    });

    el.clearCourseBtn.addEventListener("click", clearCourse);
    el.setCourseBtn.addEventListener("click", setCourse);
    el.gpsStartBtn.addEventListener("click", setStartFromGps);
    el.markStartBtn.addEventListener("click", beginPickStartFromMark);
    el.useMagnetic.addEventListener("change", () => { if (state.committed) renderResults(); });
    let variationTimer = null;
    el.variation.addEventListener("input", () => {
      clearTimeout(variationTimer);
      variationTimer = setTimeout(() => { if (state.committed) renderResults(); }, 200);
    });
    el.sheetToggle.addEventListener("click", toggleSheet);
    el.infoBtn.addEventListener("click", showInfo);
    el.locateBtn.addEventListener("click", onLocateClick);

    el.modeClassicBtn.addEventListener("click", () => setEntryMode("classic"));
    el.modeCommitteeBtn.addEventListener("click", () => setEntryMode("committee"));
    el.rcGreenFlag.addEventListener("click", cycleGreenFlag);
    el.rcTwiceFlag.addEventListener("click", toggleTwiceAround);

    // Keep the overlay anchored if the sheet scrolls or the viewport changes.
    const reanchor = () => { if (!el.suggestions.hidden) positionSuggestions(); };
    document.getElementById("sheet-body").addEventListener("scroll", reanchor, { passive: true });
    window.addEventListener("resize", reanchor);

    el.legPrevBtn.addEventListener("click", () => setCurrentLeg((state.currentLegIndex ?? 0) - 1, { pan: true }));
    el.legNextBtn.addEventListener("click", () => setCurrentLeg((state.currentLegIndex ?? 0) + 1, { pan: true }));
    el.legStrip.addEventListener("click", (e) => {
      const card = e.target.closest(".leg-card");
      if (!card || card.dataset.legIndex == null) return;
      setCurrentLeg(Number(card.dataset.legIndex), { pan: true });
    });

    onClubChange();
    ensureMap();
  }

  // ---------- Club / series / list selection ----------

  function populateClubs() {
    el.clubSelect.innerHTML = "";
    Object.keys(state.data.clubs).forEach((code) => {
      const club = state.data.clubs[code];
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = club.name + " (" + code + ")";
      el.clubSelect.appendChild(opt);
    });
  }

  function currentClub() {
    return state.data.clubs[el.clubSelect.value];
  }

  function onClubChange() {
    const club = currentClub();
    if (club.weeknight_series) {
      el.seriesSelect.hidden = false;
      el.seriesSelect.innerHTML = "";
      const weeknightOpt = document.createElement("option");
      weeknightOpt.value = "weeknight";
      weeknightOpt.textContent = club.weeknight_series.label;
      const mbsaOpt = document.createElement("option");
      mbsaOpt.value = "mbsa";
      mbsaOpt.textContent = "Weekend / regatta (MBSA)";
      el.seriesSelect.appendChild(weeknightOpt);
      el.seriesSelect.appendChild(mbsaOpt);
    } else {
      el.seriesSelect.hidden = true;
    }
    onSeriesOrListChange();
  }

  function onSeriesOrListChange() {
    const club = currentClub();
    const usesMbsa = !club.weeknight_series || el.seriesSelect.value === "mbsa";
    el.mbsaListSelect.hidden = !usesMbsa;
    state.listKey = usesMbsa ? el.mbsaListSelect.value : club.weeknight_series.id;

    const list = state.data.lists[state.listKey];
    el.listHint.textContent = list.label + " — " + list.marks.length + " marks.";

    state.course = [];
    state.committed = false;
    state.startUid = null;
    state.positionTargetUid = null;
    renderPlacementButtons();
    renderChips();
    renderBoard();
    hideLegStrip();
    setSheetExpanded(true);
    updateSheetToggleLabel();
    setStatus("");
    hideSuggestions();
  }

  function currentMarks() {
    return state.data.lists[state.listKey].marks;
  }

  // ---------- Course building ----------

  function resolveMarkById(rawInput) {
    const raw = (rawInput || "").trim();
    if (!raw) return null;
    return currentMarks().find((m) => m.id.toLowerCase() === raw.toLowerCase()) || null;
  }

  function resolveMark(rawInput) {
    const raw = (rawInput || "").trim();
    if (!raw) return null;
    const byId = resolveMarkById(raw);
    if (byId) return byId;
    // Name search needs at least two characters. A single letter is a mark
    // designation, not a search term: matching it against names let a letter
    // that isn't used tonight resolve to an unrelated mark (e.g. "W" in MBSA
    // List B has no such mark, but matches the name "Powers LG").
    if (raw.length < 2) return null;
    const lower = raw.toLowerCase();
    const nameMatches = currentMarks().filter((m) => m.name.toLowerCase().includes(lower));
    if (nameMatches.length === 1) return nameMatches[0];
    return null;
  }

  // Rounding the same mark twice in a row isn't a real course, and it makes
  // a zero-length leg that plots two markers on the same spot with a
  // meaningless bearing — which reads as a missing leg.
  function lastCourseMark() {
    return state.course.length ? state.course[state.course.length - 1].mark : null;
  }

  function isRepeatOfLast(mark) {
    const last = lastCourseMark();
    return !!last && last.id === mark.id;
  }

  // Split a whole-course string into individual mark tokens. Accepts
  // whitespace, commas, semicolons, hyphens, ">" or "→" as separators in any
  // mix (e.g. "A H F G", "A,H,F,G", "A-H-F-G"). With no separators at all
  // (e.g. "AHFG"), greedily match known mark IDs longest-first so this also
  // works for lists with multi-character IDs (MBSA's "21", "1DL", etc.), not
  // just single-letter club lists.
  function splitMarkTokens(rawInput) {
    const trimmed = (rawInput || "").trim();
    if (!trimmed) return [];
    if (SEPARATOR_RE.test(trimmed)) {
      return trimmed.split(SEPARATOR_RE).map((s) => s.trim()).filter(Boolean);
    }
    return greedySplitConcatenated(trimmed);
  }

  function greedySplitConcatenated(raw) {
    const ids = currentMarks().map((m) => m.id).sort((a, b) => b.length - a.length);
    const upper = raw.toUpperCase();
    const tokens = [];
    let i = 0;
    while (i < upper.length) {
      const match = ids.find((id) => upper.startsWith(id.toUpperCase(), i));
      if (!match) return [raw]; // can't fully tokenize — let the caller's error path handle it
      tokens.push(match);
      i += match.length;
    }
    return tokens;
  }

  function pushMarkToCourse(mark) {
    state.course.push({ uid: ++uidCounter, mark: mark, overrideLat: null, overrideLon: null, rounding: null });
  }

  // ---------- Rounding (which side you leave each mark on) ----------

  // A mark's own flag wins; otherwise fall back to the course-wide green
  // flag. null means the RC hasn't signalled a rounding, so we show none
  // rather than guessing.
  function effectiveRounding(entry) {
    return entry.rounding || state.defaultRounding;
  }

  // The start is whichever entry a start position was applied to. Before
  // that, fall back to a leading mark the club's own list calls a start
  // (BYC "Portable Start/Finish", JYC "Portable Start"), so a course typed
  // straight in still shows where it begins.
  function isStartEntry(entry, index) {
    if (state.startUid != null) return entry.uid === state.startUid;
    return index === 0 && /start/i.test(entry.mark.name || "");
  }

  function roundingWord(rounding) {
    if (rounding === "S") return "leave to starboard";
    if (rounding === "P") return "leave to port";
    return "";
  }

  function roundingTagHtml(rounding) {
    if (!rounding) return "";
    return " <span class='round-tag round-" + rounding + "'>" + rounding + "</span>";
  }

  function cycleRounding(current) {
    if (!current) return "S";
    if (current === "S") return "P";
    return null;
  }

  // keepSuggestions leaves the list up after a pick, so a course can be
  // built by tapping straight down it without reopening between marks.
  function addMarkObject(mark, opts) {
    if (isRepeatOfLast(mark)) {
      setStatus(mark.label + " is already the last mark.", true);
      if (opts && opts.keepSuggestions) showSuggestions("");
      return;
    }
    pushMarkToCourse(mark);
    el.markInput.value = "";
    setStatus("");
    renderChips();
    renderBoard();
    if (opts && opts.keepSuggestions) {
      showSuggestions("");
    } else {
      hideSuggestions();
      el.markInput.focus();
    }
  }

  function addMarkToCourse() {
    const tokens = splitMarkTokens(el.markInput.value);
    if (tokens.length === 0) return;

    if (tokens.length === 1) {
      const mark = resolveMark(tokens[0]);
      if (!mark) {
        setStatus("No mark found for “" + tokens[0] + "”.", true);
        el.markInput.select();
        return;
      }
      addMarkObject(mark);
      return;
    }

    // Multiple marks in one string: resolve each token against exact mark
    // IDs only (not the fuzzy name search) and require all of them to
    // resolve before adding any, so a typo doesn't leave a half-built
    // course. ID-only avoids misreading a full multi-word mark name, like
    // "Tinkers Gong", as two separate marks — if the tokens don't all
    // resolve as IDs, fall back to searching the whole string as one name.
    const resolved = [];
    const unresolved = [];
    tokens.forEach((t) => {
      const mark = resolveMarkById(t);
      if (mark) resolved.push(mark);
      else unresolved.push(t);
    });
    if (unresolved.length > 0) {
      const wholeMatch = resolveMark(el.markInput.value);
      if (wholeMatch) {
        addMarkObject(wholeMatch);
        return;
      }
      setStatus("No mark found for: " + unresolved.join(", "), true);
      el.markInput.select();
      return;
    }
    const repeat = resolved.find((m, i) => {
      const prev = i === 0 ? lastCourseMark() : resolved[i - 1];
      return prev && prev.id === m.id;
    });
    if (repeat) {
      setStatus("“" + repeat.label + "” repeats back-to-back — check the course.", true);
      el.markInput.select();
      return;
    }

    resolved.forEach(pushMarkToCourse);
    el.markInput.value = "";
    hideSuggestions();
    el.markInput.focus();
    setStatus("Added " + resolved.length + " marks: " + resolved.map((m) => m.label).join("-"));
    renderChips();
  }

  // ---------- Mark suggestion dropdown ----------

  function showSuggestions(filterText, anchorEl, target) {
    suggestAnchor = anchorEl || el.markInput;
    suggestTarget = target || (state.startPickMode ? { kind: "startPick" } : { kind: "classic" });
    const filter = (filterText || "").trim().toLowerCase();
    const pool = state.startPickMode ? currentMarks().filter((m) => m.lat != null && m.lon != null) : currentMarks();
    const matches = filter
      ? pool.filter((m) => m.id.toLowerCase().startsWith(filter) || m.name.toLowerCase().includes(filter))
      : pool;

    el.suggestions.innerHTML = "";
    if (matches.length === 0) {
      const li = document.createElement("li");
      li.className = "sug-empty";
      li.textContent = "No matching marks.";
      el.suggestions.appendChild(li);
    } else {
      matches.forEach((m) => {
        const li = document.createElement("li");
        li.dataset.id = m.id;
        const label = document.createElement("span");
        label.className = "sug-label";
        label.textContent = m.label;
        const name = document.createElement("span");
        name.className = "sug-name";
        name.textContent = m.name + (m.portable ? " (portable)" : "");
        li.appendChild(label);
        li.appendChild(name);
        el.suggestions.appendChild(li);
      });
    }
    el.suggestions.hidden = false;
    positionSuggestions();
  }

  function hideSuggestions() {
    el.suggestions.hidden = true;
  }

  // Anchor the overlay just above the input, growing upward over the map.
  function positionSuggestions() {
    const anchor = suggestAnchor || el.markInput;
    if (!anchor || !anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0) return; // input hidden (committee mode) — nothing to anchor to
    const gap = 6;
    const available = r.top - gap - 8;
    const minWidth = 220;
    const width = Math.min(window.innerWidth - 16, Math.max(r.width, minWidth));
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    el.suggestions.style.left = left + "px";
    el.suggestions.style.width = width + "px";
    el.suggestions.style.top = "auto";
    el.suggestions.style.bottom = (window.innerHeight - r.top + gap) + "px";
    el.suggestions.style.maxHeight = Math.max(140, Math.min(window.innerHeight * 0.5, available)) + "px";
  }

  function onSuggestionClick(e) {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const mark = currentMarks().find((m) => m.id === li.dataset.id);
    if (!mark) return;

    const target = suggestTarget || { kind: "classic" };

    if (state.startPickMode || target.kind === "startPick") {
      finishPickStartFromMark(mark);
      return;
    }

    if (target.kind === "slot") {
      const entry = state.course.find((c) => c.uid === target.uid);
      if (entry) {
        entry.mark = mark;
        renderChips();
        renderBoard();
        if (state.committed) renderResults();
      }
      hideSuggestions();
      return;
    }

    if (target.kind === "newSlot") {
      if (isRepeatOfLast(mark)) {
        setStatus(mark.label + " is already the last mark.", true);
        return;
      }
      pushMarkToCourse(mark);
      setStatus("");
      renderChips();
      renderBoard({ focusNewSlot: true });
      return;
    }

    addMarkObject(mark, { keepSuggestions: true });
  }

  function removeMark(uid) {
    state.course = state.course.filter((e) => e.uid !== uid);
    renderChips();
    renderBoard();
  }

  function clearCourse() {
    state.course = [];
    state.committed = false;
    state.startUid = null;
    state.positionTargetUid = null;
    renderPlacementButtons();
    cancelStartPickMode();
    renderChips();
    renderBoard();
    hideLegStrip();
    updateSheetToggleLabel();
    setStatus("");
  }

  function renderChips() {
    const priorScroll = el.courseChips.scrollLeft;
    el.courseChips.innerHTML = "";
    if (state.course.length === 0) {
      const empty = document.createElement("p");
      empty.className = "chips-empty";
      empty.textContent = "No marks yet — type or pick a mark above.";
      el.courseChips.appendChild(empty);
      return;
    }
    state.course.forEach((entry, idx) => {
      const chip = document.createElement("span");
      chip.className = "chip" + (entry.mark.portable ? " portable" : "");
      const label = document.createElement("span");
      label.textContent = (idx + 1) + ". " + entry.mark.label;
      chip.appendChild(label);

      if (resolvedPosition(entry) == null) {
        const setTag = document.createElement("button");
        setTag.type = "button";
        setTag.className = "set-tag" + (state.positionTargetUid === entry.uid ? " is-target" : "");
        setTag.textContent = "SET";
        setTag.title = entry.mark.label + " has no charted position — tap, then use GPS Start or Mark Start";
        setTag.addEventListener("click", (ev) => {
          ev.stopPropagation();
          choosePositionTarget(entry);
        });
        chip.appendChild(setTag);
      }

      if (isStartEntry(entry, idx)) {
        const startTag = document.createElement("span");
        startTag.className = "start-tag";
        startTag.textContent = "START";
        startTag.title = "Start line";
        chip.appendChild(startTag);
      }

      // Always render the rounding tag (muted when nothing is set yet) so
      // rounding is reachable from classic entry without the RC board.
      const rounding = effectiveRounding(entry);
      const inherited = !entry.rounding && !!rounding;
      const tag = document.createElement("span");
      tag.className = "round-tag" + (rounding ? " round-" + rounding : " round-unset") +
        (inherited ? " round-inherited" : "");
      tag.textContent = rounding || "–";
      tag.title = rounding
        ? entry.mark.label + " — " + roundingWord(rounding) +
          (inherited ? " (following the green flag)" : "") + " — tap to change"
        : entry.mark.label + " — no rounding set, tap to set";
      tag.addEventListener("click", () => {
        entry.rounding = cycleRounding(entry.rounding);
        renderChips();
        renderBoard();
        if (state.committed) renderResults();
      });
      chip.appendChild(tag);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "chip-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove " + entry.mark.label);
      removeBtn.addEventListener("click", () => removeMark(entry.uid));
      chip.appendChild(removeBtn);
      el.courseChips.appendChild(chip);
    });
    el.courseChips.scrollLeft = priorScroll;
  }

  // ---------- Beta: committee-boat course board ----------
  //
  // Mirrors what you actually read off the back of the RC boat: the course
  // letters in order on the board, and the green flag for starboard
  // roundings. Editing here drives the same state.course the classic entry
  // does, so the two modes are interchangeable at any point.

  function setEntryMode(mode) {
    state.entryMode = mode;
    const committee = mode === "committee";
    el.classicEntry.hidden = committee;
    el.committeeEntry.hidden = !committee;
    el.modeClassicBtn.classList.toggle("is-on", !committee);
    el.modeCommitteeBtn.classList.toggle("is-on", committee);
    el.modeClassicBtn.setAttribute("aria-selected", String(!committee));
    el.modeCommitteeBtn.setAttribute("aria-selected", String(committee));
    if (committee) {
      hideSuggestions();
      cancelStartPickMode();
      renderBoard();
    }
  }

  function greenFlagCaption() {
    if (state.defaultRounding === "S") return "Green — stbd";
    if (state.defaultRounding === "P") return "Red — port";
    return "No flag";
  }

  function renderGreenFlag() {
    el.rcGreenFlag.setAttribute("aria-pressed", String(state.defaultRounding === "S"));
    el.rcGreenFlag.dataset.rounding = state.defaultRounding || "";
    const cloth = el.rcGreenFlag.querySelector(".rc-flag-cloth");
    if (cloth) {
      cloth.style.background =
        state.defaultRounding === "S" ? "var(--buoy-green)"
        : state.defaultRounding === "P" ? "var(--buoy-red)"
        : "";
    }
    el.rcGreenCaption.textContent = greenFlagCaption();
    el.rcGreenFlag.title =
      state.defaultRounding
        ? "All marks: " + roundingWord(state.defaultRounding) + " — tap to change"
        : "No rounding signalled — tap to set";

    el.rcTwiceFlag.setAttribute("aria-pressed", String(state.twiceAround));
    el.rcTwiceFlag.title = state.twiceAround
      ? "Code flag T flying — sail the course twice"
      : "Tap to fly code flag T (twice around)";
  }

  function cycleGreenFlag() {
    state.defaultRounding = cycleRounding(state.defaultRounding);
    renderBoard();
    renderChips();
    if (state.committed) renderResults();
  }

  function toggleTwiceAround() {
    state.twiceAround = !state.twiceAround;
    renderBoard();
    if (state.committed) renderResults();
  }

  // The sequence actually sailed. With code flag T up, the course repeats
  // after the first mark — i.e. the start is passed once and everything
  // after it is sailed twice.
  function courseForLegs() {
    if (!state.twiceAround || state.course.length < 2) return state.course;
    return state.course.concat(state.course.slice(1));
  }

  function makeSlot(entry, index) {
    const slot = document.createElement("div");
    slot.className = "rc-slot" +
      (entry && resolvedPosition(entry) == null ? " needs-position" : "");

    const order = document.createElement("div");
    order.className = "rc-slot-order";
    order.textContent = entry ? String(index + 1) : "+";
    slot.appendChild(order);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "rc-slot-input";
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "characters");
    input.value = entry ? entry.mark.label : "";
    input.placeholder = entry ? "" : "–";
    input.setAttribute("aria-label", entry ? "Mark " + (index + 1) : "Add a mark");
    if (entry) input.dataset.uid = String(entry.uid);
    else input.dataset.newSlot = "true";
    slot.appendChild(input);

    const flagBtn = document.createElement("button");
    flagBtn.type = "button";
    flagBtn.className = "rc-slot-flag";
    const rounding = entry ? effectiveRounding(entry) : null;
    // A slot showing the green flag's value rather than its own is drawn
    // outlined instead of filled, so "following the flag" is visibly
    // different from a rounding set on this mark alone.
    const inherited = !!(entry && !entry.rounding && rounding);
    flagBtn.dataset.rounding = rounding || "";
    if (inherited) flagBtn.dataset.inherited = "true";
    flagBtn.textContent = rounding || "–";
    flagBtn.title = entry
      ? "Rounding for " + entry.mark.label +
        (rounding ? " — " + roundingWord(rounding) : "") +
        (inherited ? " (following the green flag)" : "") + " — tap to change"
      : "";
    if (!entry) flagBtn.disabled = true;
    slot.appendChild(flagBtn);

    if (entry) {
      flagBtn.addEventListener("click", () => {
        // Cycle this mark's own setting (unset -> S -> P -> unset) rather
        // than the effective value, so every tap visits a distinct state
        // even when the green flag already supplies a default.
        entry.rounding = cycleRounding(entry.rounding);
        renderBoard();
        renderChips();
        if (state.committed) renderResults();
      });

      const slotTarget = { kind: "slot", uid: entry.uid };
      input.addEventListener("focus", () => showSuggestions(input.value, el.rcBoard, slotTarget));
      input.addEventListener("click", () => showSuggestions(input.value, el.rcBoard, slotTarget));

      input.addEventListener("input", () => {
        const raw = input.value.trim();
        showSuggestions(raw, el.rcBoard, slotTarget);
        if (!raw) {
          slot.classList.remove("is-invalid");
          return;
        }
        const mark = resolveMarkById(raw) || resolveMark(raw);
        if (mark) {
          entry.mark = mark;
          slot.classList.remove("is-invalid");
          renderChips();
          if (state.committed) renderResults();
        } else {
          slot.classList.add("is-invalid");
        }
      });

      input.addEventListener("change", () => {
        if (!input.value.trim()) {
          state.course = state.course.filter((e) => e.uid !== entry.uid);
          renderBoard();
          renderChips();
          if (state.committed) renderResults();
          return;
        }
        renderBoard();
      });
    } else {
      const newTarget = { kind: "newSlot" };
      input.addEventListener("focus", () => showSuggestions(input.value, el.rcBoard, newTarget));
      input.addEventListener("click", () => showSuggestions(input.value, el.rcBoard, newTarget));

      // Trailing blank slot: typing a mark into it appends to the course.
      input.addEventListener("input", () => {
        const raw = input.value.trim();
        showSuggestions(raw, el.rcBoard, newTarget);
        if (!raw) return;
        const mark = resolveMarkById(raw) || resolveMark(raw);
        if (!mark) {
          slot.classList.add("is-invalid");
          return;
        }
        slot.classList.remove("is-invalid");
        if (isRepeatOfLast(mark)) {
          slot.classList.add("is-invalid");
          setStatus(mark.label + " is already the last mark.", true);
          return;
        }
        hideSuggestions();
        pushMarkToCourse(mark);
        renderChips();
        if (state.committed) renderResults();
        renderBoard({ focusNewSlot: true });
      });
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });

    return slot;
  }

  function renderBoard(opts) {
    if (state.entryMode !== "committee") return;
    el.rcBoard.onscroll = positionSuggestions;
    renderGreenFlag();
    el.rcBoard.innerHTML = "";
    state.course.forEach((entry, idx) => el.rcBoard.appendChild(makeSlot(entry, idx)));
    el.rcBoard.appendChild(makeSlot(null, state.course.length));

    const twiceNote = state.twiceAround ? " Flag T is up — the course is sailed twice." : "";
    el.rcHint.textContent = (state.course.length
      ? "Type the letters down the board in order; tap a mark's flag to set its rounding."
      : "Type the course letters down the board, first mark at the top.") + twiceNote;

    if (opts && opts.focusNewSlot) {
      const newInput = el.rcBoard.querySelector('input[data-new-slot="true"]');
      if (newInput) newInput.focus();
      el.rcBoard.scrollLeft = el.rcBoard.scrollWidth;
    }
  }

  function choosePositionTarget(entry) {
    state.positionTargetUid = state.positionTargetUid === entry.uid ? null : entry.uid;
    renderChips();
    renderBoard();
    renderPlacementButtons();
    setStatus(
      state.positionTargetUid
        ? "Placing " + entry.mark.label + " — tap GPS Start for here, or Mark Start to copy a charted mark."
        : ""
    );
  }

  function renderPlacementButtons() {
    const target = state.positionTargetUid != null
      ? state.course.find((e) => e.uid === state.positionTargetUid)
      : null;
    const suffix = target ? " → " + target.mark.label : " Start";
    el.gpsStartBtn.textContent = "📍 GPS" + suffix;
    el.markStartBtn.textContent = "⚓ Mark" + suffix;
  }

  function setStatus(msg, isError) {
    el.buildStatus.textContent = msg || "";
    el.buildStatus.classList.toggle("error", !!isError);
  }

  // ---------- Sheet expand/collapse ----------

  function setSheetExpanded(expanded) {
    el.sheet.classList.toggle("collapsed", !expanded);
  }

  function toggleSheet() {
    setSheetExpanded(el.sheet.classList.contains("collapsed"));
  }

  function updateSheetToggleLabel() {
    if (state.committed && state.course.length > 0) {
      const summary = state.course.map((e) => e.mark.label).join("-");
      el.sheetToggleLabel.textContent = summary + " · " + state.lastTotalNm.toFixed(1) + " nm";
    } else {
      el.sheetToggleLabel.textContent = "Build course";
    }
  }

  function hideLegStrip() {
    el.legStrip.hidden = true;
    el.legStrip.innerHTML = "";
    state.legsData = [];
    state.currentLegIndex = null;
    el.legNav.hidden = true;
    clearCourseFromMap();
  }

  // Clearing the course used to leave the old markers and track drawn on the
  // map, so the plot no longer matched the course you were editing.
  function clearCourseFromMap() {
    lastGeometryKey = null;
    lastPositionKey = null;
    legLayers = [];
    markerByIndex = [];
    if (courseLayer) courseLayer.clearLayers();
  }

  // ---------- Commit course / compute results ----------

  function setCourse() {
    if (state.course.length < 2) {
      setStatus("Add at least two marks to plot a course.", true);
      return;
    }
    // Every list carries RC-set marks with no charted position (BYC F/W,
    // JYC E/F/W, MBSA E/F/W). Plotting with one still unplaced is what
    // produced legs that looked missing, so require a position first.
    const unplaced = state.course.filter((e) => resolvedPosition(e) == null);
    if (unplaced.length > 0) {
      const names = [...new Set(unplaced.map((e) => e.mark.label))].join(", ");
      setStatus(
        "Set a position for " + names + " first — tap SET on the mark, or use GPS Start.",
        true
      );
      return;
    }
    state.committed = true;
    setStatus("");
    renderResults();
    setSheetExpanded(false);
  }

  function resolvedPosition(entry) {
    if (entry.overrideLat != null && entry.overrideLon != null) {
      return { lat: entry.overrideLat, lon: entry.overrideLon };
    }
    if (entry.mark.lat != null && entry.mark.lon != null) {
      return { lat: entry.mark.lat, lon: entry.mark.lon };
    }
    return null;
  }

  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    const dPhi = toRad(lat2 - lat1);
    const dLambda = toRad(lon2 - lon1);
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
  }

  function initialBearing(lat1, lon1, lat2, lon2) {
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    const dLambda = toRad(lon2 - lon1);
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function fmtHeading(deg) {
    return String(Math.round(deg)).padStart(3, "0") + "°";
  }

  function renderResults() {
    if (!state.committed) return;
    // Re-rendering resets scroll to the left, which yanked the strip back to
    // leg 1 whenever anything changed. Restore where the user had it.
    const priorScroll = el.legStrip.scrollLeft;
    el.legStrip.innerHTML = "";
    el.legStrip.hidden = false;

    const variation = parseFloat(el.variation.value) || 0;
    const showMag = el.useMagnetic.checked;
    let totalNm = 0;
    const mapPoints = [];
    const legsData = [];

    const sailed = courseForLegs();
    for (let i = 0; i < sailed.length; i++) {
      const entry = sailed[i];
      const pos = resolvedPosition(entry);
      mapPoints.push(
        pos
          ? {
              ...pos,
              label: entry.mark.label,
              name: entry.mark.name,
              govtLight: entry.mark.govt_light,
              portable: entry.mark.portable,
              rounding: effectiveRounding(entry),
              isStart: isStartEntry(entry, i),
            }
          : null
      );
      if (i === 0) continue;

      const legIndex = i - 1;
      const prev = resolvedPosition(sailed[i - 1]);
      const fromLabel = sailed[i - 1].mark.label;
      const toLabel = entry.mark.label;
      const rounding = effectiveRounding(entry);
      const card = document.createElement("div");
      card.dataset.legIndex = String(legIndex);
      const route = fromLabel + " → " + toLabel + roundingTagHtml(rounding);

      if (!prev || !pos) {
        card.className = "leg-card leg-missing";
        card.innerHTML = "<div class='leg-route'>" + route + "</div><div class='leg-detail'>position unknown</div>";
        el.legStrip.appendChild(card);
        legsData.push({ legIndex, fromLabel, toLabel, toMark: entry.mark, rounding, missing: true });
        continue;
      }

      const dist = haversineNm(prev.lat, prev.lon, pos.lat, pos.lon);

      // Two marks resolving to the same spot give a zero-length leg whose
      // bearing is meaningless — say so rather than printing a number that
      // looks real.
      if (dist < 0.005) {
        card.className = "leg-card leg-missing";
        card.innerHTML = "<div class='leg-route'>" + route + "</div>" +
          "<div class='leg-detail'>same position</div>";
        el.legStrip.appendChild(card);
        legsData.push({ legIndex, fromLabel, toLabel, toMark: entry.mark, rounding, missing: true });
        continue;
      }

      const trueHdg = initialBearing(prev.lat, prev.lon, pos.lat, pos.lon);
      const magHdg = ((trueHdg - variation) % 360 + 360) % 360;
      totalNm += dist;

      card.className = "leg-card";
      const hdgText = showMag ? fmtHeading(magHdg) + "M" : fmtHeading(trueHdg) + "T";
      card.innerHTML =
        "<div class='leg-route'>" + route + "</div>" +
        "<div class='leg-detail'>" + hdgText + " · " + dist.toFixed(2) + " nm</div>";
      el.legStrip.appendChild(card);
      legsData.push({ legIndex, fromLabel, toLabel, toMark: entry.mark, rounding, distNm: dist, trueHdg, magHdg, missing: false });
    }

    const totalCard = document.createElement("div");
    totalCard.className = "leg-total";
    totalCard.textContent = totalNm.toFixed(2) + " nm total";
    el.legStrip.appendChild(totalCard);

    el.legStrip.scrollLeft = priorScroll;
    state.lastTotalNm = totalNm;
    state.legsData = legsData;
    updateSheetToggleLabel();
    renderCourseOnMap(mapPoints);
    setCurrentLeg(state.currentLegIndex ?? 0, { pan: false });
  }

  // Step-through leg navigator (the right-edge control on the map): moves
  // through the course leg by leg, highlighting the target mark and its
  // segment on the map and showing that leg's heading/distance.
  function setCurrentLeg(idx, opts) {
    if (!state.legsData || state.legsData.length === 0) {
      el.legNav.hidden = true;
      return;
    }
    el.legNav.hidden = false;
    const clamped = Math.max(0, Math.min(idx, state.legsData.length - 1));
    state.currentLegIndex = clamped;
    const leg = state.legsData[clamped];

    el.legNavStep.textContent = (clamped + 1) + " / " + state.legsData.length;
    const colorInfo = classifyMarkColor(leg.toMark.govt_light, leg.toMark.portable);
    el.legNavTargetBadge.textContent = leg.toLabel;
    el.legNavTargetBadge.setAttribute("style", markBadgeStyleAttr(colorInfo));

    if (leg.rounding) {
      el.legNavRound.hidden = false;
      el.legNavRound.textContent = leg.rounding === "S" ? "STBD" : "PORT";
      el.legNavRound.className = "leg-nav-round round-text-" + leg.rounding;
      el.legNavRound.title = roundingWord(leg.rounding);
    } else {
      el.legNavRound.hidden = true;
    }

    if (leg.missing) {
      el.legNavHeading.textContent = "—";
      el.legNavDist.textContent = "position unknown";
    } else {
      const showMag = el.useMagnetic.checked;
      el.legNavHeading.textContent = showMag ? fmtHeading(leg.magHdg) + "M" : fmtHeading(leg.trueHdg) + "T";
      el.legNavDist.textContent = leg.distNm.toFixed(2) + " nm";
    }

    el.legPrevBtn.disabled = clamped === 0;
    el.legNextBtn.disabled = clamped === state.legsData.length - 1;

    el.legStrip.querySelectorAll(".leg-card").forEach((card) => {
      card.classList.toggle("active", Number(card.dataset.legIndex) === clamped);
    });

    highlightLeg(clamped, opts);
  }

  // ---------- Map ----------

  function ensureMap() {
    if (map) return;
    if (typeof L === "undefined") {
      const mapEl = document.getElementById("map");
      if (mapEl) {
        mapEl.innerHTML = "";
        const msg = document.createElement("p");
        msg.className = "map-fallback";
        msg.textContent = "Map unavailable — couldn't load the map library. Check your connection; headings below still work.";
        mapEl.appendChild(msg);
      }
      return;
    }
    map = L.map("map", { zoomControl: false, attributionControl: true }).setView([42.45, -70.82], 10);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    courseLayer = L.layerGroup().addTo(map);
    gpsLayer = L.layerGroup().addTo(map);
  }

  // Classify a mark's real on-the-water color from its charted light
  // characteristic (e.g. "R N \"2\"", "G C \"1\"", "RG \"FR\"..."). This
  // follows standard USCG/IALA-B lateral buoyage notation: a leading R/G is
  // a plain red/green mark (red nun / green can), RG or GR is a two-color
  // junction (preferred-channel) mark, RW is a red-and-white safe-water
  // mark, Y is a yellow special mark. Portable marks (RC-placed pins) have
  // no charted color, so they stay neutral.
  function classifyMarkColor(govtLight, isPortable) {
    if (isPortable || !govtLight) return { kind: "neutral" };
    const s = govtLight.trim().toUpperCase();
    const prefix = (s.match(/^([A-Z]+)/) || [, ""])[1];

    if (prefix === "RG" || prefix === "GR") {
      return { kind: "junction", top: prefix[0] === "R" ? "red" : "green", bottom: prefix[1] === "R" ? "red" : "green" };
    }
    if (prefix === "RW" || prefix === "WR") return { kind: "safe-water" };
    if (prefix.startsWith("R")) return { kind: "red" };
    if (prefix.startsWith("G")) return { kind: "green" };
    if (prefix === "Y") return { kind: "yellow" };
    if (prefix === "W" || prefix === "WHT") return /\bOR\b/.test(s) ? { kind: "orange" } : { kind: "white" };
    if (/ORANGE/.test(s)) return { kind: "orange" };
    // No leading color letter (e.g. a bare light characteristic like "13" QG) —
    // fall back to the flash color if the rhythm names one explicitly.
    if (/\bQG\b/.test(s)) return { kind: "green" };
    if (/\bQR\b/.test(s)) return { kind: "red" };
    return { kind: "neutral" };
  }

  function colorLabel(colorInfo) {
    switch (colorInfo.kind) {
      case "red": return "red";
      case "green": return "green";
      case "yellow": return "yellow";
      case "orange": return "orange";
      case "white": return "white";
      case "safe-water": return "red/white";
      case "junction": return colorInfo.top + "/" + colorInfo.bottom + " junction";
      default: return "";
    }
  }

  function markBadgeStyleAttr(colorInfo) {
    switch (colorInfo.kind) {
      case "red": return "background:var(--buoy-red);color:#fff";
      case "green": return "background:var(--buoy-green);color:#fff";
      case "yellow": return "background:var(--buoy-yellow);color:#1a1a1a";
      case "orange": return "background:var(--buoy-orange);color:#fff";
      case "white": return "background:var(--buoy-white);color:#1a1a1a;border-color:#888";
      case "safe-water":
        return "background:repeating-linear-gradient(90deg,var(--buoy-red) 0 4px,#fff 4px 8px);color:#1a1a1a";
      case "junction": {
        const c1 = colorInfo.top === "red" ? "var(--buoy-red)" : "var(--buoy-green)";
        const c2 = colorInfo.bottom === "red" ? "var(--buoy-red)" : "var(--buoy-green)";
        return "background:linear-gradient(to bottom," + c1 + " 50%," + c2 + " 50%);color:#fff";
      }
      default: return "";
    }
  }

  function markBadgeIcon(label, colorInfo, rounding, isStart) {
    const roundBadge = rounding
      ? "<span class='badge-round round-" + rounding + "'>" + rounding + "</span>"
      : "";
    const startBadge = isStart ? "<span class='badge-start'>START</span>" : "";
    return L.divIcon({
      className: "mark-icon",
      html: "<div class='mark-badge' style='" + markBadgeStyleAttr(colorInfo) + "'>" +
        label + roundBadge + startBadge + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      tooltipAnchor: [0, -16],
    });
  }

  function arrowIcon(bearingDeg) {
    return L.divIcon({
      className: "arrow-icon",
      html: "<div class='course-arrow' style='transform:rotate(" + bearingDeg.toFixed(1) + "deg)'></div>",
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function geometryKey(points) {
    return JSON.stringify(points.map((p) => (p ? [p.label, p.lat, p.lon, p.rounding || "", !!p.isStart] : null)));
  }

  function positionKey(points) {
    return JSON.stringify(points.map((p) => (p ? [p.lat, p.lon] : null)));
  }

  function renderCourseOnMap(points) {
    try {
      ensureMap();
      if (!map) return;

      // Changing the heading display (magnetic toggle, variation) re-renders
      // the results but not the geometry. Rebuilding the layers anyway made
      // every marker flash and re-fit the map under you, which is most of
      // what felt glitchy — so only rebuild when something actually moved.
      const key = geometryKey(points);
      if (key === lastGeometryKey) return;
      // Re-fit the view only when marks actually moved — flipping a rounding
      // flag redraws the badges but shouldn't yank the map out from under a
      // view you've panned or zoomed yourself.
      const positionsChanged = positionKey(points) !== lastPositionKey;
      lastPositionKey = positionKey(points);
      lastGeometryKey = key;

      courseLayer.clearLayers();
      markerByIndex = [];
      legLayers = [];

      const known = points.filter(Boolean);
      if (known.length === 0) return;

      points.forEach((p, idx) => {
        if (!p) {
          markerByIndex[idx] = null;
          return;
        }
        const colorInfo = classifyMarkColor(p.govtLight, p.portable);
        const colorWord = colorLabel(colorInfo);
        const roundWord = roundingWord(p.rounding);
        markerByIndex[idx] = L.marker([p.lat, p.lon], {
          icon: markBadgeIcon(p.label, colorInfo, p.rounding, p.isStart),
        })
          .addTo(courseLayer)
          .bindTooltip(
            (p.isStart ? "START — " : "") + p.label + " — " + p.name +
            (colorWord ? " (" + colorWord + ")" : "") +
            (roundWord ? " · " + roundWord : "")
          );
      });

      // One segment + direction arrow per leg, only where both endpoints are
      // known — kept in sync with state.legsData by index so the step-through
      // nav can highlight the right one. A leg with an unresolved endpoint
      // (e.g. an unplaced portable mark) simply has no segment, rather than
      // drawing a misleading line across the gap.
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        if (!a || !b) {
          legLayers[i] = null;
          continue;
        }
        const bearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        const polyline = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
          color: "#1d6fa5",
          weight: 3,
          dashArray: "6 4",
        }).addTo(courseLayer);
        const arrow = L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
          icon: arrowIcon(bearing),
          interactive: false,
          keyboard: false,
        }).addTo(courseLayer);
        legLayers[i] = { polyline, arrow, targetMarker: markerByIndex[i + 1] };
      }

      if (positionsChanged) {
        const bounds = L.latLngBounds(known.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds.pad(0.3), { animate: false });
      }
    } catch (err) {
      console.error("Map rendering failed:", err);
    }
  }

  function setMarkerActive(marker, active) {
    const root = marker && marker.getElement && marker.getElement();
    const badge = root && root.querySelector(".mark-badge");
    if (badge) badge.classList.toggle("mark-active", active);
  }

  // Highlight the leg at legIndex on the map: bold/bright segment + arrow,
  // a ring around its target mark, everything else dimmed. Optionally pans
  // the map to keep the target mark in view without changing zoom.
  function highlightLeg(legIndex, opts) {
    legLayers.forEach((layer, i) => {
      if (!layer) return;
      const isActive = i === legIndex;
      layer.polyline.setStyle({
        color: isActive ? "#ff5a1f" : "#1d6fa5",
        weight: isActive ? 5 : 3,
        dashArray: isActive ? null : "6 4",
        opacity: isActive ? 1 : 0.55,
      });
      if (isActive && layer.polyline.bringToFront) layer.polyline.bringToFront();
      const arrowRoot = layer.arrow.getElement && layer.arrow.getElement();
      const arrowShape = arrowRoot && arrowRoot.querySelector(".course-arrow");
      if (arrowShape) arrowShape.classList.toggle("arrow-active", isActive);
    });

    markerByIndex.forEach((marker) => setMarkerActive(marker, false));
    const activeLayer = legLayers[legIndex];
    if (activeLayer && activeLayer.targetMarker) {
      setMarkerActive(activeLayer.targetMarker, true);
      if (opts && opts.pan && map) {
        map.panTo(activeLayer.targetMarker.getLatLng(), { animate: true });
      }
    }
  }

  function showInfo() {
    const meta = state.data && state.data.meta;
    if (!meta) return;
    alert(meta.note + "\n\n" + meta.disclaimer);
  }

  // ---------- GPS ----------

  function onLocateClick() {
    if (!state.watching) {
      startWatch();
    } else if (state.myPosition && map) {
      map.setView([state.myPosition.lat, state.myPosition.lon], Math.max(map.getZoom(), 13));
    }
  }

  function startWatch() {
    if (!("geolocation" in navigator)) {
      setStatus("Geolocation isn't available on this device/browser.", true);
      return;
    }
    state.watching = true;
    el.locateBtn.classList.add("active");
    watchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    });
  }

  function onGpsPosition(pos) {
    state.myPosition = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
    renderGpsMarker();
    if (!state.gpsCentered && map) {
      state.gpsCentered = true;
      map.setView([state.myPosition.lat, state.myPosition.lon], 13);
    }
  }

  function onGpsError(err) {
    state.watching = false;
    el.locateBtn.classList.remove("active");
    setStatus("Location error: " + err.message, true);
  }

  function renderGpsMarker() {
    ensureMap();
    if (!map || !gpsLayer || !state.myPosition) return;
    gpsLayer.clearLayers();
    const { lat, lon, accuracy } = state.myPosition;
    if (accuracy) {
      L.circle([lat, lon], { radius: accuracy, color: GPS_COLOR, weight: 1, fillColor: GPS_COLOR, fillOpacity: 0.12 }).addTo(gpsLayer);
    }
    L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2, fillColor: GPS_COLOR, fillOpacity: 1 }).addTo(gpsLayer);
  }

  function getOneShotPosition() {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("not supported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });
  }

  // Which course entry a start position should attach to. Only ever a mark
  // that has no charted position of its own: the RC-set pin wherever it sits
  // in the course, or a leading portable mark. A charted government mark is
  // never a candidate — overwriting its position would silently move a real
  // buoy and change the course geometry.
  function findStartTargetEntry() {
    const pin = state.course.find((e) => e.mark.portable && resolvedPosition(e) == null);
    if (pin) return pin;
    const first = state.course[0];
    if (first && (first.mark.portable || resolvedPosition(first) == null)) return first;
    return null;
  }

  // Give the start position something to attach to, inserting a start mark
  // at the front of the course when there isn't already a suitable one. Uses
  // the list's own portable start where it has one (BYC "F", JYC "E") so the
  // course reads the way the club writes it.
  function ensureStartEntry() {
    const existing = findStartTargetEntry();
    if (existing) return existing;

    const ownStart = currentMarks().find((m) => m.portable && /start/i.test(m.name));
    const startMark = ownStart || {
      id: "__START__",
      label: "St",
      name: "Start (set position)",
      govt_light: null,
      lat: null,
      lon: null,
      gov_number: null,
      portable: true,
      notes: null,
    };
    const entry = { uid: ++uidCounter, mark: startMark, overrideLat: null, overrideLon: null, rounding: null };
    state.course.unshift(entry);
    renderChips();
    renderBoard();
    return entry;
  }

  function applyStartPosition(position, sourceLabel) {
    const chosen = state.positionTargetUid != null
      ? state.course.find((e) => e.uid === state.positionTargetUid)
      : null;
    const target = chosen || ensureStartEntry();
    // Only the start line is recorded as the start; placing a windward mark
    // shouldn't relabel it.
    if (!chosen) state.startUid = target.uid;
    state.positionTargetUid = null;
    const targetId = target.mark.id;
    let count = 0;
    state.course.forEach((entry) => {
      if (entry.mark.id === targetId) {
        entry.overrideLat = position.lat;
        entry.overrideLon = position.lon;
        count++;
      }
    });
    setStatus(
      (chosen ? "Placed " : "Start ") + target.mark.label + " from " + sourceLabel +
      (count > 1 ? " — applied to " + count + " marks." : ".")
    );
    renderChips();
    renderBoard();
    renderPlacementButtons();
    if (state.committed) renderResults();
  }

  async function setStartFromGps() {
    let position = state.myPosition;
    if (!position) {
      setStatus("Getting GPS fix…");
      try {
        position = await getOneShotPosition();
      } catch (err) {
        const manual = prompt("Couldn't get GPS (" + err.message + "). Enter start position as \"lat,lon\":");
        if (!manual) {
          setStatus("Start position not set.", true);
          return;
        }
        const parts = manual.split(",").map((s) => parseFloat(s.trim()));
        if (parts.length !== 2 || parts.some(Number.isNaN)) {
          setStatus("Couldn't parse that position.", true);
          return;
        }
        position = { lat: parts[0], lon: parts[1] };
      }
    }
    const acc = position.accuracy ? "GPS (±" + Math.round(position.accuracy) + "m)" : "GPS";
    applyStartPosition(position, acc);
  }

  // ---------- Set Start from a charted (government) mark ----------

  function beginPickStartFromMark() {
    // The picker types into the classic mark input, which is hidden in
    // committee mode — without this the button appeared to do nothing.
    if (state.entryMode !== "classic") setEntryMode("classic");
    ensureStartEntry();
    state.startPickMode = true;
    el.markInputWrap.classList.add("picking");
    el.markInput.placeholder = "Tap a charted mark to use as the start…";
    el.markInput.value = "";
    el.markInput.focus();
    setStatus("Pick a charted (non-portable) mark to use as the start line.");
    showSuggestions("");
  }

  function cancelStartPickMode() {
    if (!state.startPickMode) return;
    state.startPickMode = false;
    el.markInputWrap.classList.remove("picking");
    el.markInput.placeholder = "Type or tap to pick a mark";
    setStatus("");
  }

  function finishPickStartFromMark(mark) {
    state.startPickMode = false;
    el.markInputWrap.classList.remove("picking");
    el.markInput.placeholder = "Type or tap to pick a mark";
    el.markInput.value = "";
    hideSuggestions();
    if (mark.lat == null || mark.lon == null) {
      setStatus(mark.label + " has no charted position — pick a fixed mark, or use GPS instead.", true);
      return;
    }
    applyStartPosition({ lat: mark.lat, lon: mark.lon }, "charted mark " + mark.label);
  }
})();
