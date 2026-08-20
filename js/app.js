(function () {
  "use strict";

  const EARTH_RADIUS_NM = 3440.065;
  const GPS_COLOR = "#1a73e8";

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
  };

  let uidCounter = 0;
  let map = null;
  let courseLayer = null;
  let gpsLayer = null;
  let watchId = null;

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
        addMarkToCourse();
      } else if (e.key === "Escape") {
        cancelStartPickMode();
        hideSuggestions();
      }
    });
    el.markInput.addEventListener("input", () => showSuggestions(el.markInput.value));
    el.markInput.addEventListener("focus", () => showSuggestions(el.markInput.value));
    el.suggestions.addEventListener("pointerdown", onSuggestionPointerDown);
    document.addEventListener("pointerdown", (e) => {
      if (!el.markInputWrap.contains(e.target)) {
        hideSuggestions();
        cancelStartPickMode();
      }
    });

    el.clearCourseBtn.addEventListener("click", clearCourse);
    el.setCourseBtn.addEventListener("click", setCourse);
    el.gpsStartBtn.addEventListener("click", setStartFromGps);
    el.markStartBtn.addEventListener("click", beginPickStartFromMark);
    el.useMagnetic.addEventListener("change", () => { if (state.committed) renderResults(); });
    el.variation.addEventListener("input", () => { if (state.committed) renderResults(); });
    el.sheetToggle.addEventListener("click", toggleSheet);
    el.infoBtn.addEventListener("click", showInfo);
    el.locateBtn.addEventListener("click", onLocateClick);

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
    renderChips();
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

  function resolveMark(rawInput) {
    const raw = (rawInput || "").trim();
    if (!raw) return null;
    const byId = currentMarks().find((m) => m.id.toLowerCase() === raw.toLowerCase());
    if (byId) return byId;
    const lower = raw.toLowerCase();
    const nameMatches = currentMarks().filter((m) => m.name.toLowerCase().includes(lower));
    if (nameMatches.length === 1) return nameMatches[0];
    return null;
  }

  function addMarkToCourse() {
    const mark = resolveMark(el.markInput.value);
    if (!mark) {
      setStatus("No mark found for “" + el.markInput.value + "”.", true);
      el.markInput.select();
      return;
    }
    addMarkObject(mark);
  }

  function addMarkObject(mark) {
    state.course.push({ uid: ++uidCounter, mark: mark, overrideLat: null, overrideLon: null });
    el.markInput.value = "";
    hideSuggestions();
    el.markInput.focus();
    setStatus("");
    renderChips();
  }

  // ---------- Mark suggestion dropdown ----------

  function showSuggestions(filterText) {
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
  }

  function hideSuggestions() {
    el.suggestions.hidden = true;
  }

  function onSuggestionPointerDown(e) {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    e.preventDefault();
    const mark = currentMarks().find((m) => m.id === li.dataset.id);
    if (!mark) return;

    if (state.startPickMode) {
      finishPickStartFromMark(mark);
      return;
    }
    addMarkObject(mark);
  }

  function removeMark(uid) {
    state.course = state.course.filter((e) => e.uid !== uid);
    renderChips();
  }

  function clearCourse() {
    state.course = [];
    state.committed = false;
    cancelStartPickMode();
    renderChips();
    hideLegStrip();
    updateSheetToggleLabel();
    setStatus("");
  }

  function renderChips() {
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
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "chip-remove";
      removeBtn.textContent = "✕";
      removeBtn.setAttribute("aria-label", "Remove " + entry.mark.label);
      removeBtn.addEventListener("click", () => removeMark(entry.uid));
      chip.appendChild(removeBtn);
      el.courseChips.appendChild(chip);
    });
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
  }

  // ---------- Commit course / compute results ----------

  function setCourse() {
    if (state.course.length < 2) {
      setStatus("Add at least two marks to plot a course.", true);
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
    el.legStrip.innerHTML = "";
    el.legStrip.hidden = false;

    const variation = parseFloat(el.variation.value) || 0;
    const showMag = el.useMagnetic.checked;
    let totalNm = 0;
    const mapPoints = [];

    for (let i = 0; i < state.course.length; i++) {
      const entry = state.course[i];
      const pos = resolvedPosition(entry);
      mapPoints.push(pos ? { ...pos, label: entry.mark.label, name: entry.mark.name } : null);
      if (i === 0) continue;

      const prev = resolvedPosition(state.course[i - 1]);
      const card = document.createElement("div");
      const route = state.course[i - 1].mark.label + " → " + entry.mark.label;

      if (!prev || !pos) {
        card.className = "leg-card leg-missing";
        card.innerHTML = "<div class='leg-route'>" + route + "</div><div class='leg-detail'>position unknown</div>";
        el.legStrip.appendChild(card);
        continue;
      }

      const dist = haversineNm(prev.lat, prev.lon, pos.lat, pos.lon);
      const trueHdg = initialBearing(prev.lat, prev.lon, pos.lat, pos.lon);
      const magHdg = ((trueHdg - variation) % 360 + 360) % 360;
      totalNm += dist;

      card.className = "leg-card";
      const hdgText = showMag ? fmtHeading(magHdg) + "M" : fmtHeading(trueHdg) + "T";
      card.innerHTML =
        "<div class='leg-route'>" + route + "</div>" +
        "<div class='leg-detail'>" + hdgText + " · " + dist.toFixed(2) + " nm</div>";
      el.legStrip.appendChild(card);
    }

    const totalCard = document.createElement("div");
    totalCard.className = "leg-total";
    totalCard.textContent = totalNm.toFixed(2) + " nm total";
    el.legStrip.appendChild(totalCard);

    state.lastTotalNm = totalNm;
    updateSheetToggleLabel();
    renderCourseOnMap(mapPoints);
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

  function markBadgeIcon(label, isStart) {
    return L.divIcon({
      className: "mark-icon",
      html: "<div class='mark-badge" + (isStart ? " start-badge" : "") + "'>" + label + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      tooltipAnchor: [0, -16],
    });
  }

  function renderCourseOnMap(points) {
    try {
      ensureMap();
      if (!map) return;
      courseLayer.clearLayers();
      const known = points.filter(Boolean);
      if (known.length === 0) return;

      known.forEach((p, idx) => {
        L.marker([p.lat, p.lon], { icon: markBadgeIcon(p.label, idx === 0) })
          .addTo(courseLayer)
          .bindTooltip(p.label + " — " + p.name);
      });
      if (known.length > 1) {
        L.polyline(points.filter(Boolean).map((p) => [p.lat, p.lon]), {
          color: "#1d6fa5",
          weight: 3,
          dashArray: "6 4",
        }).addTo(courseLayer);
      }
      const bounds = L.latLngBounds(known.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds.pad(0.3));
    } catch (err) {
      console.error("Map rendering failed:", err);
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

  // Which course entry actually needs a position: prefer the first one that
  // doesn't resolve to any position yet (typically a portable start pin),
  // even if it isn't literally the first mark in the course. Falls back to
  // the first mark if everything already has a position.
  function findStartTargetEntry() {
    return state.course.find((e) => resolvedPosition(e) == null) || state.course[0];
  }

  function applyStartPosition(position, sourceLabel) {
    const target = findStartTargetEntry();
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
      "Start (" + target.mark.label + ") set from " + sourceLabel +
      " — applied to " + count + " mark" + (count === 1 ? "" : "s") + "."
    );
    if (state.committed) renderResults();
  }

  async function setStartFromGps() {
    if (state.course.length === 0) {
      setStatus("Add a start mark first, then tap GPS Start.", true);
      return;
    }
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
    if (state.course.length === 0) {
      setStatus("Add a start mark first, then tap Mark Start.", true);
      return;
    }
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
