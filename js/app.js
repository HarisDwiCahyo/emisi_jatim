/* ============================================================
   App Prioritas Intervensi — WebGIS (baca GeoTIFF live)
   Skor prioritas per sel = 1/3 emisi(S1+S2) + 1/3 ekonomi + 1/3 TK
   (tiap metrik dinormalkan: nilai / maks sektor). Butuh Leaflet + parseGeoraster.
   ============================================================ */
(function () {
  "use strict";

  // ---------------- SPLASH ----------------
  var intro = document.getElementById("intro");
  function closeIntro() { intro.classList.add("hidden"); try { sessionStorage.setItem("prioIntroSeen", "1"); } catch (e) {} }
  try { if (sessionStorage.getItem("prioIntroSeen")) intro.classList.add("hidden"); } catch (e) {}
  document.getElementById("introEnter").addEventListener("click", closeIntro);
  document.getElementById("introClose").addEventListener("click", closeIntro);

  // ---------------- KONFIG ----------------
  var SEKTOR = [
    { key: "foodbev",  nama: "Makanan & Minuman", kbli: "10 & 11", dot: "#c7a24a", f: "FoodBeverage" },
    { key: "tekstil",  nama: "Tekstil",            kbli: "13",      dot: "#6f9e8f", f: "Tekstil" },
    { key: "kimia",    nama: "Kimia",              kbli: "20",      dot: "#8b9a6e", f: "Kimia" },
    { key: "pupuk",    nama: "Pupuk",              kbli: "20",      dot: "#9487b5", f: "Pupuk" },
    { key: "besibaja", nama: "Besi & Baja",        kbli: "24",      dot: "#b56a5a", f: "BesiBaja" }
  ];
  function files(f) {
    return {
      s1:  "data/GRID_Emisi_" + f + "_Jatim.tif",
      s2:  "data/GRID_Emisi_" + f + "_Scope2_Jatim.tif",
      eko: "data/GRID_Ekonomi_" + f + "_Jatim.tif",
      tk:  "data/GRID_TK_" + f + "_Jatim.tif"
    };
  }
  var MODES = [
    { key: "prioritas", nama: "Prioritas",          unit: "skor",     field: "score", log: false },
    { key: "emisi",     nama: "Emisi (S1+S2)",      unit: "t CO₂e",   field: "emisi", log: true },
    { key: "ekonomi",   nama: "Kontribusi Ekonomi", unit: "×10³ Rp",  field: "eko",   log: true },
    { key: "tk",        nama: "Tenaga Kerja",       unit: "orang",    field: "tk",    log: true }
  ];
  var LEVELS = [
    { key: "kab",  nama: "Kabupaten/Kota" },
    { key: "grid", nama: "Sel Grid 11 km" }
  ];
  var GEOJSON_URL = "data/Kabupaten_JawaTimur.geojson";

  // ---- ramp warna ----
  var RAMP = ["#efe8d6", "#cdd2a6", "#a9b47e", "#8b9a6e", "#6a7850", "#3c4626"];
  var RAMP_PRIO = ["#f4ecd8", "#f0c86b", "#e8944b", "#d65f3f", "#a83232", "#6e1f22"]; // prioritas: kuning→merah tua
  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function rampOf(arr) {
    var rgb = arr.map(hex);
    return function (t) {
      t = Math.max(0, Math.min(1, t));
      var seg = (rgb.length - 1) * t, i = Math.floor(seg), ff = seg - i;
      if (i >= rgb.length - 1) { i = rgb.length - 2; ff = 1; }
      var a = rgb[i], b = rgb[i + 1];
      return "rgb(" + Math.round(a[0] + (b[0] - a[0]) * ff) + "," +
                      Math.round(a[1] + (b[1] - a[1]) * ff) + "," +
                      Math.round(a[2] + (b[2] - a[2]) * ff) + ")";
    };
  }
  var rampEmisi = rampOf(RAMP), rampPrio = rampOf(RAMP_PRIO);

  var fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
  var fmt1 = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
  var fmt3 = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  function fnum(n) { return fmt.format(n); }
  function fval(n) { if (n >= 1e9) return fmt1.format(n / 1e9) + " M"; if (n >= 1e6) return fmt1.format(n / 1e6) + " jt"; if (n >= 1e3) return fmt1.format(n / 1e3) + " rb"; return fmt.format(n); }
  function isData(v, nd) { return v !== null && v !== undefined && isFinite(v) && v > 0 && v !== nd; }

  // ---------------- PETA ----------------
  var map = L.map("map", { zoomControl: false, minZoom: 6, maxZoom: 12, preferCanvas: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.setView([-7.6, 112.8], 7);
  var renderer = L.canvas({ padding: 0.5 });
  var bases = {
    osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }),
    sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles &copy; Esri", maxZoom: 19 })
  };
  bases.osm.addTo(map);

  var readout = document.getElementById("readout");
  var loader = document.getElementById("loader");
  var layer = L.layerGroup().addTo(map);
  var activeKey = SEKTOR[0].key;
  var activeMode = MODES[0].key;
  var activeLevel = LEVELS[0].key;

  var GEO = null;                 // FeatureCollection kabupaten/kota
  var boundaryLayer = null;       // garis batas (selalu tampil)
  var featureLayers = {};         // fid -> leaflet layer (untuk zoom dari tabel)

  // ---------------- MUAT 1 GEOTIFF ----------------
  function loadTif(url) {
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status + " " + url); return r.arrayBuffer(); })
      .then(parseGeoraster)
      .then(function (gr) {
        var rows = gr.values[0], nd = gr.noDataValue, m = {};
        for (var r = 0; r < rows.length; r++)
          for (var c = 0; c < rows[r].length; c++) {
            var v = rows[r][c];
            if (isData(v, nd)) m[r + "_" + c] = v;
          }
        return { pw: gr.pixelWidth, ph: gr.pixelHeight, x0: gr.xmin, y0: gr.ymax, m: m };
      })
      .catch(function (e) { console.warn("lewati", url, e.message); return null; });
  }

  // ---------------- MUAT 1 SEKTOR (4 metrik) ----------------
  function muat(s) {
    var fl = files(s.f);
    return Promise.all([loadTif(fl.s1), loadTif(fl.s2), loadTif(fl.eko), loadTif(fl.tk)])
      .then(function (d) {
        var d1 = d[0], d2 = d[1], de = d[2], dt = d[3];
        var gp = d1 || d2 || de || dt;
        if (!gp) { s.cells = []; return s; }
        var keys = {};
        [d1, d2, de, dt].forEach(function (dd) { if (dd) for (var k in dd.m) keys[k] = 1; });

        var cells = [];
        for (var k in keys) {
          var p = k.split("_"), r = +p[0], c = +p[1];
          var s1 = d1 && d1.m[k] || 0, s2 = d2 && d2.m[k] || 0;
          var eko = de && de.m[k] || 0, tk = dt && dt.m[k] || 0;
          var north = gp.y0 - r * gp.ph, west = gp.x0 + c * gp.pw;
          cells.push({
            r: r, c: c, s1: s1, s2: s2, eko: eko, tk: tk, emisi: s1 + s2,
            b: [[north - gp.ph, west], [north, west + gp.pw]],
            lat: north - gp.ph / 2, lng: west + gp.pw / 2
          });
        }
        // maks per metrik
        var mE = 0, mK = 0, mT = 0;
        cells.forEach(function (x) { if (x.emisi > mE) mE = x.emisi; if (x.eko > mK) mK = x.eko; if (x.tk > mT) mT = x.tk; });
        // skor komposit (1/3 tiap metrik, dinormalkan / maks)
        cells.forEach(function (x) {
          var ne = mE ? x.emisi / mE : 0, nk = mK ? x.eko / mK : 0, nt = mT ? x.tk / mT : 0;
          x.ne = ne; x.nk = nk; x.nt = nt;
          x.score = (ne + nk + nt) / 3;
        });
        // ranking (skor desc)
        cells.sort(function (a, b) { return b.score - a.score; });
        cells.forEach(function (x, i) { x.rank = i + 1; });

        s.cells = cells;
        s.maxE = mE; s.maxK = mK; s.maxT = mT;
        s.totEmisi = cells.reduce(function (a, x) { return a + x.emisi; }, 0);
        s.totEko = cells.reduce(function (a, x) { return a + x.eko; }, 0);
        s.totTk = cells.reduce(function (a, x) { return a + x.tk; }, 0);
        return s;
      });
  }

  // ---------------- GEOJSON KABUPATEN ----------------
  function loadGeo() {
    return fetch(GEOJSON_URL)
      .then(function (r) { if (!r.ok) throw new Error(r.status + " " + GEOJSON_URL); return r.json(); })
      .then(function (gj) { GEO = gj; return gj; })
      .catch(function (e) { console.warn("gagal muat geojson", e.message); GEO = null; return null; });
  }

  function labelKab(p) { return (p.TYPE_2 === "Kota" ? "Kota " : "Kab. ") + p.NAME_2; }

  // ray-casting; menangani lubang (hole) per poligon
  function pointInRing(lng, lat, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function pointInFeature(lng, lat, geom) {
    var polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    for (var p = 0; p < polys.length; p++) {
      var rings = polys[p];
      if (pointInRing(lng, lat, rings[0])) {
        var inHole = false;
        for (var h = 1; h < rings.length; h++) { if (pointInRing(lng, lat, rings[h])) { inHole = true; break; } }
        if (!inHole) return true;
      }
    }
    return false;
  }

  // agregasi sel grid → kabupaten (per sektor), by centroid sel
  function aggregate() {
    if (!GEO) return;
    SEKTOR.forEach(function (s) {
      var kab = GEO.features.map(function (f) {
        return { fid: f.properties.fid, nama: labelKab(f.properties), tipe: f.properties.TYPE_2,
                 feature: f, s1: 0, s2: 0, emisi: 0, eko: 0, tk: 0, n: 0 };
      });
      (s.cells || []).forEach(function (cell) {
        for (var i = 0; i < GEO.features.length; i++) {
          if (pointInFeature(cell.lng, cell.lat, GEO.features[i].geometry)) {
            var k = kab[i];
            k.s1 += cell.s1; k.s2 += cell.s2; k.emisi += cell.emisi;
            k.eko += cell.eko; k.tk += cell.tk; k.n++;
            break;
          }
        }
      });
      var mE = 0, mK = 0, mT = 0;
      kab.forEach(function (k) { if (k.emisi > mE) mE = k.emisi; if (k.eko > mK) mK = k.eko; if (k.tk > mT) mT = k.tk; });
      kab.forEach(function (k) {
        var ne = mE ? k.emisi / mE : 0, nk = mK ? k.eko / mK : 0, nt = mT ? k.tk / mT : 0;
        k.ne = ne; k.nk = nk; k.nt = nt; k.score = (ne + nk + nt) / 3;
        k.ada = (k.emisi > 0 || k.eko > 0 || k.tk > 0);
      });
      var ranked = kab.slice().sort(function (a, b) { return b.score - a.score; });
      var rk = 0;
      ranked.forEach(function (k) { k.rank = k.ada ? (++rk) : null; });
      var byFid = {}; kab.forEach(function (k) { byFid[k.fid] = k; });
      s.kab = kab; s.kabRanked = ranked; s.kabByFid = byFid;
      s.kabMaxE = mE; s.kabMaxK = mK; s.kabMaxT = mT;
      s.kabNada = rk;
    });
  }

  Promise.all([Promise.all(SEKTOR.map(muat)), loadGeo()])
    .then(function () {
      aggregate(); buildBoundary();
      loader.classList.add("hidden"); buildLevels(); buildModes(); buildList(); select(activeKey);
    })
    .catch(function (err) {
      loader.textContent = "Gagal memuat data. Jalankan lewat local server lalu muat ulang.";
      loader.style.color = "#b56a5a"; console.error(err);
    });

  function sektorByKey(k) { for (var i = 0; i < SEKTOR.length; i++) if (SEKTOR[i].key === k) return SEKTOR[i]; }
  function modeByKey(k) { for (var i = 0; i < MODES.length; i++) if (MODES[i].key === k) return MODES[i]; }

  // garis batas kabupaten (referensi di level grid)
  function buildBoundary() {
    if (!GEO) return;
    boundaryLayer = L.geoJSON(GEO, {
      interactive: false,
      style: { color: "#6b6c5c", weight: 0.9, opacity: 0.55, fill: false }
    });
  }

  // ---------------- RENDER (dispatcher) ----------------
  function render() {
    if (activeLevel === "kab" && GEO) {
      if (boundaryLayer && map.hasLayer(boundaryLayer)) map.removeLayer(boundaryLayer);
      renderKab();
    } else {
      if (boundaryLayer && !map.hasLayer(boundaryLayer)) boundaryLayer.addTo(map);
      renderGrid();
      if (boundaryLayer) boundaryLayer.bringToFront();
    }
  }

  // ---------------- RENDER GRID ----------------
  function renderGrid() {
    var s = sektorByKey(activeKey), mode = modeByKey(activeMode);
    layer.clearLayers();
    var bounds = L.latLngBounds();
    var isPrio = mode.key === "prioritas";
    var ramp = isPrio ? rampPrio : rampEmisi;

    // batas warna
    var vals = s.cells.map(function (x) { return x[mode.field]; }).filter(function (v) { return v > 0; });
    var mn = vals.length ? Math.min.apply(null, vals) : 0, mx = vals.length ? Math.max.apply(null, vals) : 1;
    var lmin = Math.log(mn || 1), lmax = Math.log(mx || 1), span = (lmax - lmin) || 1;

    s.cells.forEach(function (cell) {
      var v = cell[mode.field];
      var t = isPrio ? v : (v > 0 ? (Math.log(v) - lmin) / span : 0);
      var col = ramp(t);
      var rect = L.rectangle(cell.b, {
        renderer: renderer, color: col, weight: 0.4, opacity: 0.5,
        fillColor: col, fillOpacity: v > 0 ? 0.80 : 0.12
      });
      rect.on("mouseover", function () {
        this.setStyle({ weight: 2, color: "#33332b", fillOpacity: 0.95 }); this.bringToFront();
        readout.innerHTML = '<div class="r-lab">' + s.nama + ' · peringkat #' + cell.rank + '</div>' +
          '<div class="r-val">' + (isPrio ? fmt3.format(cell.score) : fval(v)) + ' <span class="r-unit">' + mode.unit + '</span></div>';
        readout.hidden = false;
      });
      rect.on("mouseout", function () { this.setStyle({ weight: 0.4, color: col, fillOpacity: v > 0 ? 0.80 : 0.12 }); readout.hidden = true; });
      rect.on("click", function () { openCell(s, cell); });
      rect.addTo(layer);
      if (isPrio) rect.bindTooltip(String(cell.rank), { permanent: true, direction: "center", className: "rank-label" });
      bounds.extend(cell.b);
    });

    document.getElementById("rankTitle").textContent = "Peringkat Prioritas Grid";
    document.getElementById("rankColLoc").textContent = "Lokasi";
    updateKPI(s, mode); updateLegend(s, mode, mn, mx); renderTable(s);
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { animate: false });
  }

  // ---------------- RENDER KABUPATEN ----------------
  function renderKab() {
    var s = sektorByKey(activeKey), mode = modeByKey(activeMode);
    layer.clearLayers();
    featureLayers = {};
    var isPrio = mode.key === "prioritas";
    var ramp = isPrio ? rampPrio : rampEmisi;

    var vals = s.kab.filter(function (k) { return k.ada && k[mode.field] > 0; })
                    .map(function (k) { return k[mode.field]; });
    var mn = vals.length ? Math.min.apply(null, vals) : 0, mx = vals.length ? Math.max.apply(null, vals) : 1;
    var lmin = Math.log(mn || 1), lmax = Math.log(mx || 1), span = (lmax - lmin) || 1;

    function colorFor(k) {
      var v = k[mode.field];
      if (!k.ada || v <= 0) return "#d9d6c8";
      var t = isPrio ? v : (Math.log(v) - lmin) / span;
      return ramp(t);
    }

    var gl = L.geoJSON(GEO, {
      renderer: renderer,
      style: function (f) {
        var k = s.kabByFid[f.properties.fid];
        var col = colorFor(k);
        return { color: "#5b5c4e", weight: 0.8, opacity: 0.7, fillColor: col, fillOpacity: k.ada ? 0.82 : 0.18 };
      },
      onEachFeature: function (f, lyr) {
        var k = s.kabByFid[f.properties.fid];
        featureLayers[f.properties.fid] = lyr;
        lyr.on("mouseover", function () {
          this.setStyle({ weight: 2.2, color: "#33332b", fillOpacity: 0.95 }); this.bringToFront();
          readout.innerHTML = '<div class="r-lab">' + k.nama + (k.rank ? ' · peringkat #' + k.rank : '') + '</div>' +
            '<div class="r-val">' + (isPrio ? fmt3.format(k.score) : fval(k[mode.field])) + ' <span class="r-unit">' + mode.unit + '</span></div>';
          readout.hidden = false;
        });
        lyr.on("mouseout", function () { gl.resetStyle(this); readout.hidden = true; });
        lyr.on("click", function () { openKab(s, k); });
        if (isPrio && k.rank) lyr.bindTooltip(String(k.rank), { permanent: true, direction: "center", className: "rank-label" });
      }
    }).addTo(layer);

    document.getElementById("rankTitle").textContent = "Peringkat Prioritas Kabupaten";
    document.getElementById("rankColLoc").textContent = "Kabupaten";
    updateKPIKab(s, mode); updateLegend(s, mode, mn, mx); renderTableKab(s);
    var b = gl.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.05), { animate: false });
  }

  function openKab(s, k) {
    var c = featureLayers[k.fid] ? featureLayers[k.fid].getBounds().getCenter() : map.getCenter();
    L.popup({ maxWidth: 260 }).setLatLng(c).setContent(
      '<div class="popup-eyebrow">' + s.nama + ' · KBLI ' + s.kbli + '</div>' +
      '<div class="popup-rank">' + k.nama + '</div>' +
      '<div class="popup-score">' + (k.rank ? 'Peringkat prioritas #' + k.rank + ' dari ' + s.kabNada + ' · skor ' + fmt3.format(k.score) : 'Tanpa data sektor ini') + '</div>' +
      '<table class="popup-tab">' +
        '<tr><td>Emisi S1+S2</td><td>' + fval(k.emisi) + ' t</td><td>' + fmt.format(k.ne * 100) + '%</td></tr>' +
        '<tr><td>Ekonomi (NT)</td><td>' + fval(k.eko) + ' rb Rp</td><td>' + fmt.format(k.nk * 100) + '%</td></tr>' +
        '<tr><td>Tenaga Kerja</td><td>' + fval(k.tk) + ' org</td><td>' + fmt.format(k.nt * 100) + '%</td></tr>' +
      '</table>' +
      '<div class="popup-coord">' + k.n + ' sel grid · ' + k.tipe + '</div>'
    ).openOn(map);
  }

  function openCell(s, cell) {
    L.popup({ maxWidth: 260 }).setLatLng([cell.lat, cell.lng]).setContent(
      '<div class="popup-eyebrow">' + s.nama + ' · KBLI ' + s.kbli + '</div>' +
      '<div class="popup-rank">Peringkat prioritas #' + cell.rank + ' dari ' + s.cells.length + '</div>' +
      '<div class="popup-score">Skor ' + fmt3.format(cell.score) + '</div>' +
      '<table class="popup-tab">' +
        '<tr><td>Emisi S1+S2</td><td>' + fval(cell.emisi) + ' t</td><td>' + fmt.format(cell.ne * 100) + '%</td></tr>' +
        '<tr><td>Ekonomi (NT)</td><td>' + fval(cell.eko) + ' rb Rp</td><td>' + fmt.format(cell.nk * 100) + '%</td></tr>' +
        '<tr><td>Tenaga Kerja</td><td>' + fval(cell.tk) + ' org</td><td>' + fmt.format(cell.nt * 100) + '%</td></tr>' +
      '</table>' +
      '<div class="popup-coord">' + fmt1.format(cell.lat) + '°, ' + fmt1.format(cell.lng) + '°</div>'
    ).openOn(map);
  }

  function updateKPI(s, mode) {
    var elT = document.getElementById("kpiTotal"), elC = document.getElementById("kpiCells"), elM = document.getElementById("kpiMax");
    document.getElementById("kpiUnit").textContent = mode.unit;
    if (mode.key === "prioritas") {
      document.getElementById("kpiTotalLabel").textContent = "Sel Diperingkat";
      document.getElementById("kpiAltLabel").textContent = "Sel Terisi";
      document.getElementById("kpiMaxLabel").textContent = "Skor #1";
      elT.textContent = fnum(s.cells.length); document.getElementById("kpiUnit").textContent = "sel";
      elC.textContent = fnum(s.cells.length);
      elM.textContent = s.cells.length ? fmt3.format(s.cells[0].score) : "–";
    } else {
      var tot = mode.key === "emisi" ? s.totEmisi : mode.key === "ekonomi" ? s.totEko : s.totTk;
      var mx = mode.key === "emisi" ? s.maxE : mode.key === "ekonomi" ? s.maxK : s.maxT;
      document.getElementById("kpiTotalLabel").textContent = "Total " + mode.nama;
      document.getElementById("kpiAltLabel").textContent = "Sel Terisi";
      document.getElementById("kpiMaxLabel").textContent = "Sel Tertinggi";
      elT.textContent = fval(tot);
      elC.textContent = fnum(s.cells.filter(function (x) { return x[mode.field] > 0; }).length);
      elM.textContent = fval(mx);
    }
  }

  function updateKPIKab(s, mode) {
    var elT = document.getElementById("kpiTotal"), elC = document.getElementById("kpiCells"), elM = document.getElementById("kpiMax");
    document.getElementById("kpiUnit").textContent = mode.unit;
    if (mode.key === "prioritas") {
      document.getElementById("kpiTotalLabel").textContent = "Kab./Kota Berdata";
      document.getElementById("kpiAltLabel").textContent = "Total Wilayah";
      document.getElementById("kpiMaxLabel").textContent = "Skor #1";
      document.getElementById("kpiUnit").textContent = "wilayah";
      elT.textContent = fnum(s.kabNada);
      elC.textContent = fnum(s.kab.length);
      elM.textContent = s.kabRanked.length && s.kabRanked[0].ada ? fmt3.format(s.kabRanked[0].score) : "–";
    } else {
      var sum = s.kab.reduce(function (a, k) { return a + k[mode.field]; }, 0);
      var mx = s.kab.reduce(function (a, k) { return Math.max(a, k[mode.field]); }, 0);
      document.getElementById("kpiTotalLabel").textContent = "Total " + mode.nama;
      document.getElementById("kpiAltLabel").textContent = "Kab./Kota Berdata";
      document.getElementById("kpiMaxLabel").textContent = "Wilayah Tertinggi";
      elT.textContent = fval(sum);
      elC.textContent = fnum(s.kabNada);
      elM.textContent = fval(mx);
    }
  }

  function updateLegend(s, mode, mn, mx) {
    document.getElementById("legendMode").textContent = mode.nama;
    if (mode.key === "prioritas") { document.getElementById("legMin").textContent = "0"; document.getElementById("legMax").textContent = "1"; }
    else { document.getElementById("legMin").textContent = fval(mn); document.getElementById("legMax").textContent = fval(mx); }
    var ramp = mode.key === "prioritas" ? rampPrio : rampEmisi;
    var stops = ramp.length;
    var grad = [];
    for (var i = 0; i <= 10; i++) grad.push((mode.key === "prioritas" ? rampPrio : rampEmisi)(i / 10) + " " + (i * 10) + "%");
    document.getElementById("legendBar").style.background = "linear-gradient(90deg," + grad.join(",") + ")";
  }

  // ---------------- TABEL PERINGKAT ----------------
  function renderTable(s) {
    document.getElementById("rankSektor").textContent = "· " + s.nama;
    var body = document.getElementById("rankBody");
    body.innerHTML = "";
    s.cells.forEach(function (cell) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="rk">' + cell.rank + '</td>' +
        '<td class="loc">' + fmt1.format(cell.lat) + ', ' + fmt1.format(cell.lng) + '</td>' +
        '<td class="sc">' + fmt3.format(cell.score) + '</td>' +
        '<td>' + fval(cell.emisi) + '</td>' +
        '<td>' + fval(cell.eko) + '</td>' +
        '<td>' + fval(cell.tk) + '</td>';
      tr.addEventListener("click", function () { map.setView([cell.lat, cell.lng], 10, { animate: true }); openCell(s, cell); });
      body.appendChild(tr);
    });
  }

  function renderTableKab(s) {
    document.getElementById("rankSektor").textContent = "· " + s.nama;
    var body = document.getElementById("rankBody");
    body.innerHTML = "";
    s.kabRanked.forEach(function (k) {
      if (!k.ada) return;
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="rk">' + k.rank + '</td>' +
        '<td class="loc">' + k.nama + '</td>' +
        '<td class="sc">' + fmt3.format(k.score) + '</td>' +
        '<td>' + fval(k.emisi) + '</td>' +
        '<td>' + fval(k.eko) + '</td>' +
        '<td>' + fval(k.tk) + '</td>';
      tr.addEventListener("click", function () {
        var lyr = featureLayers[k.fid];
        if (lyr) map.fitBounds(lyr.getBounds().pad(0.1), { animate: true });
        openKab(s, k);
      });
      body.appendChild(tr);
    });
  }

  // ---------------- UI: TINGKAT, MODE & SEKTOR ----------------
  function buildLevels() {
    var el = document.getElementById("levelList"); el.innerHTML = "";
    LEVELS.forEach(function (lv) {
      var b = document.createElement("button");
      b.className = "mode-btn" + (lv.key === activeLevel ? " active" : "");
      b.dataset.level = lv.key; b.textContent = lv.nama;
      if (lv.key === "kab" && !GEO) { b.disabled = true; b.style.opacity = 0.5; }
      b.addEventListener("click", function () {
        activeLevel = lv.key;
        Array.prototype.forEach.call(el.children, function (x) { x.classList.toggle("active", x.dataset.level === lv.key); });
        render();
      });
      el.appendChild(b);
    });
  }

  function buildModes() {
    var el = document.getElementById("modeList"); el.innerHTML = "";
    MODES.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "mode-btn" + (m.key === activeMode ? " active" : "");
      b.dataset.mode = m.key; b.textContent = m.nama;
      b.addEventListener("click", function () {
        activeMode = m.key;
        Array.prototype.forEach.call(el.children, function (x) { x.classList.toggle("active", x.dataset.mode === m.key); });
        render();
      });
      el.appendChild(b);
    });
  }

  function buildList() {
    var listEl = document.getElementById("sektorList"); listEl.innerHTML = "";
    SEKTOR.forEach(function (s, idx) {
      var li = document.createElement("li");
      li.className = "sektor-item" + (s.key === activeKey ? " active" : "");
      li.dataset.key = s.key;
      li.innerHTML =
        '<span class="sektor-num">' + String(idx + 1).padStart(2, "0") + '</span>' +
        '<span class="sektor-dot" style="background:' + s.dot + '"></span>' +
        '<span class="sektor-meta">' +
          '<span class="sektor-nama">' + s.nama + '</span>' +
          '<span class="sektor-sub">KBLI ' + s.kbli + ' · ' + fnum(s.cells.length) + ' sel</span>' +
        '</span>' +
        '<span class="sektor-total">#1 ' + (s.cells.length ? fmt3.format(s.cells[0].score) : "–") + '</span>';
      li.addEventListener("click", function () { select(s.key); });
      listEl.appendChild(li);
    });
  }

  function select(key) {
    activeKey = key;
    var listEl = document.getElementById("sektorList");
    Array.prototype.forEach.call(listEl.children, function (li) { li.classList.toggle("active", li.dataset.key === key); });
    render();
    if (window.innerWidth <= 720) document.getElementById("panel").classList.remove("hidden");
  }

  // ---------------- BASEMAP & TOGGLE ----------------
  document.getElementById("basemaps").addEventListener("click", function (e) {
    var btn = e.target.closest("button"); if (!btn) return;
    Object.keys(bases).forEach(function (k) { map.removeLayer(bases[k]); });
    bases[btn.dataset.base].addTo(map);
    Array.prototype.forEach.call(this.children, function (b) { b.classList.toggle("active", b === btn); });
  });
  document.getElementById("panelToggle").addEventListener("click", function () {
    document.getElementById("panel").classList.toggle("hidden");
  });
})();
