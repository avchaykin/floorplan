// Wall geometry: merges axis-aligned rectangles into rectilinear polygons.
// Works on a compressed coordinate grid, so touching/overlapping rectangles
// become one outline (with holes) and every straight boundary run is one segment.
(function (root) {
  'use strict';

  function uniqSorted(values) {
    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  // Index of the grid cell containing v (cells are [c[i], c[i+1])), or -1.
  function cellIndex(coords, v) {
    if (coords.length < 2 || v < coords[0] || v > coords[coords.length - 1]) return -1;
    let lo = 0, hi = coords.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (coords[mid] <= v) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function buildWalls(rects) {
    rects = rects.filter(r => r.w > 0 && r.h > 0);
    const xs = uniqSorted(rects.flatMap(r => [r.x, r.x + r.w]));
    const ys = uniqSorted(rects.flatMap(r => [r.y, r.y + r.h]));
    const nx = Math.max(xs.length - 1, 0), ny = Math.max(ys.length - 1, 0);
    const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
    const fill = new Uint8Array(nx * ny);
    for (const r of rects) {
      const i0 = xi.get(r.x), i1 = xi.get(r.x + r.w), j0 = yi.get(r.y), j1 = yi.get(r.y + r.h);
      for (let j = j0; j < j1; j++) fill.fill(1, j * nx + i0, j * nx + i1);
    }
    const filled = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && fill[j * nx + i] === 1;

    // Connected components (edge-adjacent cells) = individual walls.
    const comp = new Int32Array(nx * ny).fill(-1);
    let ncomp = 0;
    for (let s = 0; s < nx * ny; s++) {
      if (!fill[s] || comp[s] !== -1) continue;
      const stack = [s];
      comp[s] = ncomp;
      while (stack.length) {
        const c = stack.pop(), i = c % nx, j = (c - i) / nx;
        for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
          if (filled(a, b) && comp[b * nx + a] === -1) {
            comp[b * nx + a] = ncomp;
            stack.push(b * nx + a);
          }
        }
      }
      ncomp++;
    }

    // Boundary edges, directed clockwise on screen (y down), wall on the right.
    const edges = [];
    const byStart = new Map();
    function addEdge(x1, y1, x2, y2, nxn, nyn, c) {
      const e = { x1, y1, x2, y2, nx: nxn, ny: nyn, comp: c, used: false };
      edges.push(e);
      const k = x1 + ',' + y1;
      if (!byStart.has(k)) byStart.set(k, []);
      byStart.get(k).push(e);
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!fill[j * nx + i]) continue;
        const c = comp[j * nx + i];
        const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
        if (!filled(i, j - 1)) addEdge(x0, y0, x1, y0, 0, -1, c);
        if (!filled(i + 1, j)) addEdge(x1, y0, x1, y1, 1, 0, c);
        if (!filled(i, j + 1)) addEdge(x1, y1, x0, y1, 0, 1, c);
        if (!filled(i - 1, j)) addEdge(x0, y1, x0, y0, -1, 0, c);
      }
    }

    const dirOf = e => [Math.sign(e.x2 - e.x1), Math.sign(e.y2 - e.y1)];
    const segments = [];
    const loops = [];
    for (const e0 of edges) {
      if (e0.used) continue;
      const chain = [];
      let cur = e0;
      for (;;) {
        cur.used = true;
        chain.push(cur);
        const out = byStart.get(cur.x2 + ',' + cur.y2) || [];
        const [dx, dy] = dirOf(cur);
        // Prefer the right turn so walls touching only at a corner stay separate.
        const pick = out.find(o => { const d = dirOf(o); return d[0] === -dy && d[1] === dx; })
          || out.find(o => { const d = dirOf(o); return d[0] === dx && d[1] === dy; })
          || out[0];
        if (!pick || pick === e0 || pick.used) break;
        cur = pick;
      }
      // Rotate so the chain starts at a corner, then merge collinear runs.
      const n = chain.length;
      let start = 0;
      for (let k = 0; k < n; k++) {
        const a = dirOf(chain[(k + n - 1) % n]), b = dirOf(chain[k]);
        if (a[0] !== b[0] || a[1] !== b[1]) { start = k; break; }
      }
      const loopIndex = loops.length;
      const points = [];
      let seg = null;
      for (let k = 0; k < n; k++) {
        const e = chain[(start + k) % n];
        if (seg && seg.nx === e.nx && seg.ny === e.ny) {
          seg.x2 = e.x2; seg.y2 = e.y2;
        } else {
          seg = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, nx: e.nx, ny: e.ny, comp: e.comp, loop: loopIndex };
          segments.push(seg);
          points.push([e.x1, e.y1]);
        }
      }
      loops.push({ points, comp: e0.comp });
    }
    for (const s of segments) {
      s.len = Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1);
      s.key = s.x1 + ',' + s.y1 + ',' + s.x2 + ',' + s.y2;
    }

    function cellAt(px, py) {
      const i = cellIndex(xs, px), j = cellIndex(ys, py);
      return i >= 0 && j >= 0 && filled(i, j) ? [i, j] : null;
    }

    // How far the wall reaches from a point in each direction, or null outside walls.
    function extent(px, py) {
      const c = cellAt(px, py);
      if (!c) return null;
      let [i0, j0] = c, i1 = i0, j1 = j0;
      const [i, j] = c;
      while (filled(i0 - 1, j)) i0--;
      while (filled(i1 + 1, j)) i1++;
      while (filled(i, j0 - 1)) j0--;
      while (filled(i, j1 + 1)) j1++;
      return { left: xs[i0], right: xs[i1 + 1], top: ys[j0], bottom: ys[j1 + 1], comp: comp[j * nx + i] };
    }

    return { xs, ys, segments, loops, ncomp, extent, contains: (px, py) => !!cellAt(px, py) };
  }

  const api = { buildWalls };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof window !== 'undefined' ? window : globalThis);

(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const svg = $('#canvas'), panel = $('#panel');

  const INK = '#2b2b2b', ACCENT = '#1a73e8', BAD = '#c62828';
  const DIM_OFFSET = 18;          // px between wall face and dimension line at 100% distance
  const FONTS = {
    system: ['System', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"],
    arial: ['Arial', 'Arial, Helvetica, sans-serif'],
    times: ['Times New Roman', "'Times New Roman', Times, serif"],
    georgia: ['Georgia', 'Georgia, serif'],
    courier: ['Courier New', "'Courier New', Courier, monospace"],
    mono: ['Monospace', 'ui-monospace, Menlo, monospace'],
  };
  // Fonts added from Google Fonts are stored by family name and referred to as 'g:<name>'.
  const GOOGLE_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/;
  const fontCss = key => key.startsWith('g:') ? `'${key.slice(2)}', sans-serif` : FONTS[key][1];
  const fontChoices = () => Object.entries(FONTS).map(([k, v]) => [k, v[0]])
    .concat(doc.settings.googleFonts.map(n => ['g:' + n, n + ' (Google)']));

  const loadedGoogleFonts = new Set();
  function googleFontLink(name, weight) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}${weight ? ':wght@' + weight : ''}&display=swap`;
    document.head.appendChild(link);
    return link;
  }
  // Loads the fonts a plan uses. The bold cut is requested separately because not every family has one.
  function loadGoogleFonts() {
    for (const name of doc.settings.googleFonts) {
      if (loadedGoogleFonts.has(name)) continue;
      loadedGoogleFonts.add(name);
      googleFontLink(name);
      googleFontLink(name, 700);
    }
  }
  function addGoogleFont(raw) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!GOOGLE_FONT_NAME.test(name)) return toast('Enter the font name as shown on fonts.google.com, e.g. Roboto.');
    if (doc.settings.googleFonts.includes(name)) return toast(`${name} is already added.`);
    const link = googleFontLink(name);
    link.onload = () => {
      loadedGoogleFonts.add(name);
      googleFontLink(name, 700);
      doc.settings.googleFonts.push(name);
      commit();
      toast(`${name} added — choose it in a Font list.`);
    };
    link.onerror = () => {
      link.remove();
      toast(`Could not load “${name}” from Google Fonts. Check the name and your internet connection.`);
    };
  }

  const DIM_ENDS = { arrow: 'Arrows, filled', vNarrow: 'V-arrows, narrow', vWide: 'V-arrows, wide', tick: 'Ticks', dot: 'Dots', none: 'None' };

  // Appearance settings, stored with each plan.
  function defaultSettings() {
    return { wallColor: '#4d4d4d', dimEnds: 'dot', dimColor: '#5f6b7a', dimFont: 'system', dimFontSize: 11, dimFontColor: '#5f6b7a', dimDistance: 100, objFont: 'system', objFontSize: 11, objFontColor: '#5f6b7a', googleFonts: [] };
  }

  function cleanSettings(raw) {
    const out = defaultSettings(), src = raw || {};
    const colour = v => /^#[0-9a-f]{6}$/i.test(v);
    for (const k of ['wallColor', 'dimColor', 'dimFontColor', 'objFontColor']) if (colour(src[k])) out[k] = src[k];
    if (DIM_ENDS[src.dimEnds]) out.dimEnds = src.dimEnds;
    if (Array.isArray(src.googleFonts)) out.googleFonts = Array.from(new Set(src.googleFonts.filter(n => typeof n === 'string' && GOOGLE_FONT_NAME.test(n))));
    const knownFont = k => !!FONTS[k] || (typeof k === 'string' && k.startsWith('g:') && out.googleFonts.includes(k.slice(2)));
    for (const k of ['dimFont', 'objFont']) if (knownFont(src[k])) out[k] = src[k];
    for (const k of ['dimFontSize', 'objFontSize']) if (Number.isFinite(src[k])) out[k] = Math.min(Math.max(Math.round(src[k]), 6), 40);
    if (Number.isFinite(src.dimDistance)) out.dimDistance = Math.min(Math.max(Math.round(src.dimDistance), 20), 500);
    return out;
  }
  const ORPHAN_THICKNESS = 150;   // mm, used when an opening is no longer inside a wall
  const OPENING_TOOLS = ['door', 'doorway', 'window'];
  // Geometry is always stored in mm; the unit only changes how lengths are shown and typed.
  const UNITS = { mm: { factor: 1, digits: 0, step: 10 }, cm: { factor: 10, digits: 1, step: 1 }, m: { factor: 1000, digits: 3, step: 0.01 } };
  const SNAPS = [1, 5, 10, 50, 100];
  const DRAFT_KEY = 'floorplan-draft', DEFAULTS_KEY = 'floorplan-defaults', LAST_FILE_KEY = 'floorplan-last-file';

  // ---------- Document ----------

  function newDoc() {
    return { format: 'floorplan', version: 1, units: 'mm', nextId: 1, walls: [], openings: [], objects: [], hiddenDimensions: [], realDimensions: {}, settings: defaultSettings() };
  }

  function normalizeDoc(d) {
    if (!d || d.format !== 'floorplan' || !Array.isArray(d.walls)) throw new Error('not a floorplan file');
    const out = newDoc();
    if (UNITS[d.units]) out.units = d.units;
    out.settings = cleanSettings(d.settings);
    out.walls = d.walls.filter(r => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
    out.openings = (d.openings || []).filter(o => OPENING_TOOLS.includes(o.type) && Number.isFinite(o.x) && Number.isFinite(o.y));
    out.hiddenDimensions = (d.hiddenDimensions || []).filter(k => typeof k === 'string');
    for (const [k, v] of Object.entries(d.realDimensions || {})) if (Number.isFinite(v) && v > 0) out.realDimensions[k] = v;
    out.objects = (d.objects || []).filter(o => [o.x, o.y, o.w, o.h].every(Number.isFinite) && o.w > 0 && o.h > 0)
      .map(o => ({ id: o.id, name: typeof o.name === 'string' ? o.name : '', description: typeof o.description === 'string' ? o.description : '', x: o.x, y: o.y, w: o.w, h: o.h, rot: Number.isFinite(o.rot) ? o.rot : 0 }));
    const ids = out.walls.concat(out.openings, out.objects).map(o => +o.id || 0);
    out.nextId = Math.max(d.nextId || 1, 1, ...ids.map(i => i + 1));
    return out;
  }

  const defaults = {
    door: { frameSize: 900, doorSize: 800 },
    doorway: { frameSize: 900 },
    window: { size: 1200, sillSize: 1300, sillDepth: 200 },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}');
    for (const t of OPENING_TOOLS) Object.assign(defaults[t], saved[t]);
  } catch (e) { /* keep built-in defaults */ }

  let doc = newDoc();
  let walls = Geo.buildWalls([]);
  let history = [], hIndex = -1;
  let tool = 'select';
  let showSettings = false;   // side panel shows the plan settings
  let sel = null;       // {kind: 'wall'|'opening', id} | {kind: 'dim'|'edge', key}
  let drag = null;
  let previewDim = null;   // key of a hidden dimension highlighted from the side panel
  let ghost = null;     // opening preview while a door/window tool is active
  let snap = 50;
  let spaceDown = false;
  const view = { scale: 0.08, ox: 80, oy: 80 };   // screen px = mm * scale + offset

  const rebuild = () => { walls = Geo.buildWalls(doc.walls); };
  const freshDoc = () => Object.assign(newDoc(), { units: doc.units, settings: Object.assign({}, doc.settings) });
  const isEmpty = () => !doc.walls.length && !doc.openings.length && !doc.objects.length;

  function resetHistory() {
    history = [JSON.stringify(doc)];
    hIndex = 0;
  }

  function commit() {
    rebuild();
    const s = JSON.stringify(doc);
    if (s !== history[hIndex]) {
      history.length = hIndex + 1;
      history.push(s);
      hIndex++;
      scheduleSave();
    }
    renderAll();
  }

  function stepHistory(d) {
    if (hIndex + d < 0 || hIndex + d >= history.length) return;
    hIndex += d;
    doc = JSON.parse(history[hIndex]);
    sel = null;
    rebuild();
    scheduleSave();
    renderAll();
  }

  function setDoc(d) {
    doc = d;
    sel = null;
    rebuild();
    resetHistory();
    fitView();
    renderAll();
  }

  // ---------- View helpers ----------

  const S = (x, y) => [x * view.scale + view.ox, y * view.scale + view.oy];
  const toWorld = p => ({ x: (p.x - view.ox) / view.scale, y: (p.y - view.oy) / view.scale });
  const f = n => n.toFixed(1);
  const fmt = mm => String(Number((mm / UNITS[doc.units].factor).toFixed(UNITS[doc.units].digits)));
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function pointer(e) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  const snapv = (v, e) => (e && e.altKey) ? Math.round(v) : Math.round(v / snap) * snap;

  // Snap to the grid, preferring existing wall edges that are close on screen.
  function snapPoint(w, e) {
    const out = { x: snapv(w.x, e), y: snapv(w.y, e) };
    if (e && e.altKey) return out;
    const tol = 7 / view.scale;
    const nearest = (coords, v) => {
      let best = null;
      for (const c of coords) if (Math.abs(c - v) < tol && (best === null || Math.abs(c - v) < Math.abs(best - v))) best = c;
      return best;
    };
    const ex = nearest(walls.xs, w.x), ey = nearest(walls.ys, w.y);
    if (ex !== null) out.x = ex;
    if (ey !== null) out.y = ey;
    return out;
  }

  function zoomAt(px, py, factor) {
    const ns = clamp(view.scale * factor, 0.01, 2);
    view.ox = px - (px - view.ox) * ns / view.scale;
    view.oy = py - (py - view.oy) * ns / view.scale;
    view.scale = ns;
    render();
  }

  function fitView() {
    const r = svg.getBoundingClientRect();
    const boxes = doc.walls.concat(doc.objects.map(o => {
      const d = Math.hypot(o.w, o.h);    // covers the object at any rotation
      return { x: o.x - d / 2, y: o.y - d / 2, w: d, h: d };
    }));
    if (!boxes.length || !r.width) {
      view.scale = 0.08; view.ox = 80; view.oy = 80;
      return;
    }
    const x0 = Math.min(...boxes.map(w => w.x)), x1 = Math.max(...boxes.map(w => w.x + w.w));
    const y0 = Math.min(...boxes.map(w => w.y)), y1 = Math.max(...boxes.map(w => w.y + w.h));
    const pad = 90;
    view.scale = clamp(Math.min((r.width - 2 * pad) / (x1 - x0), (r.height - 2 * pad) / (y1 - y0)), 0.01, 0.5);
    view.ox = (r.width - (x1 - x0) * view.scale) / 2 - x0 * view.scale;
    view.oy = (r.height - (y1 - y0) * view.scale) / 2 - y0 * view.scale;
  }

  // ---------- Openings ----------

  const openingWidth = o => o.type === 'window' ? o.size : o.frameSize;
  const axisVectors = axis => axis === 'h' ? { u: [1, 0], n: [0, 1] } : { u: [0, 1], n: [1, 0] };

  // Where an opening sits in the wall under a point: axis, centre line and which side the cursor is on.
  function locate(w, width, e) {
    const ext = walls.extent(w.x, w.y);
    if (!ext) return null;
    const wx = ext.right - ext.left, wy = ext.bottom - ext.top;
    if (wy <= wx) {
      const y = (ext.top + ext.bottom) / 2;
      let x = snapv(w.x, e);
      if (wx >= width) x = clamp(x, ext.left + width / 2, ext.right - width / 2);
      return { axis: 'h', x, y, side: w.y >= y ? 1 : -1 };
    }
    const x = (ext.left + ext.right) / 2;
    let y = snapv(w.y, e);
    if (wy >= width) y = clamp(y, ext.top + width / 2, ext.bottom - width / 2);
    return { axis: 'v', x, y, side: w.x >= x ? 1 : -1 };
  }

  // Centre and wall thickness for an opening, derived from the current walls.
  function resolveOpening(o) {
    const ext = walls.extent(o.x, o.y);
    if (!ext) return { cx: o.x, cy: o.y, t: ORPHAN_THICKNESS, ok: false };
    if (o.axis === 'h') return { cx: o.x, cy: (ext.top + ext.bottom) / 2, t: ext.bottom - ext.top, ok: true, comp: ext.comp };
    return { cx: (ext.left + ext.right) / 2, cy: o.y, t: ext.right - ext.left, ok: true, comp: ext.comp };
  }

  function makeOpening(type, loc) {
    const o = Object.assign({ id: 0, type, x: loc.x, y: loc.y, axis: loc.axis }, defaults[type]);
    if (type === 'door') { o.hinge = 'start'; o.swing = loc.side; }
    if (type === 'window') o.sillSide = loc.side;
    return o;
  }

  function hitOpening(w) {
    for (let i = doc.openings.length - 1; i >= 0; i--) {
      const o = doc.openings[i], r = resolveOpening(o), { u, n } = axisVectors(o.axis);
      const dx = w.x - r.cx, dy = w.y - r.cy;
      const a = dx * u[0] + dy * u[1], b = dx * n[0] + dy * n[1];
      if (Math.abs(a) <= openingWidth(o) / 2 && Math.abs(b) <= r.t / 2 + 4 / view.scale) return o;
    }
    return null;
  }

  // ---------- Objects ----------
  // Free rectangles (furniture, appliances, ...) stored by centre, size and rotation. They ignore walls.

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function objToWorld(o, lx, ly) {
    const a = o.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    return [o.x + lx * c - ly * sn, o.y + lx * sn + ly * c];
  }

  function objToLocal(o, w) {
    const a = o.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), dx = w.x - o.x, dy = w.y - o.y;
    return { x: dx * c + dy * sn, y: -dx * sn + dy * c };
  }

  // Resize handles on the outline plus one rotation handle above the top edge.
  function objectHandles(o) {
    const at = (lx, ly) => S(...objToWorld(o, lx, ly));
    const list = HANDLES.map(([id, fx, fy]) => ({ id, fx, fy, p: at((fx - .5) * o.w, (fy - .5) * o.h) }));
    list.push({ id: 'rot', p: at(0, -o.h / 2 - 24 / view.scale) });
    return list;
  }

  function hitObject(w) {
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const o = doc.objects[i], l = objToLocal(o, w);
      if (Math.abs(l.x) <= o.w / 2 && Math.abs(l.y) <= o.h / 2) return o;
    }
    return null;
  }

  function objectSvg(o, selected, preview) {
    const st = doc.settings, [cx, cy] = S(o.x, o.y), pw = o.w * view.scale, ph = o.h * view.scale;
    const stroke = selected || preview ? ACCENT : INK;
    let g = `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${o.rot})">` +
      `<rect x="${f(-pw / 2)}" y="${f(-ph / 2)}" width="${f(pw)}" height="${f(ph)}" fill="#fff" fill-opacity=".85" stroke="${stroke}" stroke-width="${selected ? 2 : 1.2}"${preview ? ' stroke-dasharray="5 3"' : ''}/>`;
    // Name and size, as many lines as fit; the text always turns with the object.
    const size = st.objFontSize, lines = [o.name, `${fmt(o.w)} × ${fmt(o.h)}`].filter(Boolean);
    const fits = n => ph >= n * size * 1.25 + 4 && lines.slice(0, n).every(t => pw >= t.length * size * (t === o.name ? 0.66 : 0.6) + 6);
    const count = fits(lines.length) ? lines.length : fits(1) ? 1 : 0;
    for (let i = 0; i < count; i++) {
      const y = (i - (count - 1) / 2) * size * 1.25;
      g += `<text x="0" y="${f(y)}" style="font-family:${fontCss(st.objFont)};font-size:${size}px${i === 0 && o.name ? ';font-weight:700' : ''}" text-anchor="middle" dominant-baseline="central" fill="${selected ? ACCENT : st.objFontColor}">${esc(lines[i])}</text>`;
    }
    g += '</g>';
    if (selected) {
      const hs = objectHandles(o), rot = hs[hs.length - 1], top = hs.find(x => x.id === 'n');
      g += line(top.p, rot.p, `stroke="${ACCENT}" stroke-width="1"`);
      for (const hp of hs) {
        g += hp.id === 'rot'
          ? `<circle cx="${f(hp.p[0])}" cy="${f(hp.p[1])}" r="5" fill="#fff" stroke="${ACCENT}" stroke-width="1.5"/>`
          : `<rect x="${f(hp.p[0] - 4)}" y="${f(hp.p[1] - 4)}" width="8" height="8" fill="#fff" stroke="${ACCENT}" stroke-width="1.5"/>`;
      }
    }
    return g;
  }

  // ---------- Dimensions ----------

  const isHidden = key => doc.hiddenDimensions.includes(key);
  // A real-world measurement entered for a dimension replaces the drawn length in its label, marked with *.
  const realOf = dim => doc.realDimensions[dim.key];
  const dimText = dim => realOf(dim) ? fmt(realOf(dim)) + '*' : fmt(dim.len);

  function setHidden(keys, hidden) {
    const set = new Set(doc.hiddenDimensions);
    for (const k of keys) hidden ? set.add(k) : set.delete(k);
    doc.hiddenDimensions = Array.from(set);
  }

  // Dimensions of one wall line. A line with doors/windows in it gets a chain
  // (wall part, opening, wall part, ...) next to the wall and the overall length outside it.
  const dimOffset = () => DIM_OFFSET * doc.settings.dimDistance / 100;

  function dimsOf(seg) {
    const horiz = seg.ny !== 0;
    const lo = horiz ? Math.min(seg.x1, seg.x2) : Math.min(seg.y1, seg.y2), hi = lo + seg.len;
    const face = horiz ? seg.y1 : seg.x1;
    const cuts = [];
    for (const o of doc.openings) {
      if ((o.axis === 'h') !== horiz) continue;
      const r = resolveOpening(o);
      if (!r.ok || r.comp !== seg.comp) continue;
      const across = horiz ? r.cy : r.cx, along = horiz ? r.cx : r.cy, half = openingWidth(o) / 2;
      if (Math.abs(Math.abs(face - across) - r.t / 2) > 0.01) continue;
      const a = Math.max(along - half, lo), b = Math.min(along + half, hi);
      if (b > a) cuts.push(a, b);
    }
    const base = { nx: seg.nx, ny: seg.ny, comp: seg.comp, segKey: seg.key };
    const overall = Object.assign({
      key: seg.key, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, len: seg.len,
      off: cuts.length ? dimOffset() + doc.settings.dimFontSize + 13 : dimOffset(),
    }, base);
    if (!cuts.length) return [overall];
    const stops = Array.from(new Set([lo, hi].concat(cuts))).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i], b = stops[i + 1];
      const c = horiz ? [a, face, b, face] : [face, a, face, b];
      out.push(Object.assign({ key: 'p:' + c.join(','), x1: c[0], y1: c[1], x2: c[2], y2: c[3], len: b - a, off: dimOffset() }, base));
    }
    out.push(overall);
    return out;
  }

  const allDims = () => walls.segments.flatMap(dimsOf);

  function dimGeom(dim) {
    const [ax, ay] = S(dim.x1, dim.y1), [bx, by] = S(dim.x2, dim.y2);
    const ox = dim.nx * dim.off, oy = dim.ny * dim.off, textOff = dim.off + doc.settings.dimFontSize * 0.82;
    return {
      ax, ay, bx, by,
      a: [ax + ox, ay + oy], b: [bx + ox, by + oy],
      tx: (ax + bx) / 2 + dim.nx * textOff, ty: (ay + by) / 2 + dim.ny * textOff,
      vertical: dim.nx !== 0,
      text: dimText(dim),
    };
  }

  const visibleDims = () => allDims().filter(d => !isHidden(d.key) && d.len * view.scale >= 14);

  function distToSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - a[0] - t * dx, p.y - a[1] - t * dy);
  }

  function hitDim(p) {
    for (const seg of visibleDims()) {
      const g = dimGeom(seg);
      const size = doc.settings.dimFontSize, hw = g.text.length * size * 0.32 + 3, hh = size * 0.73;
      const inText = Math.abs(p.x - g.tx) <= (g.vertical ? hh : hw) && Math.abs(p.y - g.ty) <= (g.vertical ? hw : hh);
      if (inText || distToSegment(p, g.a, g.b) <= 5) return seg;
    }
    return null;
  }

  function hitEdge(p) {
    let best = null, bestD = 4.5;
    for (const seg of walls.segments) {
      const d = distToSegment(p, S(seg.x1, seg.y1), S(seg.x2, seg.y2));
      if (d < bestD) { best = seg; bestD = d; }
    }
    return best;
  }

  function hitRect(w, tolPx) {
    const t = (tolPx || 0) / view.scale;
    for (let i = doc.walls.length - 1; i >= 0; i--) {
      const r = doc.walls[i];
      if (w.x >= r.x - t && w.x <= r.x + r.w + t && w.y >= r.y - t && w.y <= r.y + r.h + t) return r;
    }
    return null;
  }

  // Keep hidden dimensions hidden when the wall they belong to is moved as a whole.
  function remapHidden(dx, dy) {
    const keys = new Set(allDims().map(d => d.key));
    const remap = k => {
      if (keys.has(k)) return k;
      const prefix = k.startsWith('p:') ? 'p:' : '';
      const c = k.slice(prefix.length).split(',').map(Number);
      const moved = prefix + [c[0] + dx, c[1] + dy, c[2] + dx, c[3] + dy].join(',');
      return keys.has(moved) ? moved : k;
    };
    doc.hiddenDimensions = Array.from(new Set(doc.hiddenDimensions.map(remap)));
    doc.realDimensions = Object.fromEntries(Object.entries(doc.realDimensions).map(([k, v]) => [remap(k), v]));
  }

  // ---------- Rendering ----------

  const HANDLES = [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]];

  function handlePoints(r) {
    return HANDLES.map(([id, fx, fy]) => ({ id, p: S(r.x + r.w * fx, r.y + r.h * fy) }));
  }

  const poly = pts => 'M' + pts.map(p => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
  const line = (a, b, attrs) => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" ${attrs}/>`;

  function gridSvg(w, h) {
    let step = [snap, 100, 500, 1000, 5000, 10000].find(s => s >= snap && s * view.scale >= 8) || 50000;
    const major = step < 1000 ? 1000 : step * 10;
    const pattern = (id, size, color) => {
      const px = size * view.scale;
      return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${f(view.ox)}" y="${f(view.oy)}" width="${px}" height="${px}">` +
        `<path d="M0 0H${px}M0 0V${px}" stroke="${color}" stroke-width="1" fill="none"/></pattern>`;
    };
    return `<defs>${pattern('gMinor', step, '#eef0f3')}${pattern('gMajor', major, '#d9dde3')}</defs>` +
      `<rect width="${w}" height="${h}" fill="url(#gMinor)"/><rect width="${w}" height="${h}" fill="url(#gMajor)"/>`;
  }

  function openingSvg(o, opts) {
    const r = resolveOpening(o), { u, n } = axisVectors(o.axis);
    const P = (a, b) => S(r.cx + u[0] * a + n[0] * b, r.cy + u[1] * a + n[1] * b);
    const box = (a0, a1, b0, b1) => poly([P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)]);
    const W = openingWidth(o), t = r.t;
    const stroke = !r.ok ? BAD : opts.selected ? ACCENT : INK;
    const sw = opts.selected ? 2 : 1;
    let h = `<g opacity="${opts.ghost ? .6 : 1}">`;

    if (o.type === 'window') {
      const side = o.sillSide || 1;
      h += `<path d="${box(-o.sillSize / 2, o.sillSize / 2, side * t / 2, side * (t / 2 + o.sillDepth))}" fill="#fff" stroke="${stroke}" stroke-width="${sw}"/>`;
      h += `<path d="${box(-W / 2, W / 2, -t / 2, t / 2)}" fill="#fff" stroke="${stroke}" stroke-width="${sw}"/>`;
      for (const b of [-t / 6, t / 6]) h += line(P(-W / 2, b), P(W / 2, b), `stroke="${stroke}" stroke-width="1"`);
    } else {
      h += `<path d="${box(-W / 2, W / 2, -t / 2, t / 2)}" fill="#fff" stroke="${stroke}" stroke-width="${sw}"/>`;
      if (o.type === 'door') {
        const D = Math.min(o.doorSize, W), jamb = (W - D) / 2;
        if (jamb > 0) {
          h += `<path d="${box(-W / 2, -W / 2 + jamb, -t / 2, t / 2)}${box(W / 2 - jamb, W / 2, -t / 2, t / 2)}" fill="#9aa0a6" stroke="${stroke}" stroke-width="1"/>`;
        }
        // Leaf drawn open at 90° with its swing arc back to the closed position.
        const hingeA = o.hinge === 'start' ? -D / 2 : D / 2, dir = o.hinge === 'start' ? 1 : -1, s = o.swing || 1;
        const arc = [];
        for (let k = 0; k <= 20; k++) {
          const ang = k / 20 * Math.PI / 2;
          arc.push(P(hingeA + dir * D * Math.sin(ang), s * (t / 2 + D * Math.cos(ang))));
        }
        h += `<path d="M${arc.map(p => f(p[0]) + ' ' + f(p[1])).join('L')}" fill="none" stroke="${stroke}" stroke-width="1" stroke-dasharray="4 3"/>`;
        h += line(P(hingeA, s * t / 2), arc[0], `stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"`);
      }
    }

    // Size label inside the opening when there is room for it; styled like the dimensions.
    const label = fmt(o.type === 'door' ? Math.min(o.doorSize, W) : W);
    const st = doc.settings, textColor = stroke === INK ? st.dimFontColor : stroke;
    if (t * view.scale >= st.dimFontSize + 2 && W * view.scale >= label.length * st.dimFontSize * 0.64 + 8) {
      const [x, y] = P(0, 0);
      const rot = o.axis === 'v' ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : '';
      h += `<text x="${f(x)}" y="${f(y)}" style="font-family:${fontCss(st.dimFont)};font-size:${st.dimFontSize}px" text-anchor="middle" dominant-baseline="central" fill="${textColor}" stroke="#fff" stroke-width="3" paint-order="stroke"${rot}>${label}</text>`;
    }
    return h + '</g>';
  }

  // End marker of a dimension line at p; the line runs from p towards q.
  function dimEndSvg(p, q, color) {
    const kind = doc.settings.dimEnds;
    if (kind === 'none') return '';
    if (kind === 'dot') return `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="1.8" fill="${color}"/>`;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, dx = (q[0] - p[0]) / len, dy = (q[1] - p[1]) / len;
    if (kind === 'tick') {
      const tx = (dx - dy) * 3.5, ty = (dy + dx) * 3.5;
      return line([p[0] - tx, p[1] - ty], [p[0] + tx, p[1] + ty], `stroke="${color}" stroke-width="1.2"`);
    }
    if (kind === 'vNarrow' || kind === 'vWide') {
      // Open arrowhead: two strokes meeting at the tip.
      const reach = kind === 'vNarrow' ? 9 : 7, half = kind === 'vNarrow' ? 2.6 : 5;
      const cx = p[0] + dx * reach, cy = p[1] + dy * reach;
      const pts = [[cx - dy * half, cy + dx * half], p, [cx + dy * half, cy - dx * half]];
      return `<path d="M${pts.map(q => f(q[0]) + ' ' + f(q[1])).join('L')}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const bx = p[0] + dx * 8, by = p[1] + dy * 8;
    return `<path d="${poly([p, [bx - dy * 2.8, by + dx * 2.8], [bx + dy * 2.8, by - dx * 2.8]])}" fill="${color}"/>`;
  }

  function dimSvg(seg, selected) {
    const st = doc.settings, g = dimGeom(seg), sw = selected ? 1.8 : 1;
    const color = selected ? ACCENT : st.dimColor, textColor = selected ? ACCENT : st.dimFontColor;
    const ext = (x, y) => line([x + seg.nx * 3, y + seg.ny * 3], [x + seg.nx * (seg.off + 4), y + seg.ny * (seg.off + 4)], `stroke="${color}" stroke-width="0.8"`);
    const rot = g.vertical ? ` transform="rotate(-90 ${f(g.tx)} ${f(g.ty)})"` : '';
    return ext(g.ax, g.ay) + ext(g.bx, g.by) +
      line(g.a, g.b, `stroke="${color}" stroke-width="${sw}"`) +
      dimEndSvg(g.a, g.b, color) + dimEndSvg(g.b, g.a, color) +
      `<text x="${f(g.tx)}" y="${f(g.ty)}" style="font-family:${fontCss(st.dimFont)};font-size:${st.dimFontSize}px" text-anchor="middle" dominant-baseline="central" fill="${textColor}" stroke="#fff" stroke-width="3" paint-order="stroke"${selected ? ' font-weight="600"' : ''}${rot}>${g.text}</text>`;
  }

  function render() {
    const box = svg.getBoundingClientRect();
    const h = [gridSvg(box.width, box.height)];

    if (walls.loops.length) {
      const d = walls.loops.map(l => poly(l.points.map(p => S(p[0], p[1])))).join('');
      h.push(`<path d="${d}" fill="${doc.settings.wallColor}" fill-rule="evenodd"/>`);
    }

    for (const o of doc.openings) h.push(openingSvg(o, { selected: sel && sel.kind === 'opening' && sel.id === o.id }));
    for (const o of doc.objects) h.push(objectSvg(o, !!sel && sel.kind === 'object' && sel.id === o.id));
    for (const seg of visibleDims()) h.push(dimSvg(seg, !!sel && sel.kind === 'dim' && sel.key === seg.key));

    if (sel && sel.kind === 'edge') {
      const seg = walls.segments.find(s => s.key === sel.key);
      if (seg) h.push(line(S(seg.x1, seg.y1), S(seg.x2, seg.y2), `stroke="${ACCENT}" stroke-width="3" stroke-linecap="round"`));
    }
    if (sel && sel.kind === 'wall') {
      const r = doc.walls.find(w => w.id === sel.id);
      if (r) {
        const [x, y] = S(r.x, r.y);
        h.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(r.w * view.scale)}" height="${f(r.h * view.scale)}" fill="rgba(26,115,232,.18)" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
        for (const hp of handlePoints(r)) h.push(`<rect x="${f(hp.p[0] - 4)}" y="${f(hp.p[1] - 4)}" width="8" height="8" fill="#fff" stroke="${ACCENT}" stroke-width="1.5"/>`);
      }
    }

    if (drag && drag.kind === 'newobject') {
      const r = dragRect(drag);
      if (r.w > 0 && r.h > 0) h.push(objectSvg({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, rot: 0, name: '' }, false, true));
    }
    if (drag && drag.kind === 'newwall') {
      const r = dragRect(drag);
      const [x, y] = S(r.x, r.y);
      h.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(r.w * view.scale)}" height="${f(r.h * view.scale)}" fill="${doc.settings.wallColor}" fill-opacity=".55" stroke="${ACCENT}" stroke-width="1"/>`);
      h.push(`<text x="${f(x + r.w * view.scale / 2)}" y="${f(y - 10)}" text-anchor="middle" fill="${ACCENT}" stroke="#fff" stroke-width="3" paint-order="stroke" font-weight="600">${fmt(r.w)} × ${fmt(r.h)}</text>`);
    }
    if (previewDim) {
      const dim = allDims().find(d => d.key === previewDim);
      if (dim) h.push(dimSvg(dim, true));
    }
    if (ghost) h.push(openingSvg(ghost, { ghost: true }));

    svg.innerHTML = h.join('');
  }

  // ---------- Side panel ----------

  const field = (label, key, value) =>
    `<label class="field">${label}<input type="number" step="${UNITS[doc.units].step}" data-k="${key}" value="${fmt(value)}"><span>${doc.units}</span></label>`;

  function selectedObject() {
    if (!sel) return null;
    if (sel.kind === 'wall') return doc.walls.find(w => w.id === sel.id) || null;
    if (sel.kind === 'opening') return doc.openings.find(o => o.id === sel.id) || null;
    if (sel.kind === 'object') return doc.objects.find(o => o.id === sel.id) || null;
    if (sel.kind === 'dim') return allDims().find(d => d.key === sel.key) || null;
    return walls.segments.find(s => s.key === sel.key) || null;
  }

  function openingFields(type, o) {
    if (type === 'door') return field('Frame size', 'frameSize', o.frameSize) + field('Door size', 'doorSize', o.doorSize);
    if (type === 'doorway') return field('Opening size', 'frameSize', o.frameSize);
    return field('Window size', 'size', o.size) + field('Sill size', 'sillSize', o.sillSize) + field('Sill depth', 'sillDepth', o.sillDepth);
  }

  const TITLES = { door: 'Door', doorway: 'Doorway', window: 'Window' };

  function renderPanel() {
    const obj = selectedObject();
    if (sel && !obj) sel = null;
    if (sel || tool !== 'select') showSettings = false;
    let h;
    if (showSettings) {
      const st = doc.settings;
      const row = (label, control, unit) => `<label class="field">${label}${control}${unit === undefined ? '' : `<span>${unit}</span>`}</label>`;
      const colour = key => `<input type="color" data-set="${key}" value="${st[key]}">`;
      const number = (key, min, max) => `<input type="number" data-set="${key}" min="${min}" max="${max}" value="${st[key]}">`;
      const choice = (key, options) => `<select data-set="${key}">${options.map(([v, t]) => `<option value="${v}"${st[key] === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
      h = '<h3>Plan settings</h3><h4>Walls</h4>' + row('Colour', colour('wallColor'), '') +
        '<h4>Dimensions</h4>' +
        row('Line ends', choice('dimEnds', Object.entries(DIM_ENDS))) +
        row('Line colour', colour('dimColor'), '') +
        row('Font', choice('dimFont', fontChoices())) +
        row('Font size', number('dimFontSize', 6, 40), 'px') +
        row('Font colour', colour('dimFontColor'), '') +
        row('Distance from wall', number('dimDistance', 20, 500), '%') +
        '<h4>Objects</h4>' +
        row('Font', choice('objFont', fontChoices())) +
        row('Font size', number('objFontSize', 6, 40), 'px') +
        row('Font colour', colour('objFontColor'), '') +
        '<h4>Google Fonts</h4>' +
        '<div class="gfont-add"><input type="text" data-gfont placeholder="Font name, e.g. Roboto" autocomplete="off" spellcheck="false"><button data-act="addGoogleFont">Add</button></div>' +
        (st.googleFonts.length ? '<ul class="hidden-dims">' + st.googleFonts.map(n =>
          `<li><span style="font-family:${fontCss('g:' + n)}">${n}</span><button data-act="removeGoogleFont" data-font="${n}">Remove</button></li>`).join('') + '</ul>' : '') +
        '<p>Added fonts appear in the Font lists above. They are loaded from Google, so they need an internet connection.</p>' +
        '<p>Settings are saved with this plan. New plans start with the same settings.</p>' +
        '<div class="row"><button data-act="resetSettings">Reset to defaults</button><button data-act="closeSettings" class="primary">Done</button></div>';
    } else if (OPENING_TOOLS.includes(tool)) {
      h = `<h3>New ${TITLES[tool].toLowerCase()}</h3>${openingFields(tool, defaults[tool])}<p>Click on a wall to place it. The side of the wall you click on sets the ${tool === 'window' ? 'sill side' : 'opening direction'}.</p>`;
    } else if (tool === 'object') {
      h = '<h3>Object</h3><p>Drag to draw a rectangle, or click to drop a standard one. Use it for furniture, appliances and the like.</p><p>Objects do not attach to walls.</p>';
    } else if (tool === 'wall') {
      h = '<h3>Wall</h3><p>Drag to draw a rectangle. Rectangles that touch or overlap merge into one wall.</p><p>Hold Alt to draw without snapping.</p>';
    } else if (sel && sel.kind === 'object') {
      h = '<h3>Object</h3>' +
        `<label class="field">Name<input type="text" data-name value="${esc(obj.name)}" placeholder="e.g. Sofa"></label>` +
        field('Centre X', 'x', obj.x) + field('Centre Y', 'y', obj.y) + field('Width', 'w', obj.w) + field('Height', 'h', obj.h) +
        `<label class="field">Rotation<input type="number" step="15" data-rot value="${obj.rot}"><span>°</span></label>` +
        `<label class="note">Description<textarea data-desc rows="4" placeholder="Notes about this object; not shown on the plan">${esc(obj.description || '')}</textarea></label>` +
        '<div class="row"><button data-act="rotateLeft">⟲ 90°</button><button data-act="rotateRight">⟳ 90°</button></div>' +
        '<p>Drag to move, drag the squares to resize and the round handle to rotate (Alt for free angle).</p>' +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'wall') {
      h = '<h3>Wall rectangle</h3>' + field('X', 'x', obj.x) + field('Y', 'y', obj.y) + field('Width', 'w', obj.w) + field('Height', 'h', obj.h) +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'opening') {
      h = `<h3>${TITLES[obj.type]}</h3>` + openingFields(obj.type, obj);
      if (obj.type === 'door') h += '<div class="row"><button data-act="flipHinge">Flip hinge</button><button data-act="flipSwing">Flip direction</button></div>';
      if (obj.type === 'window') h += '<div class="row"><button data-act="flipSill">Flip sill side</button></div>';
      if (!resolveOpening(obj).ok) h += '<p class="err">Not inside a wall — drag it onto one.</p>';
      h += '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'dim') {
      const real = realOf(obj);
      h = `<h3>Dimension</h3><p>Drawn: ${fmt(obj.len)} ${doc.units}</p>` +
        `<label class="field">Real size<input type="number" min="0" step="${UNITS[doc.units].step}" data-real placeholder="—" value="${real ? fmt(real) : ''}"><span>${doc.units}</span></label>` +
        '<p>A real size is shown instead of the drawn one, marked with *. It does not change the plan.</p>' +
        `<div class="row">${real ? '<button data-act="clearReal">Clear real size</button>' : ''}<button data-act="hideDim">Hide dimension</button></div>` +
        '<p>To bring it back, click the wall line it measures.</p>';
    } else if (sel && sel.kind === 'edge') {
      const own = dimsOf(obj);
      const hiddenOnWall = allDims().filter(d => d.comp === obj.comp && isHidden(d.key)).length;
      h = `<h3>Wall line</h3><p>${fmt(obj.len)} ${doc.units}</p>` +
        `<label class="check"><input type="checkbox" data-act="toggleDim" ${own.some(d => !isHidden(d.key)) ? 'checked' : ''}> Show dimension${own.length > 1 ? 's' : ''}</label>` +
        `<div class="row"><button data-act="showWallDims" ${hiddenOnWall ? '' : 'disabled'}>Show all on this wall${hiddenOnWall ? ` (${hiddenOnWall})` : ''}</button>` +
        '<button data-act="hideWallDims">Hide all on this wall</button></div>';
    } else {
      const hidden = allDims().filter(d => isHidden(d.key));
      h = '<h3>Floorplan</h3><p>Click a wall, door, window or dimension to edit it. Drag to move.</p>' +
        '<p>Click a dimension and press Delete to hide it.</p>' +
        `<h3>Hidden dimensions${hidden.length ? ` (${hidden.length})` : ''}</h3>`;
      if (!hidden.length) h += '<p>None.</p>';
      else {
        h += '<ul class="hidden-dims">' + hidden.map(d =>
          `<li data-dim="${d.key}"><span>${d.nx ? '↕' : '↔'} ${dimText(d)} ${doc.units}</span><button data-act="showDim">Show</button></li>`).join('') +
          '</ul><p>Point at a row to see where it is on the plan.</p>';
      }
    }
    panel.innerHTML = h;
  }

  function applySetting(input) {
    const key = input.dataset.set;
    const value = input.type === 'number' ? Number(input.value) : input.value;
    doc.settings = cleanSettings(Object.assign({}, doc.settings, { [key]: value }));
  }
  // Live preview while a colour is being picked or a number typed; committed on change.
  panel.addEventListener('input', e => {
    if (!e.target.dataset.set) return;
    applySetting(e.target);
    render();
  });

  const normAngle = a => ((Math.round(a) % 360) + 360) % 360;

  panel.addEventListener('change', e => {
    if (sel && sel.kind === 'object' && ['name', 'rot', 'desc'].some(k => k in e.target.dataset)) {
      const o = selectedObject();
      if ('name' in e.target.dataset) o.name = e.target.value.trim();
      else if ('desc' in e.target.dataset) o.description = e.target.value.trim();
      else o.rot = normAngle(Number(e.target.value) || 0);
      return commit();
    }
    if (e.target.dataset.set) {
      applySetting(e.target);
      return commit();
    }
    if ('real' in e.target.dataset && sel && sel.kind === 'dim') {
      const mm = Math.round((Number(e.target.value) || 0) * UNITS[doc.units].factor);
      if (mm > 0) doc.realDimensions[sel.key] = mm; else delete doc.realDimensions[sel.key];
      return commit();
    }
    const k = e.target.dataset.k;
    if (!k) return;
    const toolMode = OPENING_TOOLS.includes(tool);
    const target = toolMode ? defaults[tool] : selectedObject();
    if (!target) return;
    let v = Math.round((Number(e.target.value) || 0) * UNITS[doc.units].factor);
    if (k !== 'x' && k !== 'y') v = Math.max(v, k === 'sillDepth' ? 0 : 10);
    target[k] = v;
    if (toolMode) {
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
      renderPanel();
    } else {
      commit();
    }
  });

  // Pointing at a row of the hidden-dimensions list previews that dimension on the plan.
  function setPreviewDim(key) {
    if (key === previewDim) return;
    previewDim = key;
    render();
  }
  panel.addEventListener('mouseover', e => {
    const row = e.target.closest('[data-dim]');
    setPreviewDim(row ? row.dataset.dim : null);
  });
  panel.addEventListener('mouseleave', () => setPreviewDim(null));

  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && 'gfont' in e.target.dataset) { e.preventDefault(); addGoogleFont(e.target.value); }
  });

  panel.addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act) return;
    const obj = selectedObject();
    if (act === 'addGoogleFont') return addGoogleFont(panel.querySelector('[data-gfont]').value);
    if (act === 'removeGoogleFont') {
      // cleanSettings puts any font that used the removed family back to the system font
      doc.settings = cleanSettings(Object.assign({}, doc.settings, { googleFonts: doc.settings.googleFonts.filter(n => n !== e.target.dataset.font) }));
      return commit();
    }
    if (act === 'delete') return deleteSelection();
    if (act === 'hideDim') return deleteSelection();
    if (act === 'flipHinge') obj.hinge = obj.hinge === 'start' ? 'end' : 'start';
    if (act === 'flipSwing') obj.swing = -(obj.swing || 1);
    if (act === 'flipSill') obj.sillSide = -(obj.sillSide || 1);
    if (act === 'toggleDim') setHidden(dimsOf(obj).map(d => d.key), !e.target.checked);
    if (act === 'showWallDims' || act === 'hideWallDims') {
      setHidden(allDims().filter(d => d.comp === obj.comp).map(d => d.key), act === 'hideWallDims');
    }
    if (act === 'rotateLeft') obj.rot = normAngle(obj.rot - 90);
    if (act === 'rotateRight') obj.rot = normAngle(obj.rot + 90);
    if (act === 'resetSettings') doc.settings = defaultSettings();
    if (act === 'closeSettings') showSettings = false;
    if (act === 'clearReal') delete doc.realDimensions[sel.key];
    if (act === 'showDim') {
      setHidden([e.target.closest('[data-dim]').dataset.dim], false);
      previewDim = null;
    }
    commit();
  });

  function deleteSelection() {
    if (!sel) return;
    if (sel.kind === 'wall') doc.walls = doc.walls.filter(w => w.id !== sel.id);
    else if (sel.kind === 'object') doc.objects = doc.objects.filter(o => o.id !== sel.id);
    else if (sel.kind === 'opening') doc.openings = doc.openings.filter(o => o.id !== sel.id);
    else if (sel.kind === 'dim') {
      const dim = selectedObject();
      setHidden([sel.key], true);
      sel = dim ? { kind: 'edge', key: dim.segKey } : null;
      return commit();
    }
    else return;
    sel = null;
    commit();
  }

  // ---------- Tools and pointer input ----------

  const HINTS = {
    select: 'Click to select · drag or arrow keys to move · drag empty space to pan · pinch or ⌘-scroll to zoom · Delete removes',
    wall: 'Drag to draw a wall rectangle · Alt disables snapping · Esc to finish',
    object: 'Drag to draw an object, or click to drop one · Esc to cancel',
    door: 'Click a wall to place a door · Esc to finish',
    doorway: 'Click a wall to place a doorway · Esc to finish',
    window: 'Click a wall to place a window · Esc to finish',
  };

  function setTool(t) {
    tool = t;
    ghost = null;
    drag = null;
    if (t !== 'select') sel = null;
    svg.setAttribute('class', 'tool-' + t);
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
    $('#hint').textContent = HINTS[t];
    renderAll();
  }

  function renderAll() {
    loadGoogleFonts();
    render();
    renderPanel();
    syncUnits();
    $('#btnUndo').disabled = hIndex <= 0;
    $('#btnRedo').disabled = hIndex >= history.length - 1;
  }

  function dragRect(d) {
    return { x: Math.min(d.a.x, d.b.x), y: Math.min(d.a.y, d.b.y), w: Math.abs(d.b.x - d.a.x), h: Math.abs(d.b.y - d.a.y) };
  }

  // Arrow keys: move the selected wall rectangle (with its openings), or slide an opening along its wall.
  function nudgeSelection(dx, dy) {
    const obj = selectedObject();
    if (!obj) return;
    if (sel.kind === 'wall') {
      const riders = doc.openings.filter(o => o.x >= obj.x && o.x <= obj.x + obj.w && o.y >= obj.y && o.y <= obj.y + obj.h);
      obj.x += dx; obj.y += dy;
      for (const o of riders) { o.x += dx; o.y += dy; }
      rebuild();
      remapHidden(dx, dy);
      commit();
    } else if (sel.kind === 'object') {
      obj.x += dx; obj.y += dy;
      commit();
    } else if (sel.kind === 'opening') {
      const x = obj.x + (obj.axis === 'h' ? dx : 0), y = obj.y + (obj.axis === 'v' ? dy : 0);
      if ((x === obj.x && y === obj.y) || !walls.extent(x, y)) return;   // stay inside the wall
      obj.x = x; obj.y = y;
      commit();
    }
  }

  function startMoveWall(rect, w0) {
    sel = { kind: 'wall', id: rect.id };
    const inside = o => o.x >= rect.x && o.x <= rect.x + rect.w && o.y >= rect.y && o.y <= rect.y + rect.h;
    drag = {
      kind: 'movewall', rect, w0, orig: { x: rect.x, y: rect.y }, dx: 0, dy: 0,
      openings: doc.openings.filter(inside).map(o => ({ o, x: o.x, y: o.y })),
    };
  }

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 1) return;
    svg.setPointerCapture(e.pointerId);
    const p = pointer(e), w = toWorld(p);

    if (e.button === 1 || spaceDown) {
      drag = { kind: 'pan', p, ox: view.ox, oy: view.oy };
      svg.classList.add('panning');
      return;
    }
    if (tool === 'wall') {
      const a = snapPoint(w, e);
      drag = { kind: 'newwall', a, b: a };
      return;
    }
    if (tool === 'object') {
      const a = { x: snapv(w.x, e), y: snapv(w.y, e) };
      drag = { kind: 'newobject', a, b: a };
      return;
    }
    if (OPENING_TOOLS.includes(tool)) {
      if (ghost) {
        const o = Object.assign({}, ghost, { id: doc.nextId++ });
        doc.openings.push(o);
        commit();
      }
      return;
    }

    // Select tool: handles, openings, dimensions, wall lines, wall rectangles, then empty space.
    if (sel && sel.kind === 'wall') {
      const rect = selectedObject();
      const hp = rect && handlePoints(rect).find(h => Math.abs(h.p[0] - p.x) <= 6 && Math.abs(h.p[1] - p.y) <= 6);
      if (hp) {
        drag = { kind: 'resize', rect, handle: hp.id, orig: Object.assign({}, rect) };
        return;
      }
    }
    if (sel && sel.kind === 'object') {
      const obj = selectedObject();
      const hp = obj && objectHandles(obj).find(h => Math.abs(h.p[0] - p.x) <= 7 && Math.abs(h.p[1] - p.y) <= 7);
      if (hp) {
        drag = hp.id === 'rot' ? { kind: 'rotateobject', o: obj } : { kind: 'resizeobject', o: obj, sx: hp.fx * 2 - 1, sy: hp.fy * 2 - 1, orig: Object.assign({}, obj) };
        return;
      }
    }
    const o = hitOpening(w);
    if (o) {
      sel = { kind: 'opening', id: o.id };
      drag = { kind: 'moveopening', o };
      return renderAll();
    }
    const dim = hitDim(p);
    if (dim) {
      sel = { kind: 'dim', key: dim.key };
      return renderAll();
    }
    const thing = hitObject(w);
    if (thing) {
      sel = { kind: 'object', id: thing.id };
      drag = { kind: 'moveobject', o: thing, w0: w, orig: { x: thing.x, y: thing.y } };
      return renderAll();
    }
    const edge = hitEdge(p);
    if (edge) {
      sel = { kind: 'edge', key: edge.key };
      drag = { kind: 'pending', p, w0: w, rect: hitRect(w, 5) };
      return renderAll();
    }
    const rect = hitRect(w);
    if (rect) {
      startMoveWall(rect, w);
      return renderAll();
    }
    sel = null;
    drag = { kind: 'pan', p, ox: view.ox, oy: view.oy };
    renderAll();
  });

  svg.addEventListener('pointermove', e => {
    const p = pointer(e), w = toWorld(p);
    $('#coords').textContent = `x ${fmt(w.x)}  y ${fmt(w.y)} ${doc.units}`;

    if (!drag) {
      if (OPENING_TOOLS.includes(tool)) {
        const loc = locate(w, openingWidth(defaults[tool]), e);
        ghost = loc ? makeOpening(tool, loc) : null;
        render();
      }
      return;
    }
    if (drag.kind === 'pan') {
      view.ox = drag.ox + p.x - drag.p.x;
      view.oy = drag.oy + p.y - drag.p.y;
    } else if (drag.kind === 'newwall') {
      drag.b = snapPoint(w, e);
    } else if (drag.kind === 'newobject') {
      drag.b = { x: snapv(w.x, e), y: snapv(w.y, e) };
    } else if (drag.kind === 'moveobject') {
      drag.o.x = drag.orig.x + snapv(w.x - drag.w0.x, e);
      drag.o.y = drag.orig.y + snapv(w.y - drag.w0.y, e);
    } else if (drag.kind === 'rotateobject') {
      const step = e.altKey ? 1 : 15;
      const ang = Math.atan2(w.y - drag.o.y, w.x - drag.o.x) * 180 / Math.PI + 90;
      drag.o.rot = normAngle(Math.round(ang / step) * step);
    } else if (drag.kind === 'resizeobject') {
      // The side opposite the dragged handle stays where it is, in the object's own rotated frame.
      const o0 = drag.orig, l = objToLocal(o0, w);
      let nw = o0.w, nh = o0.h, lcx = 0, lcy = 0;
      if (drag.sx) {
        const ax = -drag.sx * o0.w / 2;
        nw = Math.max(10, snapv(drag.sx * (l.x - ax), e));
        lcx = ax + drag.sx * nw / 2;
      }
      if (drag.sy) {
        const ay = -drag.sy * o0.h / 2;
        nh = Math.max(10, snapv(drag.sy * (l.y - ay), e));
        lcy = ay + drag.sy * nh / 2;
      }
      const c = objToWorld(o0, lcx, lcy);
      Object.assign(drag.o, { x: Math.round(c[0]), y: Math.round(c[1]), w: nw, h: nh });
    } else if (drag.kind === 'pending') {
      if (Math.hypot(p.x - drag.p.x, p.y - drag.p.y) < 4 || !drag.rect) return;
      startMoveWall(drag.rect, drag.w0);
      renderPanel();
    }
    if (drag.kind === 'movewall') {
      drag.dx = snapv(w.x - drag.w0.x, e);
      drag.dy = snapv(w.y - drag.w0.y, e);
      drag.rect.x = drag.orig.x + drag.dx;
      drag.rect.y = drag.orig.y + drag.dy;
      for (const m of drag.openings) { m.o.x = m.x + drag.dx; m.o.y = m.y + drag.dy; }
      rebuild();
    } else if (drag.kind === 'resize') {
      const s = snapPoint(w, e), r = drag.rect, o = drag.orig, hnd = drag.handle;
      let x0 = o.x, x1 = o.x + o.w, y0 = o.y, y1 = o.y + o.h;
      if (hnd.includes('w')) x0 = Math.min(s.x, x1 - 10);
      if (hnd.includes('e')) x1 = Math.max(s.x, x0 + 10);
      if (hnd.includes('n')) y0 = Math.min(s.y, y1 - 10);
      if (hnd.includes('s')) y1 = Math.max(s.y, y0 + 10);
      r.x = x0; r.y = y0; r.w = x1 - x0; r.h = y1 - y0;
      rebuild();
    } else if (drag.kind === 'moveopening') {
      const loc = locate(w, openingWidth(drag.o), e);
      if (loc) { drag.o.x = loc.x; drag.o.y = loc.y; drag.o.axis = loc.axis; }
    }
    render();
  });

  function endDrag() {
    const d = drag;
    drag = null;
    svg.classList.remove('panning');
    if (!d) return;
    if (d.kind === 'newobject') {
      let r = dragRect(d);
      if (!r.w || !r.h) r = { x: d.a.x - 500, y: d.a.y - 300, w: 1000, h: 600 };   // plain click: standard size
      const o = { id: doc.nextId++, name: '', description: '', x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, rot: 0 };
      doc.objects.push(o);
      setTool('select');
      sel = { kind: 'object', id: o.id };
      return commit();
    }
    if (d.kind === 'newwall') {
      const r = dragRect(d);
      if (r.w > 0 && r.h > 0) doc.walls.push(Object.assign({ id: doc.nextId++ }, r));
      return commit();
    }
    if (d.kind === 'movewall') {
      if (d.dx || d.dy) remapHidden(d.dx, d.dy);
      return commit();
    }
    if (['resize', 'moveopening', 'moveobject', 'resizeobject', 'rotateobject'].includes(d.kind)) return commit();
    render();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (ghost) { ghost = null; render(); } });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = pointer(e);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
    } else {
      view.ox -= e.deltaX;
      view.oy -= e.deltaY;
      render();
    }
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory(1); return; }
    if (mod) return;
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (tool !== 'select') setTool('select');
      else { sel = null; renderAll(); }
      return;
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow) {
      if (sel && ['wall', 'opening', 'object'].includes(sel.kind)) { e.preventDefault(); nudgeSelection(arrow[0] * snap, arrow[1] * snap); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    const t = { v: 'select', w: 'wall', d: 'door', o: 'doorway', n: 'window', b: 'object' }[e.key.toLowerCase()];
    if (t) setTool(t);
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

  $('#tools').addEventListener('click', e => {
    const b = e.target.closest('button[data-tool]');
    if (b) setTool(b.dataset.tool);
  });
  $('#btnSettings').onclick = () => {
    const open = !showSettings;
    sel = null;
    if (tool !== 'select') setTool('select');
    showSettings = open;
    renderAll();
  };
  $('#btnUndo').onclick = () => stepHistory(-1);
  $('#btnRedo').onclick = () => stepHistory(1);
  $('#snapSelect').onchange = e => { snap = +e.target.value; render(); };
  $('#unitSelect').onchange = e => { doc.units = e.target.value; commit(); };

  // Keeps the unit selector and the snap labels in step with the plan's unit.
  let shownUnit = null;
  function syncUnits() {
    if (shownUnit === doc.units) return;
    shownUnit = doc.units;
    $('#unitSelect').value = doc.units;
    $('#snapSelect').innerHTML = SNAPS.map(v => `<option value="${v}">${fmt(v)} ${doc.units}</option>`).join('');
    $('#snapSelect').value = snap;
  }
  const zoomCentre = factor => { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, factor); };
  $('#btnZoomIn').onclick = () => zoomCentre(1.25);
  $('#btnZoomOut').onclick = () => zoomCentre(0.8);
  $('#btnFit').onclick = () => { fitView(); render(); };
  new ResizeObserver(render).observe($('#stage'));

  // ---------- Storage: JSON files in a user-selected folder (File System Access API) ----------

  let dir = null, fileName = null;
  let saveTimer = null, saveChain = Promise.resolve(), dirty = false;

  function setStatus(text, cls) {
    const el = $('#saveStatus');
    el.textContent = text;
    el.className = cls || '';
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function openDb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('floorplan-app', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbGet(key) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function dbSet(key, value) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  function scheduleSave() {
    dirty = true;
    if (!dir || !fileName) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
      setStatus('Not saved to disk — open a folder', 'warn');
      return;
    }
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 300);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!dir || !fileName || !dirty) return saveChain;
    dirty = false;
    const name = fileName, text = JSON.stringify(doc, null, 2) + '\n', folder = dir;
    saveChain = saveChain.then(async () => {
      const fh = await folder.getFileHandle(name, { create: true });
      const out = await fh.createWritable();
      await out.write(text);
      await out.close();
      setStatus(`Saved · ${folder.name}/${name}`, 'ok');
    }).catch(err => {
      dirty = true;
      setStatus('Save failed: ' + err.message, 'err');
    });
    return saveChain;
  }

  async function listPlans() {
    const names = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.json') && !entry.name.startsWith('.')) names.push(entry.name);
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  async function readPlan(name) {
    const file = await (await dir.getFileHandle(name)).getFile();
    return normalizeDoc(JSON.parse(await file.text()));
  }

  function fillPlanSelect(names) {
    const select = $('#planSelect');
    select.textContent = '';
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = n;
      select.appendChild(opt);
    }
    select.value = fileName || '';
    select.disabled = !dir;
  }

  function uniqueName(base, names) {
    let name = base + '.json';
    for (let i = 2; names.includes(name); i++) name = `${base}-${i}.json`;
    return name;
  }

  async function saveAsNewFile(name) {
    fileName = name;
    localStorage.setItem(LAST_FILE_KEY, name);
    dirty = true;
    await flushSave();
    localStorage.removeItem(DRAFT_KEY);
    fillPlanSelect(await listPlans());
  }

  // Called once a folder is connected: keep an unsaved drawing, otherwise open a plan from the folder.
  async function connectFolder(handle) {
    dir = handle;
    fileName = null;
    $('#btnFolder').textContent = '📁 ' + dir.name;
    const names = await listPlans();
    if (!isEmpty()) return saveAsNewFile(uniqueName('floorplan', names));

    const last = localStorage.getItem(LAST_FILE_KEY);
    const order = names.includes(last) ? [last].concat(names.filter(n => n !== last)) : names;
    for (const name of order) {
      try {
        const loaded = await readPlan(name);
        fileName = name;
        setDoc(loaded);
        localStorage.setItem(LAST_FILE_KEY, name);
        fillPlanSelect(names);
        setStatus(`Opened · ${dir.name}/${name}`, 'ok');
        return;
      } catch (err) { /* not a floorplan file, try the next one */ }
    }
    await saveAsNewFile(uniqueName('floorplan', names));
  }

  $('#btnFolder').onclick = async () => {
    if (!window.showDirectoryPicker) return toast('This browser cannot open folders. Use Google Chrome.');
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'floorplan', mode: 'readwrite' });
    } catch (err) { return; }   // picker cancelled
    try {
      await flushSave();
      await connectFolder(handle);
      await dbSet('dir', handle);
    } catch (err) {
      setStatus('Folder error: ' + err.message, 'err');
    }
  };

  $('#planSelect').onchange = async e => {
    const name = e.target.value;
    await flushSave();
    try {
      const loaded = await readPlan(name);
      fileName = name;
      localStorage.setItem(LAST_FILE_KEY, name);
      setDoc(loaded);
      setStatus(`Opened · ${dir.name}/${name}`, 'ok');
    } catch (err) {
      e.target.value = fileName || '';
      toast(`${name} could not be opened: ${err.message}`);
    }
  };

  $('#btnNew').onclick = () => {
    if (!dir) {
      // No folder yet: just start over; the previous drawing stays reachable through Undo.
      doc = freshDoc();
      sel = null;
      return commit();
    }
    $('#newErr').textContent = '';
    $('#newDlg').showModal();
    $('#newName').select();
  };

  $('#newOk').onclick = async e => {
    e.preventDefault();
    const base = $('#newName').value.trim().replace(/\.json$/i, '').replace(/[\\/:*?"<>|]/g, '-');
    if (!base) { $('#newErr').textContent = 'Enter a file name.'; return; }
    try {
      const names = await listPlans();
      if (names.includes(base + '.json')) { $('#newErr').textContent = 'A file with this name already exists.'; return; }
      await flushSave();
      $('#newDlg').close();
      setDoc(freshDoc());
      await saveAsNewFile(base + '.json');
    } catch (err) {
      $('#newErr').textContent = err.message;
    }
  };

  window.addEventListener('beforeunload', () => { flushSave(); });

  async function restoreFolder() {
    let handle;
    try { handle = await dbGet('dir'); } catch (err) { return; }
    if (!handle) return;
    const opts = { mode: 'readwrite' };
    if (await handle.queryPermission(opts) === 'granted') return connectFolder(handle);
    // Chrome needs a click before it re-grants access to a remembered folder.
    const btn = $('#btnFolder');
    const original = btn.onclick;
    btn.textContent = `Reconnect “${handle.name}”`;
    btn.onclick = async () => {
      btn.onclick = original;
      try {
        if (await handle.requestPermission(opts) === 'granted') return await connectFolder(handle);
      } catch (err) { /* fall through to the folder picker */ }
      btn.textContent = 'Open folder…';
      original();
    };
  }

  // ---------- Calculator ----------

  // Evaluates + − × ÷ with brackets; returns NaN for anything it cannot read.
  function calculate(text) {
    const src = text.replace(/\s+/g, '').replace(/,/g, '.').replace(/[×x]/g, '*').replace(/[÷:]/g, '/').replace(/−/g, '-');
    let i = 0;
    const expr = () => {
      let v = term();
      while (src[i] === '+' || src[i] === '-') v = src[i++] === '+' ? v + term() : v - term();
      return v;
    };
    const term = () => {
      let v = factor();
      while (src[i] === '*' || src[i] === '/') v = src[i++] === '*' ? v * factor() : v / factor();
      return v;
    };
    const factor = () => {
      if (src[i] === '-') { i++; return -factor(); }
      if (src[i] === '+') { i++; return factor(); }
      if (src[i] === '(') {
        i++;
        const v = expr();
        if (src[i] === ')') i++;      // a missing closing bracket is forgiven while typing
        else if (i < src.length) return NaN;
        return v;
      }
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) return NaN;
      i += m[0].length;
      return Number(m[0]);
    };
    if (!src) return NaN;
    const v = expr();
    return i === src.length ? v : NaN;
  }

  (function () {
    const input = $('#calcInput'), result = $('#calcResult');
    const show = v => String(Number(v.toFixed(6)));
    function update() {
      const v = calculate(input.value);
      const ok = Number.isFinite(v);
      result.textContent = ok ? '= ' + show(v) : (input.value.trim() ? '…' : '\u00a0');
      result.className = ok ? '' : 'err';
      return ok ? v : null;
    }
    function equals() {
      const v = update();
      if (v !== null) { input.value = show(v); update(); }
    }
    input.addEventListener('input', update);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); equals(); }
      if (e.key === 'Escape') { input.value = ''; update(); }
    });
    $('#calcKeys').addEventListener('click', e => {
      const c = e.target.dataset.c;
      if (!c) return;
      if (c === 'clear') input.value = '';
      else if (c === 'back') input.value = input.value.slice(0, -1);
      else if (c === 'equals') return equals();
      else input.value += c;
      update();
    });
  })();

  // ---------- Start ----------

  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) doc = normalizeDoc(JSON.parse(draft));
  } catch (err) { doc = newDoc(); }
  rebuild();
  resetHistory();
  fitView();
  setTool('select');
  setStatus(isEmpty() ? 'Open a folder to save plans as JSON' : 'Draft restored — open a folder to save it', 'warn');
  restoreFolder().catch(err => setStatus('Folder error: ' + err.message, 'err'));
})();
