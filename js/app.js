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
    entryMode: "committee", // "committee" (RC board, default) | "classic" (typed)
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
    // When set, the mark palette picks the start instead of adding to the
    // course, so choosing a start never leaves the RC board.
    palettePick: null,
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
    rcPalette: document.getElementById("rc-palette"),
    rcPaletteHint: document.getElementById("rc-palette-hint"),
    rcBurgee: document.getElementById("rc-burgee"),
    rcBurgeeCaption: document.getElementById("rc-burgee-caption"),
    infoPanel: document.getElementById("info-panel"),
    infoClose: document.getElementById("info-close"),
    legendColors: document.getElementById("legend-colors"),
    legendSymbols: document.getElementById("legend-symbols"),
    infoNote: document.getElementById("info-note"),
    infoDisclaimer: document.getElementById("info-disclaimer"),
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
    el.infoClose.addEventListener("click", hideInfo);
    el.infoPanel.addEventListener("click", (e) => {
      if (e.target === el.infoPanel) hideInfo();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.infoPanel.hidden) hideInfo();
    });
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
    setEntryMode(state.entryMode);
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

  function currentClubCode() {
    return el.clubSelect.value;
  }

  // ---------- Club burgees ----------
  //
  // Drawn from the published descriptions on Flags of the World. Only clubs
  // whose design could actually be verified get real artwork; anything
  // unverified falls back to a plain pennant with the club's initials rather
  // than inventing an emblem for a real club.
  const BURGEE_BLUE = "#12356f";
  const BURGEE_RED = "#cc142b";

  function starPoints(cx, cy, outer) {
    const inner = outer * 0.382;
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (-90 + i * 36) * Math.PI / 180;
      pts.push((cx + r * Math.cos(a)).toFixed(2) + "," + (cy + r * Math.sin(a)).toFixed(2));
    }
    return pts.join(" ");
  }

  // Boston YC: white, a blue horizontal arm and red vertical arm forming a
  // cross, charged with a white star.
  function burgeeBYC() {
    return '<rect width="60" height="40" fill="#fff"/>' +
      '<rect x="0" y="16" width="60" height="8" fill="' + BURGEE_BLUE + '"/>' +
      '<rect x="12" y="0" width="8" height="40" fill="' + BURGEE_RED + '"/>' +
      '<polygon points="' + starPoints(16, 20, 5.2) + '" fill="#fff"/>';
  }

  // Eastern YC: blue with a red bend charged with a white star. The bend runs
  // from the top of the hoist down to the fly.
  function burgeeEYC() {
    return '<rect width="60" height="40" fill="' + BURGEE_BLUE + '"/>' +
      '<polygon points="0,0 14.4,4.8 42.5,25.9 21.2,32.9 0,17" fill="' + BURGEE_RED + '"/>' +
      '<polygon points="' + starPoints(18, 20, 6.4) + '" fill="#fff"/>';
  }

  // Corinthian YC (Marblehead): diagonally divided from the lower left
  // white-red-blue, with a blue star in canton.
  function burgeeCYC() {
    // Divided *from the lower-left corner*: the bands radiate from that
    // corner rather than running parallel — white on top, then red, then
    // blue reaching the fly — with a blue star in the canton.
    return '<rect width="60" height="40" fill="#fff"/>' +
      '<polygon points="0,40 16,5.33 40,13.33" fill="' + BURGEE_RED + '"/>' +
      '<polygon points="0,40 40,13.33 60,20" fill="' + BURGEE_BLUE + '"/>' +
      '<polygon points="' + starPoints(7, 8.5, 4.6) + '" fill="' + BURGEE_BLUE + '"/>';
  }

  // Jubilee YC: quartered by a white cross — blue upper hoist bearing a white
  // star, red lower hoist, red upper fly, blue lower fly.
  function burgeeJYC() {
    return '<rect width="60" height="40" fill="#fff"/>' +
      '<rect x="0" y="0" width="17" height="17" fill="' + BURGEE_BLUE + '"/>' +
      '<rect x="0" y="23" width="17" height="17" fill="' + BURGEE_RED + '"/>' +
      '<rect x="23" y="0" width="37" height="17" fill="' + BURGEE_RED + '"/>' +
      '<rect x="23" y="23" width="37" height="17" fill="' + BURGEE_BLUE + '"/>' +
      '<polygon points="' + starPoints(8.5, 8.5, 6.2) + '" fill="#fff"/>';
  }

  const BURGEES = {
    BYC: { draw: burgeeBYC, verified: true },
    EYC: { draw: burgeeEYC, verified: true },
    CYC: { draw: burgeeCYC, verified: true },
    JYC: { draw: burgeeJYC, verified: true },
  };

  let burgeeClipSeq = 0;

  function burgeeSvg(code, width, height) {
    const spec = BURGEES[code];
    const id = "burgeeClip" + (++burgeeClipSeq);
    const body = spec
      ? spec.draw()
      : '<rect width="60" height="40" fill="#1d6fa5"/>' +
        '<text x="6" y="25" font-size="15" font-weight="800" fill="#fff">' + code + '</text>';
    return '<svg class="burgee-svg" viewBox="0 0 60 40" width="' + width + '" height="' + height +
      '" aria-hidden="true">' +
      '<defs><clipPath id="' + id + '"><path d="M0,0 L60,20 L0,40 Z"/></clipPath></defs>' +
      '<g clip-path="url(#' + id + ')">' + body + '</g></svg>';
  }

  function burgeeTitle(code, clubName) {
    return BURGEES[code]
      ? clubName + " burgee"
      : clubName + " — burgee design not verified, showing initials";
  }

  function renderBurgee() {
    const code = currentClubCode();
    const club = currentClub();
    if (!code || !club) return;
    el.rcBurgee.innerHTML = burgeeSvg(code, 28, 19);
    el.rcBurgee.title = burgeeTitle(code, club.name);
    el.rcBurgeeCaption.textContent = club.name.replace(/ Yacht Club$/, "");
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
    state.palettePick = null;
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
    state.palettePick = null;
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
        const startTag = document.createElement("button");
        startTag.type = "button";
        startTag.className = "start-tag";
        startTag.textContent = "START";
        startTag.title = "Start line — tap to re-place it";
        startTag.addEventListener("click", (ev) => {
          ev.stopPropagation();
          choosePositionTarget(entry);
        });
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

  // A row of the RC board: the mark's letter in its real buoy colour, its
  // rounding flag, and a remove button. Rows are not typed into — marks come
  // from the palette below, so a mark that isn't racing tonight can't be
  // entered here at all.
  function makeBoardRow(entry, index) {
    const row = document.createElement("div");
    const unplaced = resolvedPosition(entry) == null;
    row.className = "rc-slot" + (unplaced ? " needs-position" : "");

    const order = document.createElement("div");
    order.className = "rc-slot-order";
    order.textContent = String(index + 1);
    row.appendChild(order);

    const colorInfo = classifyMarkColor(entry.mark.govt_light, entry.mark.portable);
    const badge = document.createElement("div");
    badge.className = "rc-slot-badge mark-badge";
    badge.setAttribute("style", markBadgeStyleAttr(colorInfo));
    badge.textContent = entry.mark.label;
    badge.title = entry.mark.label + " — " + entry.mark.name;
    row.appendChild(badge);

    if (isStartEntry(entry, index)) {
      const startBtn = document.createElement("button");
      startBtn.type = "button";
      startBtn.className = "rc-slot-start";
      startBtn.textContent = "START";
      startBtn.title = "Start line — tap to re-place it";
      startBtn.addEventListener("click", () => choosePositionTarget(entry));
      row.appendChild(startBtn);
    }

    if (unplaced) {
      const setBtn = document.createElement("button");
      setBtn.type = "button";
      setBtn.className = "rc-slot-set" + (state.positionTargetUid === entry.uid ? " is-target" : "");
      setBtn.textContent = "SET";
      setBtn.title = entry.mark.label + " is set by the RC — tap, then use GPS or a charted mark";
      setBtn.addEventListener("click", () => choosePositionTarget(entry));
      row.appendChild(setBtn);
    }

    const rounding = effectiveRounding(entry);
    const inherited = !entry.rounding && !!rounding;
    const flagBtn = document.createElement("button");
    flagBtn.type = "button";
    flagBtn.className = "rc-slot-flag";
    flagBtn.dataset.rounding = rounding || "";
    if (inherited) flagBtn.dataset.inherited = "true";
    flagBtn.textContent = rounding || "–";
    flagBtn.title = "Rounding for " + entry.mark.label +
      (rounding ? " — " + roundingWord(rounding) : "") +
      (inherited ? " (following the green flag)" : "") + " — tap to change";
    flagBtn.addEventListener("click", () => {
      entry.rounding = cycleRounding(entry.rounding);
      renderBoard();
      renderChips();
      if (state.committed) renderResults();
    });
    row.appendChild(flagBtn);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "rc-slot-remove";
    removeBtn.textContent = "\u2715";
    removeBtn.setAttribute("aria-label", "Remove " + entry.mark.label);
    removeBtn.addEventListener("click", () => removeMark(entry.uid));
    row.appendChild(removeBtn);

    return row;
  }

  // The palette of marks racing tonight. Tapping builds the course, so there
  // is no keyboard on the water and no way to enter a mark that isn't on the
  // club's list for this series.
  function renderPalette() {
    el.rcPalette.innerHTML = "";
    if (!state.listKey || !state.data.lists[state.listKey]) return;
    const pickingStart = state.palettePick === "start";
    const last = lastCourseMark();
    el.rcPalette.classList.toggle("is-picking", pickingStart);

    currentMarks().forEach((mark) => {
      const key = document.createElement("button");
      key.type = "button";
      const unplaced = mark.lat == null || mark.lon == null;
      key.className = "rc-key" + (unplaced ? " is-unplaced" : "");
      key.dataset.id = mark.id;
      key.setAttribute("style", markBadgeStyleAttr(classifyMarkColor(mark.govt_light, mark.portable)));
      key.textContent = mark.label;
      key.title = mark.label + " — " + mark.name + (unplaced ? " (position set by the RC)" : "");

      if (pickingStart) {
        // Starting at a mark copies its charted position, so one without a
        // position has nothing to give.
        if (unplaced) {
          key.disabled = true;
          key.title = mark.label + " has no charted position — use GPS instead";
        }
        key.addEventListener("click", () => {
          state.palettePick = null;
          finishPickStartFromMark(mark);
        });
      } else {
        // Rounding the same mark twice running isn't a course, and it plots
        // two markers on one spot, so the key is simply unavailable.
        if (last && last.id === mark.id) {
          key.disabled = true;
          key.title = mark.label + " is already the last mark";
        }
        key.addEventListener("click", () => {
          pushMarkToCourse(mark);
          setStatus("");
          renderChips();
          renderBoard();
          if (state.committed) renderResults();
        });
      }
      el.rcPalette.appendChild(key);
    });

    if (pickingStart) {
      el.rcPaletteHint.textContent = "Tap the mark the start line is at, or tap Mark Start again to cancel.";
      return;
    }
    const unplacedCount = currentMarks().filter((m) => m.lat == null).length;
    el.rcPaletteHint.textContent = unplacedCount
      ? "Tap a mark to add it. Outlined marks are set by the RC — they need a position before the course will plot."
      : "Tap a mark to add it to the board.";
  }

  function renderBoard() {
    if (state.entryMode !== "committee") return;
    renderGreenFlag();
    renderBurgee();

    el.rcBoard.innerHTML = "";
    if (state.course.length === 0) {
      const empty = document.createElement("p");
      empty.className = "rc-board-empty";
      empty.textContent = "Tap marks below to build the board";
      el.rcBoard.appendChild(empty);
    } else {
      state.course.forEach((entry, idx) => el.rcBoard.appendChild(makeBoardRow(entry, idx)));
    }

    renderPalette();

    const twiceNote = state.twiceAround ? " Flag T is up — the course is sailed twice." : "";
    el.rcHint.textContent = (state.course.length
      ? "The board reads top to bottom; tap a mark's flag to set its rounding."
      : "Build the board in the order the RC posted it, first mark at the top.") + twiceNote;
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
    el.gpsStartBtn.title = target
      ? "Put " + target.mark.label + " at your current position"
      : "Start the course at your current position";
    el.markStartBtn.title = target
      ? "Copy a charted mark's position onto " + target.mark.label
      : "Start the course at a charted mark";
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
    if (unplacedMarks().length > 0) {
      reportUnplaced();
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

  function destinationPoint(lat, lon, bearingDeg, distNm) {
    const d = distNm / EARTH_RADIUS_NM;
    const brg = toRad(bearingDeg);
    const phi1 = toRad(lat), lam1 = toRad(lon);
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(brg));
    const lam2 = lam1 + Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2)
    );
    return { lat: toDeg(phi2), lon: toDeg(lam2) };
  }

  function fmtHeading(deg) {
    return String(Math.round(deg)).padStart(3, "0") + "°";
  }

  // Every list carries RC-set marks with no charted position (BYC F/W, JYC
  // E/F/W, MBSA E/F/W). A course containing one can't be plotted.
  function unplacedMarks() {
    return state.course.filter((e) => resolvedPosition(e) == null);
  }

  function reportUnplaced() {
    const names = [...new Set(unplacedMarks().map((e) => e.mark.label))].join(", ");
    setStatus("Set a position for " + names + " before plotting — tap SET on the mark.", true);
  }

  function renderResults() {
    if (!state.committed) return;
    // Guard here rather than only in setCourse: once a course is committed
    // every later edit (adding a mark, changing a rounding, toggling
    // magnetic) calls straight into this, which previously let an unplaced
    // mark be plotted as a "position unknown" leg.
    if (unplacedMarks().length > 0) {
      reportUnplaced();
      hideLegStrip();
      return;
    }
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
        drawStartLine(points);

      const bounds = L.latLngBounds(known.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds.pad(0.3), { animate: false });
      }
    } catch (err) {
      console.error("Map rendering failed:", err);
    }
  }

  // A start line runs from the start mark across to the committee boat,
  // square to the first leg — the geometry you actually line up against.
  // Length is nominal: we know where the pin is, not how long the RC set it.
  const START_LINE_NM = 0.08;

  function burgeeIcon(code) {
    return L.divIcon({
      className: "burgee-icon",
      html: "<span class='burgee-map'>" + burgeeSvg(code, 30, 20) + "</span>",
      iconSize: [30, 20],
      iconAnchor: [1, 10],
    });
  }

  function drawStartLine(points) {
    const startIdx = points.findIndex((p) => p && p.isStart);
    if (startIdx === -1) return;
    const start = points[startIdx];

    // Square to the first leg that actually goes somewhere.
    const next = points.slice(startIdx + 1).find(Boolean);
    if (!next) return;
    const legBearing = initialBearing(start.lat, start.lon, next.lat, next.lon);
    // Committee boat to starboard as you look up the course.
    const boatEnd = destinationPoint(start.lat, start.lon, (legBearing + 90) % 360, START_LINE_NM);

    L.polyline([[start.lat, start.lon], [boatEnd.lat, boatEnd.lon]], {
      color: "#17222c",
      weight: 3,
      opacity: 0.85,
    }).addTo(courseLayer);

    L.marker([boatEnd.lat, boatEnd.lon], {
      icon: burgeeIcon(currentClubCode()),
      interactive: true,
      keyboard: false,
    })
      .addTo(courseLayer)
      .bindTooltip("Committee boat — " + currentClub().name);
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

  // The legend is built from the same colour classifier and badge styling the
  // map itself uses, so the key can't drift from what actually gets drawn.
  const COLOR_LEGEND = [
    [[[{ kind: "red" }, "R"]],
     "Red — a nun or red light. Keep it to starboard coming in from seaward."],
    [[[{ kind: "green" }, "G"]],
     "Green — a can or green light. Keep it to port coming in from seaward."],
    [[[{ kind: "junction", top: "red", bottom: "green" }, "RG"],
      [{ kind: "junction", top: "green", bottom: "red" }, "GR"]],
     "Red-and-green bands — a junction buoy. The top band is the preferred channel."],
    [[[{ kind: "safe-water" }, "RW"]],
     "Red-and-white stripes — a safe-water mark, deep water all round it."],
    [[[{ kind: "yellow" }, "Y"]],
     "Yellow — a special mark. No navigational meaning; it marks an area."],
    [[[{ kind: "orange" }, "Or"]],
     "Orange — a racing barrel the club lays, not a government buoy."],
    [[[{ kind: "white" }, "W"]],
     "White — a white special or regulatory buoy."],
    [[[{ kind: "neutral" }, "F"]],
     "Blue — no colour on the chart. Either a portable mark the RC sets on the " +
     "day, or a charted mark whose colour isn't recorded in the club's list."],
  ];

  function legendRow(swatchHtml, text) {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.innerHTML = swatchHtml;
    const label = document.createElement("span");
    label.className = "legend-text";
    label.textContent = text;
    li.appendChild(sw);
    li.appendChild(label);
    return li;
  }

  function badgeHtml(colorInfo, label, extra) {
    return "<span class='mark-badge legend-badge' style='" + markBadgeStyleAttr(colorInfo) + "'>" +
      label + (extra || "") + "</span>";
  }

  function renderLegend() {
    el.legendColors.innerHTML = "";
    COLOR_LEGEND.forEach(([badges, text]) => {
      const swatch = badges.map(([info, label]) => badgeHtml(info, label)).join("");
      el.legendColors.appendChild(legendRow(swatch, text));
    });

    el.legendSymbols.innerHTML = "";
    const rows = [
      [badgeHtml({ kind: "green" }, "D", "<span class='badge-start'>START</span>"),
       "The mark the course starts from. It keeps its own letter and colour."],
      [badgeHtml({ kind: "red" }, "H", "<span class='badge-round round-S'>S</span>"),
       "Rounding: S = leave to starboard, P = leave to port"],
      ["<span class='round-tag round-S'>S</span><span class='round-tag round-inherited round-P'>P</span>",
       "Filled = set on that mark; dashed = following the green flag"],
      ["<span class='legend-arrow'><span class='course-arrow'></span></span>",
       "Direction of travel along each leg"],
      ["<span class='legend-line'></span>" + burgeeSvg(currentClubCode() || "BYC", 26, 17),
       "Start line, square to the first leg, with the committee boat at its outer end"],
      ["<span class='legend-gps'></span>", "Your GPS position, with its accuracy circle"],
      ["<span class='legend-leg'></span>", "A leg of the course"],
      ["<span class='legend-leg legend-leg-active'></span>", "The leg currently selected in the stepper"],
    ];
    rows.forEach(([html, text]) => el.legendSymbols.appendChild(legendRow(html, text)));

    const meta = state.data && state.data.meta;
    if (meta) {
      el.infoNote.textContent = meta.note;
      el.infoDisclaimer.textContent = meta.disclaimer;
    }
  }

  function showInfo() {
    if (!state.data) return;
    renderLegend();
    el.infoPanel.hidden = false;
  }

  function hideInfo() {
    el.infoPanel.hidden = true;
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
    // On the RC board, pick the start from the same mark palette rather than
    // dragging the user over to the typed view.
    if (state.entryMode === "committee") {
      state.palettePick = state.palettePick === "start" ? null : "start";
      setStatus(state.palettePick
        ? "Tap the mark the start line is at."
        : "");
      renderBoard();
      return;
    }
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

    // Starting at a charted mark means that mark IS the start, so it keeps
    // its own letter. Copying its position onto a portable placeholder made
    // "start at J" show up on the board as F.
    const existing = state.positionTargetUid != null
      ? state.course.find((e) => e.uid === state.positionTargetUid)
      : findStartTargetEntry();

    let entry;
    if (existing) {
      existing.mark = mark;
      existing.overrideLat = null;
      existing.overrideLon = null;
      entry = existing;
    } else if (state.course.length && state.course[0].mark.id === mark.id) {
      entry = state.course[0];
    } else {
      entry = { uid: ++uidCounter, mark: mark, overrideLat: null, overrideLon: null, rounding: null };
      state.course.unshift(entry);
    }

    state.startUid = entry.uid;
    state.positionTargetUid = null;
    setStatus("Start set at " + mark.label + " — " + mark.name + ".");
    renderChips();
    renderBoard();
    renderPlacementButtons();
    if (state.committed) renderResults();
  }
})();
