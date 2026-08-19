(function () {
  "use strict";

  const NM_PER_DEG_LAT = 60; // nautical miles per degree of latitude
  const EARTH_RADIUS_NM = 3440.065;

  const state = {
    data: null,
    listKey: null,
    course: [], // { uid, mark: {...}, overrideLat, overrideLon }
  };

  let uidCounter = 0;
  let map = null;
  let mapLayer = null;

  const el = {
    clubSelect: document.getElementById("club-select"),
    seriesRow: document.getElementById("series-row"),
    seriesSelect: document.getElementById("series-select"),
    mbsaListRow: document.getElementById("mbsa-list-row"),
    mbsaListSelect: document.getElementById("mbsa-list-select"),
    listHint: document.getElementById("list-hint"),
    coursePanel: document.getElementById("course-panel"),
    markPicker: document.getElementById("mark-picker"),
    addMarkBtn: document.getElementById("add-mark-btn"),
    courseList: document.getElementById("course-list"),
    clearCourseBtn: document.getElementById("clear-course-btn"),
    resultsPanel: document.getElementById("results-panel"),
    useMagnetic: document.getElementById("use-magnetic"),
    variation: document.getElementById("variation"),
    legsTableBody: document.querySelector("#legs-table tbody"),
    totals: document.getElementById("totals"),
    footerNote: document.getElementById("footer-note"),
  };

  fetch("data/marks.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      state.data = data;
      el.footerNote.textContent = data.meta.note;
      init();
    })
    .catch((err) => {
      el.footerNote.textContent =
        "Could not load mark data (" + err.message + "). Try reloading the page.";
    });

  function init() {
    populateClubs();
    el.clubSelect.addEventListener("change", onClubChange);
    el.seriesSelect.addEventListener("change", onSeriesOrListChange);
    el.mbsaListSelect.addEventListener("change", onSeriesOrListChange);
    el.addMarkBtn.addEventListener("click", addMarkToCourse);
    el.clearCourseBtn.addEventListener("click", clearCourse);
    el.useMagnetic.addEventListener("change", renderResults);
    el.variation.addEventListener("input", renderResults);
    onClubChange();
  }

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
      el.seriesRow.hidden = false;
      el.seriesSelect.innerHTML = "";
      const weeknightOpt = document.createElement("option");
      weeknightOpt.value = "weeknight";
      weeknightOpt.textContent = club.weeknight_series.label;
      const mbsaOpt = document.createElement("option");
      mbsaOpt.value = "mbsa";
      mbsaOpt.textContent = "Weekend / regatta (MBSA marks)";
      el.seriesSelect.appendChild(weeknightOpt);
      el.seriesSelect.appendChild(mbsaOpt);
    } else {
      el.seriesRow.hidden = true;
    }
    onSeriesOrListChange();
  }

  function onSeriesOrListChange() {
    const club = currentClub();
    const usesMbsa = !club.weeknight_series || el.seriesSelect.value === "mbsa";
    el.mbsaListRow.hidden = !usesMbsa;

    if (usesMbsa) {
      state.listKey = el.mbsaListSelect.value;
    } else {
      state.listKey = club.weeknight_series.id;
    }

    const list = state.data.lists[state.listKey];
    el.listHint.textContent = list.label + " — " + list.marks.length + " marks available.";

    // Changing the list invalidates any course already built against a
    // different list, since letters/numbers mean different things per list.
    state.course = [];
    populateMarkPicker();
    el.coursePanel.hidden = false;
    renderCourse();
  }

  function populateMarkPicker() {
    const list = state.data.lists[state.listKey];
    el.markPicker.innerHTML = "";
    list.marks.forEach((mark) => {
      const opt = document.createElement("option");
      opt.value = mark.id;
      opt.textContent = mark.label + " — " + mark.name + (mark.portable ? " (portable)" : "");
      el.markPicker.appendChild(opt);
    });
  }

  function addMarkToCourse() {
    const list = state.data.lists[state.listKey];
    const mark = list.marks.find((m) => m.id === el.markPicker.value);
    if (!mark) return;
    state.course.push({
      uid: ++uidCounter,
      mark: mark,
      overrideLat: null,
      overrideLon: null,
    });
    renderCourse();
  }

  function clearCourse() {
    state.course = [];
    renderCourse();
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

  function renderCourse() {
    el.courseList.innerHTML = "";
    state.course.forEach((entry, idx) => {
      const li = document.createElement("li");
      li.className = "course-item";

      const main = document.createElement("div");
      main.className = "course-item-main";

      const label = document.createElement("span");
      label.className = "course-item-label";
      label.textContent = (idx + 1) + ". " + entry.mark.label + " — " + entry.mark.name;
      main.appendChild(label);

      if (entry.mark.portable) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "portable";
        main.appendChild(badge);
      }

      const controls = document.createElement("span");
      controls.className = "course-item-controls";

      const upBtn = mkBtn("▲", "Move up", () => {
        if (idx === 0) return;
        [state.course[idx - 1], state.course[idx]] = [state.course[idx], state.course[idx - 1]];
        renderCourse();
      });
      const downBtn = mkBtn("▼", "Move down", () => {
        if (idx === state.course.length - 1) return;
        [state.course[idx + 1], state.course[idx]] = [state.course[idx], state.course[idx + 1]];
        renderCourse();
      });
      const removeBtn = mkBtn("✕", "Remove", () => {
        state.course.splice(idx, 1);
        renderCourse();
      });
      controls.appendChild(upBtn);
      controls.appendChild(downBtn);
      controls.appendChild(removeBtn);
      main.appendChild(controls);
      li.appendChild(main);

      if (entry.mark.portable) {
        const overrideRow = document.createElement("div");
        overrideRow.className = "course-item-override";

        const latInput = document.createElement("input");
        latInput.type = "number";
        latInput.step = "0.00001";
        latInput.placeholder = "lat (optional)";
        latInput.value = entry.overrideLat != null ? entry.overrideLat : "";
        latInput.addEventListener("input", () => {
          entry.overrideLat = latInput.value === "" ? null : parseFloat(latInput.value);
          renderResults();
        });

        const lonInput = document.createElement("input");
        lonInput.type = "number";
        lonInput.step = "0.00001";
        lonInput.placeholder = "lon (optional)";
        lonInput.value = entry.overrideLon != null ? entry.overrideLon : "";
        lonInput.addEventListener("input", () => {
          entry.overrideLon = lonInput.value === "" ? null : parseFloat(lonInput.value);
          renderResults();
        });

        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = "No fixed position — enter tonight's RC-set position to include this leg.";

        overrideRow.appendChild(latInput);
        overrideRow.appendChild(lonInput);
        overrideRow.appendChild(note);
        li.appendChild(overrideRow);
      }

      el.courseList.appendChild(li);
    });

    el.resultsPanel.hidden = state.course.length === 0;
    renderResults();
  }

  function mkBtn(text, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.title = title;
    btn.className = "icon-btn";
    btn.addEventListener("click", onClick);
    return btn;
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
    let theta = toDeg(Math.atan2(y, x));
    return (theta + 360) % 360;
  }

  function fmtHeading(deg) {
    return String(Math.round(deg)).padStart(3, "0") + "°";
  }

  function renderResults() {
    el.legsTableBody.innerHTML = "";
    if (state.course.length === 0) {
      el.totals.textContent = "";
      renderMap([]);
      return;
    }

    const variation = parseFloat(el.variation.value) || 0;
    const showMag = el.useMagnetic.checked;

    let totalNm = 0;
    let legCount = 0;
    let skipped = 0;
    const mapPoints = [];

    for (let i = 0; i < state.course.length; i++) {
      const entry = state.course[i];
      const pos = resolvedPosition(entry);
      mapPoints.push(pos ? { ...pos, label: entry.mark.label, name: entry.mark.name } : null);

      if (i === 0) continue;
      const prev = resolvedPosition(state.course[i - 1]);
      const tr = document.createElement("tr");
      const legLabel = state.course[i - 1].mark.label + " → " + entry.mark.label;
      const nameLabel = state.course[i - 1].mark.name + " → " + entry.mark.name;

      if (!prev || !pos) {
        skipped++;
        tr.innerHTML =
          "<td>" + i + "</td><td>" + legLabel + "<br><span class='hint'>" + nameLabel + "</span></td>" +
          "<td colspan='3' class='muted'>Position unknown — set the portable mark's position above</td>";
        el.legsTableBody.appendChild(tr);
        continue;
      }

      const dist = haversineNm(prev.lat, prev.lon, pos.lat, pos.lon);
      const trueHdg = initialBearing(prev.lat, prev.lon, pos.lat, pos.lon);
      const magHdg = ((trueHdg - variation) % 360 + 360) % 360;
      totalNm += dist;
      legCount++;

      tr.innerHTML =
        "<td>" + i + "</td>" +
        "<td>" + legLabel + "<br><span class='hint'>" + nameLabel + "</span></td>" +
        "<td>" + dist.toFixed(2) + " nm</td>" +
        "<td>" + fmtHeading(trueHdg) + "</td>" +
        "<td>" + (showMag ? fmtHeading(magHdg) : "—") + "</td>";
      el.legsTableBody.appendChild(tr);
    }

    let totalsText = state.course.length + " marks, " + legCount + " leg" + (legCount === 1 ? "" : "s") +
      " plotted, " + totalNm.toFixed(2) + " nm total";
    if (skipped > 0) {
      totalsText += " (" + skipped + " leg" + (skipped === 1 ? "" : "s") + " skipped — missing position)";
    }
    el.totals.textContent = totalsText;

    renderMap(mapPoints);
  }

  let mapUnavailable = false;

  function ensureMap() {
    if (map || mapUnavailable) return;
    if (typeof L === "undefined") {
      mapUnavailable = true;
      const mapEl = document.getElementById("map");
      if (mapEl) mapEl.textContent = "Map unavailable (couldn't load the map library — check your connection).";
      return;
    }
    map = L.map("map").setView([42.45, -70.82], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
  }

  function renderMap(points) {
    // Map plotting is a nice-to-have on top of the heading table; never let
    // a map/CDN problem break the course builder or the heading results.
    try {
      ensureMap();
      if (!map) return;
      mapLayer.clearLayers();
      const known = points.filter(Boolean);
      if (known.length === 0) {
        return;
      }

      known.forEach((p) => {
        L.marker([p.lat, p.lon])
          .addTo(mapLayer)
          .bindTooltip(p.label + " — " + p.name, { permanent: false });
      });

      if (known.length > 1) {
        const latlngs = points.filter(Boolean).map((p) => [p.lat, p.lon]);
        L.polyline(latlngs, { color: "#1d6fa5", weight: 3, dashArray: "6 4" }).addTo(mapLayer);
      }

      const bounds = L.latLngBounds(known.map((p) => [p.lat, p.lon]));
      map.fitBounds(bounds.pad(0.25));
    } catch (err) {
      console.error("Map rendering failed:", err);
    }
  }
})();
