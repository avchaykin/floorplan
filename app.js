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

  const BAD = '#c62828';
  let INK, ACCENT, PAPER, JAMB;   // canvas colours of the active mode, set by setPalette()

  // Light and dark palettes: `ui` colours go to CSS variables, `canvas` colours to the drawing.
  // wall/dim/dimText/objText/objFill/objBorder are used for plan colours that are left on automatic.
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const PALETTES = {
    light: {
      ui: { bg: '#f3f4f6', surface: '#ffffff', border: '#d5d8dd', text: '#1f2328', muted: '#6b7280', accent: '#1a73e8', 'on-accent': '#ffffff', hover: '#eef1f5', active: '#e3eefd', off: '#b6bcc5', warn: '#b45309', err: '#c62828', ok: '#2e7d32', font: SANS },
      canvas: { paper: '#ffffff', gridMinor: '#eef0f3', gridMajor: '#d9dde3', ink: '#2b2b2b', accent: '#1a73e8', jamb: '#9aa0a6', wall: '#4d4d4d', dim: '#5f6b7a', dimText: '#5f6b7a', objText: '#5f6b7a', objFill: '#ffffff', objBorder: '#2b2b2b' },
    },
    dark: {
      ui: { bg: '#16181c', surface: '#1f2227', border: '#363b44', text: '#e6e8eb', muted: '#9aa3af', accent: '#5aa2ff', 'on-accent': '#0b1220', hover: '#2a2e35', active: '#253a5a', off: '#5b626d', warn: '#f0a35a', err: '#ff7b72', ok: '#6fcf7c', font: SANS },
      canvas: { paper: '#1b1d21', gridMinor: '#23262b', gridMajor: '#30343b', ink: '#d7dae0', accent: '#5aa2ff', jamb: '#6b7280', wall: '#b9bec7', dim: '#9aa3af', dimText: '#c3c9d2', objText: '#c3c9d2', objFill: '#262a30', objBorder: '#d7dae0' },
    },
  };
  const THEME_COLOURS = { wallColor: 'wall', dimColor: 'dim', dimFontColor: 'dimText', objFontColor: 'objText', objFillColor: 'objFill', objBorderColor: 'objBorder', titleFontColor: 'ink' };

  // Light/dark mode is a preference of this browser, not part of the plan.
  const appearance = { mode: 'system' };
  try {
    const saved = JSON.parse(localStorage.getItem('floorplan-appearance') || '{}');
    if (['system', 'light', 'dark'].includes(saved.mode)) appearance.mode = saved.mode;
  } catch (e) { /* keep defaults */ }
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const currentMode = () => appearance.mode === 'system' ? (systemDark.matches ? 'dark' : 'light') : appearance.mode;

  let pal, palMode;
  function setPalette(canvasColours, mode) {
    pal = canvasColours;
    palMode = mode;
    INK = pal.ink; ACCENT = pal.accent; PAPER = pal.paper; JAMB = pal.jamb;
  }
  function applyAppearance() {
    const mode = currentMode(), variant = PALETTES[mode], root = document.documentElement;
    for (const [k, v] of Object.entries(variant.ui)) root.style.setProperty('--' + k, v);
    root.style.setProperty('--paper', variant.canvas.paper);
    root.style.colorScheme = mode;   // native controls (scrollbars, selects, colour pickers) follow
    setPalette(variant.canvas, mode);
  }
  applyAppearance();
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

  const FILLS = { solid: 'Solid', diagLeft: 'Diagonal left ╲', diagRight: 'Diagonal right ╱', cross: 'Cross-hatch' };
  const isColour = v => /^#[0-9a-f]{6}$/i.test(v);
  // Inline icon paths: Material Design Icons (pictogrammers.com), Apache License 2.0.
  const ICONS = {
    eye: 'M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9M12,4.5C17,4.5 21.27,7.61 23,12C21.27,16.39 17,19.5 12,19.5C7,19.5 2.73,16.39 1,12C2.73,7.61 7,4.5 12,4.5M3.18,12C4.83,15.36 8.24,17.5 12,17.5C15.76,17.5 19.17,15.36 20.82,12C19.17,8.64 15.76,6.5 12,6.5C8.24,6.5 4.83,8.64 3.18,12Z',
    eyeOff: 'M2,5.27L3.28,4L20,20.72L18.73,22L15.65,18.92C14.5,19.3 13.28,19.5 12,19.5C7,19.5 2.73,16.39 1,12C1.69,10.24 2.79,8.69 4.19,7.46L2,5.27M12,9A3,3 0 0,1 15,12C15,12.35 14.94,12.69 14.83,13L11,9.17C11.31,9.06 11.65,9 12,9M12,4.5C17,4.5 21.27,7.61 23,12C22.18,14.08 20.79,15.88 19,17.19L17.58,15.76C18.94,14.82 20.06,13.54 20.82,12C19.17,8.64 15.76,6.5 12,6.5C10.91,6.5 9.84,6.68 8.84,7L7.3,5.47C8.74,4.85 10.33,4.5 12,4.5M3.18,12C4.83,15.36 8.24,17.5 12,17.5C12.69,17.5 13.37,17.43 14,17.29L11.72,15C10.29,14.85 9.15,13.71 9,12.28L5.6,8.87C4.61,9.72 3.78,10.78 3.18,12Z',
    lock: 'M12,17C10.89,17 10,16.1 10,15C10,13.89 10.89,13 12,13A2,2 0 0,1 14,15A2,2 0 0,1 12,17M18,20V10H6V20H18M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V10C4,8.89 4.89,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z',
    lockOpen: 'M10 13C11.1 13 12 13.89 12 15C12 16.11 11.11 17 10 17S8 16.11 8 15 8.9 13 10 13M18 1C15.24 1 13 3.24 13 6V8H4C2.9 8 2 8.9 2 10V20C2 21.1 2.9 22 4 22H16C17.1 22 18 21.1 18 20V10C18 8.9 17.1 8 16 8H15V6C15 4.34 16.34 3 18 3S21 4.34 21 6V8H23V6C23 3.24 20.76 1 18 1M16 10V20H4V10H16Z',
    up: 'M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z',
    down: 'M11,4H13V16L18.5,10.5L19.92,11.92L12,19.84L4.08,11.92L5.5,10.5L11,16V4Z',
    plus: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
    remove: 'M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z',
    cog: 'M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10M10,22C9.75,22 9.54,21.82 9.5,21.58L9.13,18.93C8.5,18.68 7.96,18.34 7.44,17.94L4.95,18.95C4.73,19.03 4.46,18.95 4.34,18.73L2.34,15.27C2.21,15.05 2.27,14.78 2.46,14.63L4.57,12.97L4.5,12L4.57,11L2.46,9.37C2.27,9.22 2.21,8.95 2.34,8.73L4.34,5.27C4.46,5.05 4.73,4.96 4.95,5.05L7.44,6.05C7.96,5.66 8.5,5.32 9.13,5.07L9.5,2.42C9.54,2.18 9.75,2 10,2H14C14.25,2 14.46,2.18 14.5,2.42L14.87,5.07C15.5,5.32 16.04,5.66 16.56,6.05L19.05,5.05C19.27,4.96 19.54,5.05 19.66,5.27L21.66,8.73C21.79,8.95 21.73,9.22 21.54,9.37L19.43,11L19.5,12L19.43,13L21.54,14.63C21.73,14.78 21.79,15.05 21.66,15.27L19.66,18.73C19.54,18.95 19.27,19.04 19.05,18.95L16.56,17.95C16.04,18.34 15.5,18.68 14.87,18.93L14.5,21.58C14.46,21.82 14.25,22 14,22H10M11.25,4L10.88,6.61C9.68,6.86 8.62,7.5 7.85,8.39L5.44,7.35L4.69,8.65L6.8,10.2C6.4,11.37 6.4,12.64 6.8,13.8L4.68,15.36L5.43,16.66L7.86,15.62C8.63,16.5 9.68,17.14 10.87,17.38L11.24,20H12.76L13.13,17.39C14.32,17.14 15.37,16.5 16.14,15.62L18.57,16.66L19.32,15.36L17.2,13.81C17.6,12.64 17.6,11.37 17.2,10.2L19.31,8.65L18.56,7.35L16.15,8.39C15.38,7.5 14.32,6.86 13.12,6.62L12.75,4H11.25Z',
  };
  const icon = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

  // Per-object dimensions: its own side length, the gap to the nearest other object, the gap to the nearest wall.
  const MEASURE_TYPES = ['size', 'object', 'wall'];

  // Object settings a layer may override; everything else is plan-wide.
  const OBJ_SETTING_KEYS = ['objFont', 'objFontSize', 'objFontColor', 'objFillStyle', 'objFillColor', 'objHatchSpacing', 'objBorderSize', 'objBorderColor'];

  // Title settings can be overridden on every layer, special ones included.
  const TITLE_SETTING_KEYS = ['titleFont', 'titleFontSize', 'titleFontColor'];

  // Layers are stored bottom to top. Walls (with doors and windows) and dimensions each have one fixed layer.
  function defaultLayers() {
    return [
      { id: 'walls', kind: 'walls', name: 'Walls', visible: true, frozen: false, settings: {} },
      { id: 'objects', kind: 'objects', name: 'Objects', visible: true, frozen: false, settings: {} },
      { id: 'dimensions', kind: 'dimensions', name: 'Dimensions', visible: true, frozen: false, settings: {} },
    ];
  }

  function cleanLayers(raw, settings) {
    const out = [], seen = new Set();
    for (const l of Array.isArray(raw) ? raw : []) {
      if (!l || !['walls', 'dimensions', 'objects'].includes(l.kind)) continue;
      const id = l.kind === 'objects' ? String(l.id || '') : l.kind;
      if (!id || seen.has(id) || (l.kind === 'objects' && (id === 'walls' || id === 'dimensions'))) continue;
      seen.add(id);
      const layer = { id, kind: l.kind, name: { walls: 'Walls', dimensions: 'Dimensions' }[l.kind], visible: l.visible !== false, frozen: l.frozen === true };
      if (l.kind === 'objects') layer.name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : 'Layer';
      layer.settings = {};
      const given = l.settings && typeof l.settings === 'object' ? l.settings : {};
      const merged = cleanSettings(Object.assign({}, settings, given));
      const allowed = l.kind === 'objects' ? OBJ_SETTING_KEYS.concat(TITLE_SETTING_KEYS) : TITLE_SETTING_KEYS;
      for (const k of allowed) if (k in given) layer.settings[k] = merged[k];
      for (const k of COLOUR_KEYS) if (k in layer.settings && !pairSet(layer.settings[k])) delete layer.settings[k];
      out.push(layer);
    }
    const defs = defaultLayers();
    if (!out.some(l => l.kind === 'walls')) out.unshift(defs[0]);
    if (!out.some(l => l.kind === 'objects')) out.splice(out.findIndex(l => l.kind === 'walls') + 1, 0, defs[1]);
    if (!out.some(l => l.kind === 'dimensions')) out.push(defs[2]);
    return out;
  }

  const DIM_ENDS = { arrow: 'Arrows, filled', vNarrow: 'V-arrows, narrow', vWide: 'V-arrows, wide', tick: 'Ticks', dot: 'Dots', none: 'None' };

  // Appearance settings, stored with each plan.
  function defaultSettings() {
    const out = { titleFont: 'system', titleFontSize: 18, wallColor: '#4d4d4d', dimEnds: 'dot', dimColor: '#5f6b7a', dimFont: 'system', dimFontSize: 11, dimFontColor: '#5f6b7a', dimDistance: 100, objFont: 'system', objFontSize: 11, objFontColor: '#5f6b7a', googleFonts: [], objFillStyle: 'solid', objFillColor: '#ffffff', objBorderSize: 1.2, objBorderColor: '#2b2b2b', objHatchSpacing: 8 };
    for (const k of Object.keys(THEME_COLOURS)) out[k] = { light: null, dark: null };   // colours: automatic, i.e. from the theme
    return out;
  }

  // Every colour is a pair { light, dark }: one value per mode, null meaning "automatic".
  // An automatic side mirrors the other side if that one is set; with both automatic the theme decides.
  const COLOUR_KEYS = Object.keys(THEME_COLOURS);
  const OLD_DEFAULT_COLOURS = { wallColor: '#4d4d4d', dimColor: '#5f6b7a', dimFontColor: '#5f6b7a', objFontColor: '#5f6b7a', objFillColor: '#ffffff', objBorderColor: '#2b2b2b' };
  const autoPair = () => ({ light: null, dark: null });
  const pairSet = p => !!p && !!(p.light || p.dark);

  // Accepts a pair or a single colour from older plans (taken as the light-mode value).
  function toPair(v, oldDefault) {
    if (typeof v === 'string') return isColour(v) && v.toLowerCase() !== oldDefault ? { light: v.toLowerCase(), dark: null } : autoPair();
    if (!v || typeof v !== 'object') return autoPair();
    return { light: isColour(v.light) ? v.light.toLowerCase() : null, dark: isColour(v.dark) ? v.dark.toLowerCase() : null };
  }

  // The same hue with its lightness flipped, kept slightly off pure black and white.
  function oppositeColour(hex) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let hue = 0, sat = 0;
    if (d) {
      sat = d / (1 - Math.abs(2 * l - 1));
      hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue = ((hue % 6) + 6) % 6;
    }
    const l2 = 0.1 + 0.85 * (1 - l), c = (1 - Math.abs(2 * l2 - 1)) * sat, x = c * (1 - Math.abs(hue % 2 - 1)), m = l2 - c / 2;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue) % 6];
    return '#' + rgb.map(v => Math.round(Math.min(Math.max(v + m, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
  }

  const paletteFor = mode => mode === palMode ? pal : PALETTES[mode].canvas;
  // Colour for one mode from a list of pairs, most specific first; falls back to the theme.
  function colourFrom(pairs, slot, mode) {
    for (const p of pairs) {
      if (!p) continue;
      if (p[mode]) return p[mode];
      const other = p[mode === 'light' ? 'dark' : 'light'];
      if (other) return oppositeColour(other);
    }
    return paletteFor(mode)[slot];
  }
  // Plan settings with every colour resolved to a plain value for the mode being drawn.
  function planStyle() {
    const out = Object.assign({}, doc.settings);
    for (const k of COLOUR_KEYS) out[k] = colourFrom([doc.settings[k]], THEME_COLOURS[k], palMode);
    return out;
  }

  function cleanSettings(raw) {
    const out = defaultSettings(), src = raw || {};
    for (const k of COLOUR_KEYS) out[k] = toPair(src[k], OLD_DEFAULT_COLOURS[k]);
    if (Number.isFinite(src.objBorderSize)) out.objBorderSize = Math.min(Math.max(Math.round(src.objBorderSize * 10) / 10, 0), 10);
    if (Number.isFinite(src.objHatchSpacing)) out.objHatchSpacing = Math.min(Math.max(Math.round(src.objHatchSpacing), 3), 60);
    if (FILLS[src.objFillStyle]) out.objFillStyle = src.objFillStyle;
    if (DIM_ENDS[src.dimEnds]) out.dimEnds = src.dimEnds;
    if (Array.isArray(src.googleFonts)) out.googleFonts = Array.from(new Set(src.googleFonts.filter(n => typeof n === 'string' && GOOGLE_FONT_NAME.test(n))));
    const knownFont = k => !!FONTS[k] || (typeof k === 'string' && k.startsWith('g:') && out.googleFonts.includes(k.slice(2)));
    for (const k of ['dimFont', 'objFont', 'titleFont']) if (knownFont(src[k])) out[k] = src[k];
    if (Number.isFinite(src.titleFontSize)) out.titleFontSize = Math.min(Math.max(Math.round(src.titleFontSize), 6), 200);
    for (const k of ['dimFontSize', 'objFontSize']) if (Number.isFinite(src[k])) out[k] = Math.min(Math.max(Math.round(src[k]), 6), 40);
    if (Number.isFinite(src.dimDistance)) out.dimDistance = Math.min(Math.max(Math.round(src.dimDistance), 20), 500);
    return out;
  }
  const ORPHAN_THICKNESS = 150;   // mm, used when an opening is no longer inside a wall
  const OPENING_TOOLS = ['door', 'doorway', 'window'];
  // Geometry is always stored in mm; the unit only changes how lengths are shown and typed.
  const UNITS = { mm: { factor: 1, digits: 0, step: 10 }, cm: { factor: 10, digits: 1, step: 1 }, m: { factor: 1000, digits: 3, step: 0.01 } };
  const SNAPS = [1, 5, 10, 50, 100];
  // Written into every saved plan so a file can be traced back to the app that produced it.
  // `commit` is the commit this version was built on: a file cannot contain its own hash, so bump both when releasing.
  const APP = { name: 'Floorplan', version: '1.0.1', commit: '6a52e67', repository: 'https://github.com/avchaykin/floorplan' };
  const DRAFT_KEY = 'floorplan-draft', DEFAULTS_KEY = 'floorplan-defaults', LAST_FILE_KEY = 'floorplan-last-file';

  // ---------- Document ----------

  function newDoc() {
    return { format: 'floorplan', version: 1, units: 'mm', nextId: 1, walls: [], openings: [], objects: [], marks: [], titles: [], compasses: [], hiddenDimensions: [], realDimensions: {}, descriptions: {}, settings: defaultSettings(), layers: defaultLayers() };
  }

  function normalizeDoc(d) {
    if (!d || d.format !== 'floorplan' || !Array.isArray(d.walls)) throw new Error('not a floorplan file');
    const out = newDoc();
    if (UNITS[d.units]) out.units = d.units;
    out.settings = cleanSettings(d.settings);
    out.walls = d.walls.filter(r => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
    out.openings = (d.openings || []).filter(o => OPENING_TOOLS.includes(o.type) && Number.isFinite(o.x) && Number.isFinite(o.y));
    out.hiddenDimensions = (d.hiddenDimensions || []).filter(k => typeof k === 'string');
    // Notes on dimensions and wall lines, which have no record of their own: keyed "dim|<key>" or "edge|<key>".
    for (const [k, v] of Object.entries(d.descriptions || {})) if (typeof v === 'string' && v && /^(dim|edge)\|/.test(k)) out.descriptions[k] = v;
    for (const [k, v] of Object.entries(d.realDimensions || {})) if (Number.isFinite(v) && v > 0) out.realDimensions[k] = v;
    out.objects = (d.objects || []).filter(o => [o.x, o.y, o.w, o.h].every(Number.isFinite) && o.w > 0 && o.h > 0).map(src => {
      const o = {
        id: src.id, name: typeof src.name === 'string' ? src.name : '', description: typeof src.description === 'string' ? src.description : '',
        x: src.x, y: src.y, w: src.w, h: src.h, rot: Number.isFinite(src.rot) ? src.rot : 0, layer: src.layer,
      };
      // Fill overrides are optional; without them the object follows the plan settings.
      if (FILLS[src.fillStyle]) o.fillStyle = src.fillStyle;
      if (pairSet(toPair(src.fillColor))) o.fillColor = toPair(src.fillColor);
      // Shape: a rectangle unless stated. A polygon keeps its corners relative to the centre, before rotation.
      if (src.shape === 'ellipse') o.shape = 'ellipse';
      if (src.shape === 'polygon' && Array.isArray(src.points)) {
        const pts = src.points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[0], p[1]]);
        if (pts.length >= 3) { o.shape = 'polygon'; o.points = pts; }
      }
      if (src.hideName === true) o.hideName = true;
      if (src.hideSize === true) o.hideSize = true;
      // Optional dimensions per side, e.g. { size: 'lt', wall: 'r' }; letters are l, r, t, b.
      if (src.measure && typeof src.measure === 'object') {
        const m = {};
        for (const type of MEASURE_TYPES) {
          const sides = Array.from(new Set(String(src.measure[type] || '').split(''))).filter(c => 'lrtb'.includes(c)).join('');
          if (sides) m[type] = sides;
        }
        if (Object.keys(m).length) o.measure = m;
      }
      return o;
    });
    out.layers = cleanLayers(d.layers, out.settings);
    const objectLayers = out.layers.filter(l => l.kind === 'objects');
    for (const o of out.objects) if (!objectLayers.some(l => l.id === o.layer)) o.layer = objectLayers[0].id;
    out.marks = (d.marks || []).filter(m => [m.x, m.y, m.height].every(Number.isFinite) && m.height > 0)
      .map(m => Object.assign({ id: m.id, x: m.x, y: m.y, height: m.height }, typeof m.description === 'string' && m.description ? { description: m.description } : {}));
    const note = src => typeof src.description === 'string' && src.description ? { description: src.description } : {};
    out.titles = (d.titles || []).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y) && typeof t.text === 'string').map(src => {
      const t = Object.assign({ id: src.id, text: src.text, x: src.x, y: src.y, layer: out.layers.some(l => l.id === src.layer) ? src.layer : out.layers[out.layers.length - 1].id }, note(src));
      // Style overrides are optional; without them the title follows its layer, then the plan.
      if (FONTS[src.font] || (typeof src.font === 'string' && src.font.startsWith('g:') && out.settings.googleFonts.includes(src.font.slice(2)))) t.font = src.font;
      if (Number.isFinite(src.fontSize)) t.fontSize = Math.min(Math.max(Math.round(src.fontSize), 6), 200);
      if (pairSet(toPair(src.fontColor))) t.fontColor = toPair(src.fontColor);
      return t;
    });
    out.compasses = (d.compasses || []).filter(c => [c.x, c.y, c.size].every(Number.isFinite) && c.size > 0)
      .map(c => Object.assign({ id: c.id, x: c.x, y: c.y, size: c.size, rot: Number.isFinite(c.rot) ? c.rot : 0 }, note(c)));
    const ids = out.walls.concat(out.openings, out.objects, out.marks, out.titles, out.compasses).map(o => +o.id || 0)
      .concat(objectLayers.map(l => +String(l.id).replace(/^L/, '') || 0));
    out.nextId = Math.max(d.nextId || 1, 1, ...ids.map(i => i + 1));
    return out;
  }

  const defaults = {
    door: { frameSize: 900, doorSize: 800 },
    doorway: { frameSize: 900 },
    window: { size: 1200, sillSize: 1300, sillDepth: 200 },
    mark: { height: 2700 },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(DEFAULTS_KEY) || '{}');
    for (const t of Object.keys(defaults)) Object.assign(defaults[t], saved[t]);
  } catch (e) { /* keep built-in defaults */ }

  let doc = newDoc();
  let walls = Geo.buildWalls([]);
  let history = [], hIndex = -1;
  let tool = 'select';
  let showSettings = false;   // side panel shows the plan settings
  let layerPanel = null;      // id of the layer whose settings the side panel shows
  let activeLayer = null;     // id of the layer highlighted in the Layers list; new objects go to it
  let sel = null;       // {kind: 'wall'|'opening', id} | {kind: 'dim'|'edge', key}
  let drag = null;
  let hiddenDimsOpen = false;   // whether the hidden-dimensions list in the side panel is unfolded
  let polyDraft = [];           // corners clicked so far with the polygon tool (world points)
  let polyHover = null;         // pointer position while drawing a polygon
  let vertexSel = null;         // { id, index }: the polygon corner picked for deletion
  let previewDim = null;   // key of a hidden dimension highlighted from the side panel
  let ghost = null;     // opening preview while a door/window tool is active
  let snap = 10;
  let spaceDown = false;
  const view = { scale: 0.08, ox: 80, oy: 80 };   // screen px = mm * scale + offset

  const rebuild = () => { walls = Geo.buildWalls(doc.walls); };
  const freshDoc = () => Object.assign(newDoc(), { units: doc.units, settings: JSON.parse(JSON.stringify(doc.settings)), layers: JSON.parse(JSON.stringify(doc.layers)) });

  const layerById = id => doc.layers.find(l => l.id === id);
  const specialLayer = kind => doc.layers.find(l => l.kind === kind);
  // Layer of the current selection. A frozen layer can be selected from but not changed.
  function selLayer() {
    if (!sel) return null;
    if (sel.kind === 'object') { const o = doc.objects.find(x => x.id === sel.id); return o ? objLayer(o) : null; }
    if (sel.kind === 'title') { const t = doc.titles.find(x => x.id === sel.id); return t ? layerById(t.layer) : null; }
    return specialLayer(['dim', 'mark', 'compass'].includes(sel.kind) ? 'dimensions' : 'walls');
  }
  const selLocked = () => { const layer = selLayer(); return !!layer && layer.frozen; };
  const lockedNote = () => `The “${selLayer().name}” layer is frozen — unfreeze it in Layers to make changes.`;
  const whyBlocked = layer => !layer.visible ? `The “${layer.name}” layer is hidden — switch it on in Layers first.`
    : layer.frozen ? `The “${layer.name}” layer is frozen — unfreeze it in Layers first.` : null;
  const objLayer = o => layerById(o.layer) || specialLayer('objects');
  // Effective object defaults: plan settings with the layer's overrides on top.
  function objSettings(o) {
    const own = objLayer(o).settings, out = Object.assign({}, doc.settings, own);
    for (const k of COLOUR_KEYS) out[k] = colourFrom([own[k], doc.settings[k]], THEME_COLOURS[k], palMode);
    return out;
  }
  // Pairs that decide an object's fill colour: its own, its layer's, the plan's.
  const fillPairs = o => [o.fillColor, objLayer(o).settings.objFillColor, doc.settings.objFillColor];
  // Layer that receives new objects: the highlighted one if it holds objects, else the topmost object layer.
  // Titles go to whichever layer is highlighted, of any kind.
  const titleTargetLayer = () => layerById(activeLayer) || doc.layers[doc.layers.length - 1];

  function targetLayer() {
    const a = layerById(activeLayer);
    return a && a.kind === 'objects' ? a : doc.layers.slice().reverse().find(l => l.kind === 'objects');
  }
  const isEmpty = () => !doc.walls.length && !doc.openings.length && !doc.objects.length && !doc.marks.length && !doc.titles.length && !doc.compasses.length;

  function resetHistory() {
    history = [JSON.stringify(doc)];
    hIndex = 0;
  }

  // Records the current state as one undo step and saves it. `keepPanel` leaves the side panel untouched.
  function commit(keepPanel) {
    rebuild();
    const s = JSON.stringify(doc);
    if (s !== history[hIndex]) {
      history.length = hIndex + 1;
      history.push(s);
      hIndex++;
      scheduleSave();
    }
    renderAll(keepPanel);
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
    layerPanel = activeLayer = null;
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
    }), doc.marks.map(m => ({ x: m.x - 300, y: m.y - 150, w: 600, h: 300 })),
      doc.titles.map(t => ({ x: t.x - 500, y: t.y - 200, w: 1000, h: 400 })),
      doc.compasses.map(c => ({ x: c.x - c.size / 2, y: c.y - c.size / 2, w: c.size, h: c.size })));
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
  const OBJECT_TOOLS = { object: undefined, ellipse: 'ellipse', polygon: 'polygon' };   // tool -> shape

  // After its corners change, a polygon is re-centred on its bounding box and its size updated.
  function normalisePolygon(o) {
    const xs = o.points.map(p => p[0]), ys = o.points.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, c = objToWorld(o, cx, cy);
    o.points = o.points.map(p => [Math.round(p[0] - cx), Math.round(p[1] - cy)]);
    o.x = Math.round(c[0]); o.y = Math.round(c[1]);
    o.w = Math.max(Math.round(x1 - x0), 10); o.h = Math.max(Math.round(y1 - y0), 10);
  }

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // The object's outline in its own (rotated, centred) pixel frame.
  function shapeEl(o, pw, ph, attrs) {
    if (o.shape === 'ellipse') return `<ellipse rx="${f(pw / 2)}" ry="${f(ph / 2)}" ${attrs}/>`;
    if (o.shape === 'polygon') return `<path d="${poly(o.points.map(p => [p[0] * view.scale, p[1] * view.scale]))}" ${attrs}/>`;
    return `<rect x="${f(-pw / 2)}" y="${f(-ph / 2)}" width="${f(pw)}" height="${f(ph)}" ${attrs}/>`;
  }

  function objectHandles(o) {
    const at = (lx, ly) => S(...objToWorld(o, lx, ly));
    if (o.shape === 'polygon') {
      // A square on every corner, a dot in the middle of every edge (drag it to add a corner), and the rotation handle.
      const n = o.points.length, top = Math.min(...o.points.map(p => p[1]));
      const list = o.points.map((p, i) => ({ id: 'v', index: i, p: at(p[0], p[1]) }));
      o.points.forEach((p, i) => { const q = o.points[(i + 1) % n]; list.push({ id: 'm', index: i, p: at((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) }); });
      list.push({ id: 'top', p: at(0, top) }, { id: 'rot', p: at(0, top - 24 / view.scale) });
      return list;
    }
    const list = HANDLES.map(([id, fx, fy]) => ({ id, fx, fy, p: at((fx - .5) * o.w, (fy - .5) * o.h) }));
    list.push({ id: 'rot', p: at(0, -o.h / 2 - 24 / view.scale) });
    return list;
  }

  function hitObject(w, layerId) {
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const o = doc.objects[i], l = objToLocal(o, w);
      if (o.layer !== layerId) continue;
      if (o.shape === 'polygon' ? pointInPolygon(l.x, l.y, o.points)
        : o.shape === 'ellipse' ? (l.x / (o.w / 2)) ** 2 + (l.y / (o.h / 2)) ** 2 <= 1
        : Math.abs(l.x) <= o.w / 2 && Math.abs(l.y) <= o.h / 2) return o;
    }
    return null;
  }

  // Object interior: a plain colour, or hatch lines in that colour over white. The hatch turns with the object.
  function objectFillSvg(o, pw, ph) {
    const st = objSettings(o), style = o.fillStyle || st.objFillStyle, color = colourFrom(fillPairs(o), 'objFill', palMode);
    if (style === 'solid') return shapeEl(o, pw, ph, `fill="${color}" fill-opacity=".85"`);
    const id = 'objfill-' + (o.id || 'new');
    const n = st.objHatchSpacing;   // pattern tile size; extra stubs keep the lines joined at tile corners
    const left = `M0 0L${n} ${n}M-2 ${n - 2}L2 ${n + 2}M${n - 2} -2L${n + 2} 2`, right = `M0 ${n}L${n} 0M-2 2L2 -2M${n - 2} ${n + 2}L${n + 2} ${n - 2}`;
    const d = style === 'diagLeft' ? left : style === 'diagRight' ? right : left + right;
    return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="${n}" height="${n}"><path d="${d}" stroke="${color}" stroke-width="1.2" fill="none"/></pattern></defs>` +
      shapeEl(o, pw, ph, `fill="${PAPER}" fill-opacity=".85"`) + shapeEl(o, pw, ph, `fill="url(#${id})"`);
  }

  function objectSvg(o, selected, preview) {
    const st = objSettings(o), [cx, cy] = S(o.x, o.y), pw = o.w * view.scale, ph = o.h * view.scale;
    const stroke = selected || preview ? ACCENT : st.objBorderColor;
    const border = selected || preview ? Math.max(st.objBorderSize, selected ? 2 : 1.2) : st.objBorderSize;
    let g = `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${o.rot})">` +
      objectFillSvg(o, pw, ph) +
      shapeEl(o, pw, ph, `fill="none" stroke="${border ? stroke : 'none'}" stroke-width="${border}" stroke-linejoin="round"${preview ? ' stroke-dasharray="5 3"' : ''}`);
    const hatched = (o.fillStyle || st.objFillStyle) !== 'solid';
    // Name and size, as many lines as fit; the text always turns with the object.
    const size = st.objFontSize, showName = !!o.name && !o.hideName;
    const lines = [showName && o.name, !o.hideSize && `${fmt(o.w)} × ${fmt(o.h)}`].filter(Boolean);
    const fits = n => ph >= n * size * 1.25 + 4 && lines.slice(0, n).every(t => pw >= t.length * size * (showName && t === o.name ? 0.66 : 0.6) + 6);
    const count = fits(lines.length) ? lines.length : fits(1) ? 1 : 0;
    for (let i = 0; i < count; i++) {
      const y = (i - (count - 1) / 2) * size * 1.25;
      g += `<text x="0" y="${f(y)}" style="font-family:${fontCss(st.objFont)};font-size:${size}px${i === 0 && showName ? ';font-weight:700' : ''}" text-anchor="middle" dominant-baseline="central" fill="${selected ? ACCENT : st.objFontColor}"${hatched ? ' stroke="${PAPER}" stroke-width="4" paint-order="stroke"' : ''}>${esc(lines[i])}</text>`;
    }
    g += '</g>';
    if (selected && !objLayer(o).frozen) {
      const hs = objectHandles(o), rot = hs[hs.length - 1], top = hs.find(x => x.id === 'n' || x.id === 'top');
      g += line(top.p, rot.p, `stroke="${ACCENT}" stroke-width="1"`);
      for (const hp of hs) {
        if (hp.id === 'top') continue;
        const picked = hp.id === 'v' && vertexSel && vertexSel.id === o.id && vertexSel.index === hp.index;
        g += hp.id === 'rot' ? `<circle cx="${f(hp.p[0])}" cy="${f(hp.p[1])}" r="5" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`
          : hp.id === 'm' ? `<circle cx="${f(hp.p[0])}" cy="${f(hp.p[1])}" r="3.2" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="2 1.5"/>`
          : `<rect x="${f(hp.p[0] - 4)}" y="${f(hp.p[1] - 4)}" width="8" height="8" fill="${picked ? ACCENT : PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`;
      }
    }
    return g;
  }

  // ---------- Titles ----------
  // Free text on any layer. Font, size and colour come from the title itself, else its layer, else the plan.

  function titleStyle(t) {
    const own = (layerById(t.layer) || doc.layers[0]).settings || {};
    return {
      font: t.font || own.titleFont || doc.settings.titleFont,
      size: t.fontSize || own.titleFontSize || doc.settings.titleFontSize,
      colour: colourFrom([t.fontColor, own.titleFontColor, doc.settings.titleFontColor], 'ink', palMode),
    };
  }
  const titlePairs = t => [t.fontColor, ((layerById(t.layer) || {}).settings || {}).titleFontColor, doc.settings.titleFontColor];

  function titleBox(t) {
    const st = titleStyle(t), [cx, cy] = S(t.x, t.y);
    const w = Math.max(t.text.length, 1) * st.size * 0.62 + 12, hgt = st.size * 1.45;
    return { cx, cy, x: cx - w / 2, y: cy - hgt / 2, w, h: hgt, st };
  }

  function titleSvg(t, selected) {
    const b = titleBox(t);
    return (selected ? `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="none" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="5 3"/>` : '') +
      `<text x="${f(b.cx)}" y="${f(b.cy)}" style="font-family:${fontCss(b.st.font)};font-size:${b.st.size}px;font-weight:600" text-anchor="middle" dominant-baseline="central" fill="${b.st.colour}">${esc(t.text)}</text>`;
  }

  function hitTitle(p, layerId) {
    for (let i = doc.titles.length - 1; i >= 0; i--) {
      const t = doc.titles[i];
      if (t.layer !== layerId) continue;
      const b = titleBox(t);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return t;
    }
    return null;
  }

  // ---------- Compass roses ----------
  // Lives on the dimensions layer; `size` is its diameter on the plan and rot 0 points north up.

  function compassHandles(c) {
    const r = c.size / 2, at = (lx, ly) => S(...objToWorld(c, lx, ly));
    return [['nw', -r, -r], ['ne', r, -r], ['se', r, r], ['sw', -r, r]].map(([id, lx, ly]) => ({ id, p: at(lx, ly) }))
      .concat({ id: 'rot', p: at(0, -r - 24 / view.scale) });
  }

  function compassSvg(c, selected) {
    const st = planStyle(), [cx, cy] = S(c.x, c.y), R = c.size * view.scale / 2;
    const color = selected ? ACCENT : st.dimColor, textColor = selected ? ACCENT : st.dimFontColor;
    const w = R * 0.12, sw = selected ? 1.6 : 1.1;
    const tri = (pts, filled) => `<path d="${poly(pts)}" fill="${filled ? color : PAPER}" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"/>`;
    let g = `<g transform="translate(${f(cx)} ${f(cy)}) rotate(${c.rot})">` +
      `<circle r="${f(R * 0.6)}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
    // Short diagonal points first, then the four main ones on top; each point is half filled.
    for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
      const tip = [dx * R * 0.4, dy * R * 0.4];
      g += tri([tip, [dx * w, 0], [0, 0]], true) + tri([tip, [0, dy * w], [0, 0]], false);
    }
    for (const [dx, dy, len] of [[0, -1, 0.8], [1, 0, 0.7], [0, 1, 0.7], [-1, 0, 0.7]]) {
      const tip = [dx * R * len, dy * R * len], a = [-dy * w + dx * w, dx * w + dy * w], b = [dy * w + dx * w, -dx * w + dy * w];
      g += tri([tip, a, [0, 0]], true) + tri([tip, b, [0, 0]], false);
    }
    g += `<text x="0" y="${f(-R * 0.91)}" style="font-family:${fontCss(st.dimFont)};font-size:${f(Math.max(R * 0.2, 7))}px;font-weight:700" text-anchor="middle" dominant-baseline="central" fill="${textColor}">N</text></g>`;
    if (selected && !specialLayer('dimensions').frozen) {
      const hs = compassHandles(c), rot = hs[hs.length - 1];
      g += `<path d="${poly(hs.slice(0, 4).map(x => x.p))}" fill="none" stroke="${ACCENT}" stroke-width="1" stroke-dasharray="5 3"/>`;
      g += line([(hs[0].p[0] + hs[1].p[0]) / 2, (hs[0].p[1] + hs[1].p[1]) / 2], rot.p, `stroke="${ACCENT}" stroke-width="1"`);
      for (const hp of hs) {
        g += hp.id === 'rot'
          ? `<circle cx="${f(hp.p[0])}" cy="${f(hp.p[1])}" r="5" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`
          : `<rect x="${f(hp.p[0] - 4)}" y="${f(hp.p[1] - 4)}" width="8" height="8" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`;
      }
    }
    return g;
  }

  function hitCompass(w) {
    for (let i = doc.compasses.length - 1; i >= 0; i--) {
      const c = doc.compasses[i];
      if (Math.hypot(w.x - c.x, w.y - c.y) <= c.size / 2) return c;
    }
    return null;
  }

  // ---------- Ceiling height marks ----------
  // A height value with an up-triangle in a rounded box. Lives on the dimensions layer and uses its font and colours.

  function markBox(m) {
    const size = doc.settings.dimFontSize, text = fmt(m.height), [cx, cy] = S(m.x, m.y);
    const tri = size * 0.9, pad = size * 0.55, gap = size * 0.35;
    const w = pad + tri + gap + text.length * size * 0.6 + pad, hgt = size * 1.9;
    return { cx, cy, x: cx - w / 2, y: cy - hgt / 2, w, h: hgt, text, size, tri, pad, gap };
  }

  function markSvg(m, selected) {
    const st = planStyle(), b = markBox(m);
    const color = selected ? ACCENT : st.dimColor, textColor = selected ? ACCENT : st.dimFontColor;
    const tx = b.x + b.pad, half = b.tri / 2, top = b.cy - b.tri * 0.43, bottom = b.cy + b.tri * 0.43;
    return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="${f(b.h * 0.28)}" fill="${PAPER}" stroke="${color}" stroke-width="${selected ? 2 : 1.2}"/>` +
      `<path d="${poly([[tx + half, top], [tx + b.tri, bottom], [tx, bottom]])}" fill="${textColor}"/>` +
      `<text x="${f(tx + b.tri + b.gap)}" y="${f(b.cy)}" style="font-family:${fontCss(st.dimFont)};font-size:${b.size}px" text-anchor="start" dominant-baseline="central" fill="${textColor}">${b.text}</text>`;
  }

  function hitMark(p) {
    for (let i = doc.marks.length - 1; i >= 0; i--) {
      const b = markBox(doc.marks[i]);
      if (p.x >= b.x - 2 && p.x <= b.x + b.w + 2 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2) return doc.marks[i];
    }
    return null;
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
    doc.descriptions = Object.fromEntries(Object.entries(doc.descriptions).map(([k, v]) => {
      const cut = k.indexOf('|') + 1;
      return [k.slice(0, cut) + remap(k.slice(cut)), v];
    }));
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
    return `<defs>${pattern('gMinor', step, pal.gridMinor)}${pattern('gMajor', major, pal.gridMajor)}</defs>` +
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
      h += `<path d="${box(-o.sillSize / 2, o.sillSize / 2, side * t / 2, side * (t / 2 + o.sillDepth))}" fill="${PAPER}" stroke="${stroke}" stroke-width="${sw}"/>`;
      h += `<path d="${box(-W / 2, W / 2, -t / 2, t / 2)}" fill="${PAPER}" stroke="${stroke}" stroke-width="${sw}"/>`;
      for (const b of [-t / 6, t / 6]) h += line(P(-W / 2, b), P(W / 2, b), `stroke="${stroke}" stroke-width="1"`);
    } else {
      h += `<path d="${box(-W / 2, W / 2, -t / 2, t / 2)}" fill="${PAPER}" stroke="${stroke}" stroke-width="${sw}"/>`;
      if (o.type === 'door') {
        const D = Math.min(o.doorSize, W), jamb = (W - D) / 2;
        if (jamb > 0) {
          h += `<path d="${box(-W / 2, -W / 2 + jamb, -t / 2, t / 2)}${box(W / 2 - jamb, W / 2, -t / 2, t / 2)}" fill="${JAMB}" stroke="${stroke}" stroke-width="1"/>`;
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
    const st = planStyle(), textColor = stroke === INK ? st.dimFontColor : stroke;
    if (t * view.scale >= st.dimFontSize + 2 && W * view.scale >= label.length * st.dimFontSize * 0.64 + 8) {
      const [x, y] = P(0, 0);
      const rot = o.axis === 'v' ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : '';
      h += `<text x="${f(x)}" y="${f(y)}" style="font-family:${fontCss(st.dimFont)};font-size:${st.dimFontSize}px" text-anchor="middle" dominant-baseline="central" fill="${textColor}" stroke="${PAPER}" stroke-width="3" paint-order="stroke"${rot}>${label}</text>`;
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
    const st = planStyle(), g = dimGeom(seg), sw = selected ? 1.8 : 1;
    const color = selected ? ACCENT : st.dimColor, textColor = selected ? ACCENT : st.dimFontColor;
    const ext = (x, y) => line([x + seg.nx * 3, y + seg.ny * 3], [x + seg.nx * (seg.off + 4), y + seg.ny * (seg.off + 4)], `stroke="${color}" stroke-width="0.8"`);
    const rot = g.vertical ? ` transform="rotate(-90 ${f(g.tx)} ${f(g.ty)})"` : '';
    return ext(g.ax, g.ay) + ext(g.bx, g.by) +
      line(g.a, g.b, `stroke="${color}" stroke-width="${sw}"`) +
      dimEndSvg(g.a, g.b, color) + dimEndSvg(g.b, g.a, color) +
      `<text x="${f(g.tx)}" y="${f(g.ty)}" style="font-family:${fontCss(st.dimFont)};font-size:${st.dimFontSize}px" text-anchor="middle" dominant-baseline="central" fill="${textColor}" stroke="${PAPER}" stroke-width="3" paint-order="stroke"${selected ? ' font-weight="600"' : ''}${rot}>${g.text}</text>`;
  }

  // ---------- Object dimensions ----------
  // Sides are the object's own (left, right, top, bottom before rotation) and turn with it.

  // side: [start x, start y, end x, end y] in half-sizes, then the outward normal
  const OBJ_SIDES = { l: [-1, -1, -1, 1, -1, 0], r: [1, -1, 1, 1, 1, 0], t: [-1, -1, 1, -1, 0, -1], b: [-1, 1, 1, 1, 0, 1] };

  function objectSide(o, key) {
    const [ax, ay, bx, by, nx, ny] = OBJ_SIDES[key], hw = o.w / 2, hh = o.h / 2;
    const a = objToWorld(o, ax * hw, ay * hh), b = objToWorld(o, bx * hw, by * hh);
    const rad = o.rot * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { a, b, len, n: [nx * c - ny * sn, nx * sn + ny * c], dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] };
  }

  // What a side can be measured against: wall outlines, or the edges of every other visible object.
  function obstacleSegments(self, kind) {
    const segs = [];
    if (kind === 'wall') {
      if (specialLayer('walls').visible) for (const sg of walls.segments) segs.push([[sg.x1, sg.y1], [sg.x2, sg.y2]]);
      return segs;
    }
    for (const o of doc.objects) {
      if (o === self || !objLayer(o).visible) continue;
      // Polygons contribute their real edges; round objects are approximated by their bounding box.
      const local = o.shape === 'polygon' ? o.points : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * o.w / 2, y * o.h / 2]);
      const c = local.map(p => objToWorld(o, p[0], p[1]));
      for (let i = 0; i < c.length; i++) segs.push([c[i], c[(i + 1) % c.length]]);
    }
    return segs;
  }

  // Distance along d from point o to segment p-q, or null if the ray misses it.
  function rayToSegment(o, d, p, q) {
    const ex = q[0] - p[0], ey = q[1] - p[1], den = d[0] * ey - d[1] * ex;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p[0] - o[0]) * ey - (p[1] - o[1]) * ex) / den, u = ((p[0] - o[0]) * d[1] - (p[1] - o[1]) * d[0]) / den;
    return t > 0.5 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
  }

  // Gap straight out from a side: how far the whole side can slide outwards before it touches something.
  // First contact is always at an end of the side or at an end of the other segment.
  function gapFromSide(side, segs) {
    const n = side.n, back = [-n[0], -n[1]], hits = [];
    for (const [p, q] of segs) {
      for (const o of [side.a, side.b]) {
        const t = rayToSegment(o, n, p, q);
        if (t !== null) hits.push({ t, from: o });
      }
      for (const o of [p, q]) {
        const t = rayToSegment(o, back, side.a, side.b);
        if (t !== null) hits.push({ t, from: [o[0] - n[0] * t, o[1] - n[1] * t] });
      }
    }
    if (!hits.length) return null;
    const dist = Math.min(...hits.map(x => x.t));
    // Facing a parallel edge, contact happens along a stretch of the side: measure in the middle of it.
    const along = hits.filter(x => x.t - dist < 0.5).map(x => (x.from[0] - side.a[0]) * side.dir[0] + (x.from[1] - side.a[1]) * side.dir[1]);
    const mid = (Math.min(...along) + Math.max(...along)) / 2;
    const from = [side.a[0] + side.dir[0] * mid, side.a[1] + side.dir[1] * mid];
    return { from, to: [from[0] + n[0] * dist, from[1] + n[1] * dist], dist };
  }

  // A dimension between two world points at any angle. With an offset it is drawn beside them
  // (shifted along n, with extension lines); without, straight between them.
  function freeDimSvg(aw, bw, n, off, text) {
    const st = planStyle(), a0 = S(aw[0], aw[1]), b0 = S(bw[0], bw[1]);
    if (Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) < 10) return '';
    const a = [a0[0] + n[0] * off, a0[1] + n[1] * off], b = [b0[0] + n[0] * off, b0[1] + n[1] * off];
    let g = '';
    if (off) for (const p of [a0, b0]) g += line([p[0] + n[0] * 3, p[1] + n[1] * 3], [p[0] + n[0] * (off + 4), p[1] + n[1] * (off + 4)], `stroke="${st.dimColor}" stroke-width="0.8"`);
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (angle >= 90) angle -= 180; else if (angle < -90) angle += 180;   // keep the text upright
    const tx = (a[0] + b[0]) / 2 + n[0] * st.dimFontSize * 0.82, ty = (a[1] + b[1]) / 2 + n[1] * st.dimFontSize * 0.82;
    return g + line(a, b, `stroke="${st.dimColor}" stroke-width="1"`) + dimEndSvg(a, b, st.dimColor) + dimEndSvg(b, a, st.dimColor) +
      `<text x="${f(tx)}" y="${f(ty)}" transform="rotate(${f(angle)} ${f(tx)} ${f(ty)})" style="font-family:${fontCss(st.dimFont)};font-size:${st.dimFontSize}px" text-anchor="middle" dominant-baseline="central" fill="${st.dimFontColor}" stroke="${PAPER}" stroke-width="3" paint-order="stroke">${text}</text>`;
  }

  function objectMeasuresSvg(o) {
    const m = o.measure;
    if (!m || o.shape) return '';   // side dimensions make sense for rectangles only
    let g = '';
    const segs = {};   // obstacle lists, built only when a gap is asked for
    for (const key of 'lrtb') {
      const wants = type => (m[type] || '').includes(key);
      if (!MEASURE_TYPES.some(wants)) continue;
      const side = objectSide(o, key);
      if (wants('size')) g += freeDimSvg(side.a, side.b, side.n, dimOffset(), fmt(side.len));
      // The two gaps are labelled on opposite sides of their lines so they stay readable when they coincide.
      for (const [kind, labelSide] of [['object', side.dir], ['wall', [-side.dir[0], -side.dir[1]]]]) {
        if (!wants(kind)) continue;
        segs[kind] = segs[kind] || obstacleSegments(o, kind);
        const gap = gapFromSide(side, segs[kind]);
        if (gap) g += freeDimSvg(gap.from, gap.to, labelSide, 0, fmt(gap.dist));
      }
    }
    return g;
  }

  // Everything that belongs to the plan itself (no grid, handles or previews); also what gets exported.
  function layersSvg() {
    const h = [];
    // Layers are drawn bottom to top; hidden ones are skipped.
    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      if (layer.kind === 'walls') {
        if (walls.loops.length) {
          const d = walls.loops.map(l => poly(l.points.map(p => S(p[0], p[1])))).join('');
          h.push(`<path d="${d}" fill="${planStyle().wallColor}" fill-rule="evenodd"/>`);
        }
        for (const o of doc.openings) h.push(openingSvg(o, { selected: sel && sel.kind === 'opening' && sel.id === o.id }));
      } else if (layer.kind === 'dimensions') {
        for (const seg of visibleDims()) h.push(dimSvg(seg, !!sel && sel.kind === 'dim' && sel.key === seg.key));
        for (const o of doc.objects) if (o.measure && objLayer(o).visible) h.push(objectMeasuresSvg(o));
        for (const c of doc.compasses) h.push(compassSvg(c, !!sel && sel.kind === 'compass' && sel.id === c.id));
        for (const m of doc.marks) h.push(markSvg(m, !!sel && sel.kind === 'mark' && sel.id === m.id));
      } else {
        for (const o of doc.objects) if (o.layer === layer.id) h.push(objectSvg(o, !!sel && sel.kind === 'object' && sel.id === o.id));
      }
      for (const t of doc.titles) if (t.layer === layer.id) h.push(titleSvg(t, !!sel && sel.kind === 'title' && sel.id === t.id));
    }
    return h.join('');
  }

  function render() {
    const box = svg.getBoundingClientRect();
    const h = [gridSvg(box.width, box.height)];

    h.push(layersSvg());

    if (sel && sel.kind === 'edge') {
      const seg = walls.segments.find(s => s.key === sel.key);
      if (seg) h.push(line(S(seg.x1, seg.y1), S(seg.x2, seg.y2), `stroke="${ACCENT}" stroke-width="3" stroke-linecap="round"`));
    }
    if (sel && sel.kind === 'wall') {
      const r = doc.walls.find(w => w.id === sel.id);
      if (r) {
        const [x, y] = S(r.x, r.y);
        h.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(r.w * view.scale)}" height="${f(r.h * view.scale)}" fill="rgba(26,115,232,.18)" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
        if (!selLocked()) for (const hp of handlePoints(r)) h.push(`<rect x="${f(hp.p[0] - 4)}" y="${f(hp.p[1] - 4)}" width="8" height="8" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`);
      }
    }

    if (drag && drag.kind === 'newobject') {
      const r = dragRect(drag);
      if (r.w > 0 && r.h > 0) h.push(objectSvg({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, rot: 0, name: '', layer: targetLayer().id, shape: drag.shape }, false, true));
    }
    if (tool === 'polygon' && polyDraft.length) {
      const pts = polyDraft.concat(polyHover ? [polyHover] : []).map(p => S(p[0], p[1]));
      h.push(`<path d="M${pts.map(p => f(p[0]) + ' ' + f(p[1])).join('L')}" fill="none" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
      pts.slice(0, polyDraft.length).forEach((p, i) => h.push(`<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${i ? 3 : 5}" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.5"/>`));
    }
    if (drag && drag.kind === 'newwall') {
      const r = dragRect(drag);
      const [x, y] = S(r.x, r.y);
      h.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(r.w * view.scale)}" height="${f(r.h * view.scale)}" fill="${planStyle().wallColor}" fill-opacity=".55" stroke="${ACCENT}" stroke-width="1"/>`);
      h.push(`<text x="${f(x + r.w * view.scale / 2)}" y="${f(y - 10)}" text-anchor="middle" fill="${ACCENT}" stroke="${PAPER}" stroke-width="3" paint-order="stroke" font-weight="600">${fmt(r.w)} × ${fmt(r.h)}</text>`);
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
    if (sel.kind === 'mark') return doc.marks.find(m => m.id === sel.id) || null;
    if (sel.kind === 'title') return doc.titles.find(t => t.id === sel.id) || null;
    if (sel.kind === 'compass') return doc.compasses.find(c => c.id === sel.id) || null;
    if (sel.kind === 'dim') return allDims().find(d => d.key === sel.key) || null;
    return walls.segments.find(s => s.key === sel.key) || null;
  }

  function openingFields(type, o) {
    if (type === 'door') return field('Frame size', 'frameSize', o.frameSize) + field('Door size', 'doorSize', o.doorSize);
    if (type === 'doorway') return field('Opening size', 'frameSize', o.frameSize);
    return field('Window size', 'size', o.size) + field('Sill size', 'sillSize', o.sillSize) + field('Sill depth', 'sillDepth', o.sillDepth);
  }

  const TITLES = { door: 'Door', doorway: 'Doorway', window: 'Window' };

  // Builders for settings rows. `attr` names the data attribute the inputs carry; `overridden` marks rows set on a layer.
  // One colour setting: a swatch per mode. A dashed swatch is automatic; ↺ returns a picked one to automatic.
  function colourRow(label, attr, key, own, chain, slot, marked) {
    const side = mode => {
      const auto = !(own && own[mode]), name = mode === 'light' ? 'Light' : 'Dark';
      return `<span class="side${mode === currentMode() ? ' now' : ''}${auto ? ' auto' : ''}" title="${name} mode colour${auto ? ' (automatic)' : ''}">` +
        `<i>${mode === 'light' ? '☀' : '☾'}</i><input type="color" ${attr}="${key}" data-side="${mode}" value="${colourFrom(chain, slot, mode)}">` +
        `<button type="button" data-act="autoColour" data-level="${attr}" data-key="${key}" data-side="${mode}" title="Back to automatic" ${auto ? 'disabled' : ''}>↺</button></span>`;
    };
    return `<div class="field pair"><em>${marked ? '<b class="ovr" title="Set on this layer">●</b> ' : ''}${label}</em><span class="sides">${side('light')}${side('dark')}</span></div>`;
  }
  const planPairs = key => ({ own: doc.settings[key], chain: [doc.settings[key]] });

  function settingControls(values, attr, overridden, pairsOf) {
    const wrap = (key, label, control, unit) =>
      `<label class="field"><em>${overridden && overridden.has(key) ? '<b class="ovr" title="Set on this layer">●</b> ' : ''}${label}</em>${control}${unit === undefined ? '' : `<span>${unit}</span>`}</label>`;
    return {
      colour: (key, label) => {
        const { own, chain } = pairsOf(key);
        return colourRow(label, attr, key, own, chain, THEME_COLOURS[key], !!overridden && overridden.has(key));
      },
      number: (key, label, min, max, unit, step) => wrap(key, label, `<input type="number" ${attr}="${key}" min="${min}" max="${max}" step="${step || 1}" value="${values[key]}">`, unit),
      choice: (key, label, options) => wrap(key, label, `<select ${attr}="${key}">${options.map(([v, t]) => `<option value="${esc(v)}"${values[key] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`),
    };
  }
  const wallSettingRows = c => c.colour('wallColor', 'Colour');
  const dimSettingRows = c => c.choice('dimEnds', 'Line ends', Object.entries(DIM_ENDS)) + c.colour('dimColor', 'Line colour') +
    c.choice('dimFont', 'Font', fontChoices()) + c.number('dimFontSize', 'Font size', 6, 40, 'px') + c.colour('dimFontColor', 'Font colour') +
    c.number('dimDistance', 'Distance from wall', 20, 500, '%');
  const titleSettingRows = c => c.choice('titleFont', 'Font', fontChoices()) + c.number('titleFontSize', 'Font size', 6, 200, 'px') + c.colour('titleFontColor', 'Font colour');
  const objectSettingRows = c => c.choice('objFont', 'Font', fontChoices()) + c.number('objFontSize', 'Font size', 6, 40, 'px') +
    c.colour('objFontColor', 'Font colour') + c.choice('objFillStyle', 'Fill style', Object.entries(FILLS)) + c.colour('objFillColor', 'Fill colour') +
    c.number('objHatchSpacing', 'Hatch spacing', 3, 60, 'px') + c.number('objBorderSize', 'Border size', 0, 10, 'px', 0.5) + c.colour('objBorderColor', 'Border colour');

  function layerPanelHtml(layer) {
    const own = Object.keys(layer.settings).length;
    // Layer-level controls: values shown are the effective ones, rows set on this layer are marked.
    const lc = settingControls(Object.assign({}, doc.settings, layer.settings), 'data-lset', new Set(Object.keys(layer.settings)),
      key => ({ own: layer.settings[key], chain: [layer.settings[key], doc.settings[key]] }));
    const titles = '<h4>Titles on this layer</h4>' + titleSettingRows(lc);
    const tail = (own ? `<p>● ${own} setting${own > 1 ? 's' : ''} set on this layer; the rest follow the plan settings.</p>`
        : '<p>Change a value marked for this layer to set it here only; otherwise the plan settings apply.</p>') +
      `<div class="row"><button data-act="clearLayerSettings" ${own ? '' : 'disabled'}>Use plan settings</button><button data-act="closeLayerPanel" class="primary">Done</button></div>`;
    if (layer.kind === 'walls') {
      return '<h3>Walls layer</h3><p>Holds the walls with their doors, doorways and windows.</p>' + wallSettingRows(settingControls(doc.settings, 'data-set', null, planPairs)) + titles + tail;
    }
    if (layer.kind === 'dimensions') {
      return '<h3>Dimensions layer</h3><p>Holds dimension lines, ceiling height marks and compass roses.</p>' + dimSettingRows(settingControls(doc.settings, 'data-set', null, planPairs)) + titles + tail;
    }
    return '<h3>Layer</h3>' +
      `<label class="field">Name<input type="text" data-lname value="${esc(layer.name)}"></label>` +
      '<h4>Object defaults on this layer</h4>' + objectSettingRows(lc) + titles + tail;
  }

  // The Layers list: topmost layer first, with visibility and freeze toggles per row.
  function renderLayers() {
    if (!layerById(activeLayer)) activeLayer = targetLayer().id;
    const active = layerById(activeLayer), index = doc.layers.indexOf(active);
    const canDelete = active.kind === 'objects' && doc.layers.filter(l => l.kind === 'objects').length > 1;
    const button = (act, name, tip, disabled) => `<button data-lact="${act}" title="${tip}" aria-label="${tip}" ${disabled ? 'disabled' : ''}>${icon(name)}</button>`;
    $('#layers').innerHTML = '<div class="layers-head"><h3>Layers</h3><div class="layer-tools">' +
      button('add', 'plus', 'Add object layer') +
      button('up', 'up', 'Move layer up (in front)', index === doc.layers.length - 1) +
      button('down', 'down', 'Move layer down (behind)', index === 0) +
      button('settings', 'cog', 'Layer settings') +
      button('delete', 'remove', 'Delete layer (its objects move to another layer)', !canDelete) +
      '</div></div><ul class="layer-list">' +
      doc.layers.slice().reverse().map(l => {
        const count = l.kind === 'objects' ? doc.objects.filter(o => o.layer === l.id).length : '';
        return `<li data-layer="${esc(l.id)}" class="${l.id === activeLayer ? 'active' : ''}${l.visible ? '' : ' hidden-layer'}">` +
          `<button data-lact="vis" class="${l.visible ? '' : 'off'}" title="${l.visible ? 'Hide layer' : 'Show layer'}">${icon(l.visible ? 'eye' : 'eyeOff')}</button>` +
          `<button data-lact="freeze" class="${l.frozen ? 'on' : 'off'}" title="${l.frozen ? 'Unfreeze layer' : 'Freeze layer (can be selected but not changed)'}">${icon(l.frozen ? 'lock' : 'lockOpen')}</button>` +
          `<span class="lname">${esc(l.name)}</span><span class="lkind">${count}</span></li>`;
      }).join('') + '</ul>';
  }

  $('#layers').addEventListener('click', e => {
    const btn = e.target.closest('button[data-lact]'), row = e.target.closest('li[data-layer]');
    if (row) activeLayer = row.dataset.layer;
    const layer = layerById(activeLayer);
    if (!btn) {
      if (layerPanel) layerPanel = activeLayer;
      return renderAll();
    }
    const act = btn.dataset.lact, i = doc.layers.indexOf(layer);
    if (act === 'vis') layer.visible = !layer.visible;
    else if (act === 'freeze') layer.frozen = !layer.frozen;
    else if (act === 'add') {
      const n = doc.layers.filter(l => l.kind === 'objects').length + 1;
      const added = { id: 'L' + doc.nextId++, kind: 'objects', name: 'Layer ' + n, visible: true, frozen: false, settings: {} };
      doc.layers.splice(i + 1, 0, added);
      activeLayer = added.id;
    } else if (act === 'up' || act === 'down') {
      const j = i + (act === 'up' ? 1 : -1);
      if (j < 0 || j >= doc.layers.length) return;
      doc.layers.splice(i, 1);
      doc.layers.splice(j, 0, layer);
    } else if (act === 'settings') {
      layerPanel = layerPanel === activeLayer ? null : activeLayer;
      showSettings = false;
      sel = null;
      if (tool !== 'select') { const keep = layerPanel; setTool('select'); layerPanel = keep; }
      return renderAll();
    } else if (act === 'delete') {
      const others = doc.layers.filter(l => l.kind === 'objects' && l !== layer);
      if (layer.kind !== 'objects' || !others.length) return;
      // Objects are kept: they move to the nearest object layer below, or above if there is none.
      const below = doc.layers.slice(0, i).reverse().find(l => l.kind === 'objects');
      const home = below || others[0];
      for (const o of doc.objects.concat(doc.titles)) if (o.layer === layer.id) o.layer = home.id;
      doc.layers.splice(i, 1);
      activeLayer = home.id;
    }
    commit();
  });

  let panelView = null;     // what the side panel currently shows
  let panelSource = null;   // the control whose change is being committed
  let liveDirty = false;    // typed changes shown on the plan but not yet committed

  // Selector that finds the same control again after the panel has been rebuilt.
  function controlKey(el) {
    const side = el.dataset.side ? `[data-side="${el.dataset.side}"]` : '';
    if (el.dataset.measure) return `[data-measure="${el.dataset.measure}"][data-mside="${el.dataset.mside}"]`;
    for (const k of ['k', 'set', 'lset', 'ofill', 'oflag', 'tcol']) if (el.dataset[k]) return `[data-${k}="${el.dataset[k]}"]${side}`;
    for (const k of ['name', 'rot', 'desc', 'real', 'lname', 'olayer', 'gfont', 'ttext', 'tfont', 'tsize', 'tlayer']) if (k in el.dataset) return `[data-${k}]`;
    return null;
  }

  // Description of whatever is selected. Dimensions and wall lines keep theirs in doc.descriptions.
  const keyedNote = () => sel.kind + '|' + sel.key;
  function selectedDescription() {
    if (sel.kind === 'dim' || sel.kind === 'edge') return doc.descriptions[keyedNote()] || '';
    const target = selectedObject();
    return (target && target.description) || '';
  }
  const descriptionField = () =>
    `<label class="note">Description<textarea data-desc rows="3" placeholder="Notes; not shown on the plan">${esc(selectedDescription())}</textarea></label>`;

  function renderPanel() {
    const obj = selectedObject();
    if (sel && !obj) sel = null;
    if (sel) {
      // Nothing stays selected on a layer that has been hidden.
      const layer = selLayer();
      if (layer && !layer.visible) sel = null;
    }
    if (sel || tool !== 'select') { showSettings = false; layerPanel = null; }
    if (layerPanel && !layerById(layerPanel)) layerPanel = null;
    let h;
    if (layerPanel) {
      h = layerPanelHtml(layerById(layerPanel));
    } else if (showSettings) {
      const st = doc.settings, c = settingControls(st, 'data-set', null, planPairs);
      h = '<h3>Settings</h3>' +
        '<p>Each colour has a light-mode (☀) and a dark-mode (☾) value: pick one and the other is derived from it, or pick both. A dashed swatch is automatic; ↺ makes a picked one automatic again.</p>' +
        '<h4>Walls</h4>' + wallSettingRows(c) +
        '<h4>Dimensions</h4>' + dimSettingRows(c) +
        '<h4>Objects</h4>' + objectSettingRows(c) +
        '<h4>Titles</h4>' + titleSettingRows(c) +
        '<p>Object settings can also be set per layer (select a layer, then the cog).</p>' +
        '<h4>Google Fonts</h4>' +
        '<div class="gfont-add"><input type="text" data-gfont placeholder="Font name, e.g. Roboto" autocomplete="off" spellcheck="false"><button data-act="addGoogleFont">Add</button></div>' +
        (st.googleFonts.length ? '<ul class="hidden-dims">' + st.googleFonts.map(n =>
          `<li><span style="font-family:${fontCss('g:' + n)}">${n}</span><button data-act="removeGoogleFont" data-font="${n}">Remove</button></li>`).join('') + '</ul>' : '') +
        '<p>Added fonts appear in the Font lists above. They are loaded from Google, so they need an internet connection.</p>' +
        '<p>Settings are saved with this plan. New plans start with the same settings.</p>' +
        '<div class="row"><button data-act="resetSettings">Reset to defaults</button><button data-act="closeSettings" class="primary">Done</button></div>';
    } else if (OPENING_TOOLS.includes(tool)) {
      h = `<h3>New ${TITLES[tool].toLowerCase()}</h3>${openingFields(tool, defaults[tool])}<p>Click on a wall to place it. The side of the wall you click on sets the ${tool === 'window' ? 'sill side' : 'opening direction'}.</p>`;
    } else if (tool === 'title') {
      h = `<h3>New title</h3><p>Click on the plan to place a title. It goes on the highlighted layer: “${esc(titleTargetLayer().name)}”.</p>`;
    } else if (tool === 'compass') {
      h = '<h3>New compass rose</h3><p>Click on the plan to place it. It belongs to the Dimensions layer; turn it so that N points to north.</p>';
    } else if (tool === 'mark') {
      h = '<h3>New ceiling height mark</h3>' + field('Ceiling height', 'height', defaults.mark.height) +
        '<p>Click on the plan to place the mark. It belongs to the Dimensions layer and uses the dimension font and colours.</p>';
    } else if (tool === 'ellipse') {
      h = '<h3>Round object</h3><p>Drag to draw a circle or oval, or click to drop a standard one.</p><p>Objects do not attach to walls.</p>';
    } else if (tool === 'polygon') {
      h = '<h3>Polygon object</h3><p>Click to place each corner. Finish by clicking the first corner again, double-clicking, or pressing Enter.</p><p>Esc discards the corners placed so far.</p>';
    } else if (tool === 'object') {
      h = '<h3>Object</h3><p>Drag to draw a rectangle, or click to drop a standard one. Use it for furniture, appliances and the like.</p><p>Objects do not attach to walls.</p>';
    } else if (tool === 'wall') {
      h = '<h3>Wall</h3><p>Drag to draw a rectangle. Rectangles that touch or overlap merge into one wall.</p><p>Hold Alt to draw without snapping.</p>';
    } else if (sel && sel.kind === 'title') {
      const inherited = Object.assign({}, doc.settings, (layerById(obj.layer) || {}).settings);
      const fontName = (fontChoices().find(([k]) => k === inherited.titleFont) || ['', 'System'])[1];
      h = '<h3>Title</h3>' +
        `<label class="field">Text<input type="text" data-ttext value="${esc(obj.text)}"></label>` +
        `<label class="field">Layer<select data-tlayer>${doc.layers.slice().reverse().map(l => `<option value="${esc(l.id)}"${l.id === obj.layer ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` +
        field('X', 'x', obj.x) + field('Y', 'y', obj.y) +
        `<label class="field">Font<select data-tfont><option value="">Default (${esc(fontName)})</option>${fontChoices().map(([v, t]) => `<option value="${esc(v)}"${obj.font === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>` +
        `<label class="field">Font size<input type="number" min="6" max="200" data-tsize placeholder="${inherited.titleFontSize}" value="${obj.fontSize || ''}"><span>px</span></label>` +
        colourRow('Font colour', 'data-tcol', 'fontColor', obj.fontColor, titlePairs(obj), 'ink') +
        (obj.font || obj.fontSize || obj.fontColor ? '<div class="row"><button data-act="defaultTitleStyle">Use default style</button></div>' : '<p>Using the title style of its layer.</p>') +
        descriptionField() +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'compass') {
      h = '<h3>Compass rose</h3>' + field('X', 'x', obj.x) + field('Y', 'y', obj.y) + field('Size', 'size', obj.size) +
        `<label class="field">Rotation<input type="number" step="15" data-rot value="${obj.rot}"><span>°</span></label>` +
        '<div class="row"><button data-act="rotateLeft">⟲ 90°</button><button data-act="rotateRight">⟳ 90°</button></div>' +
        '<p>Drag to move, drag a corner to resize and the round handle to rotate (Alt for free angle).</p>' +
        descriptionField() +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'mark') {
      h = '<h3>Ceiling height mark</h3>' + field('Ceiling height', 'height', obj.height) + field('X', 'x', obj.x) + field('Y', 'y', obj.y) +
        '<p>Drag or use the arrow keys to move it.</p>' +
        descriptionField() +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'object') {
      h = '<h3>Object</h3>' +
        `<label class="field">Name<input type="text" data-name value="${esc(obj.name)}" placeholder="e.g. Sofa"></label>` +
        field('Centre X', 'x', obj.x) + field('Centre Y', 'y', obj.y) +
        (obj.shape === 'polygon'
          ? `<p>${obj.points.length} corners, ${fmt(obj.w)} × ${fmt(obj.h)} ${doc.units} overall. Drag a square to move a corner; drag a dot on an edge to add one; click a square, then Delete, to remove it.</p>` +
            `<div class="row"><button data-act="delVertex" ${vertexSel && vertexSel.id === obj.id && obj.points.length > 3 ? '' : 'disabled'}>Delete selected corner</button></div>`
          : field('Width', 'w', obj.w) + field('Height', 'h', obj.h)) +
        `<label class="field">Rotation<input type="number" step="15" data-rot value="${obj.rot}"><span>°</span></label>` +
        `<label class="field">Layer<select data-olayer>${doc.layers.slice().reverse().filter(l => l.kind === 'objects').map(l => `<option value="${esc(l.id)}"${l.id === obj.layer ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>` +
        `<label class="field">Fill style<select data-ofill="fillStyle"><option value="">Default (${FILLS[objSettings(obj).objFillStyle]})</option>${Object.entries(FILLS).map(([v, t]) => `<option value="${v}"${obj.fillStyle === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>` +
        colourRow('Fill colour', 'data-ofill', 'fillColor', obj.fillColor, fillPairs(obj), 'objFill') +
        (obj.fillStyle || obj.fillColor ? '<div class="row"><button data-act="defaultFill">Use default fill</button></div>' : '<p>Using the default fill of its layer.</p>') +
        `<label class="check"><input type="checkbox" data-oflag="hideName"${obj.hideName ? ' checked' : ''}> Hide name on plan</label>` +
        `<label class="check"><input type="checkbox" data-oflag="hideSize"${obj.hideSize ? ' checked' : ''}> Hide dimensions on plan</label>` +
        (obj.shape ? '' :
        '<h4>Dimensions on plan</h4><table class="measure"><tr><th></th><th>L</th><th>R</th><th>T</th><th>B</th></tr>' +
        [['size', 'Side length', 'Length of this side, drawn outside the object'],
          ['object', 'To object', 'Gap straight out from this side to the nearest other object'],
          ['wall', 'To wall', 'Gap straight out from this side to the nearest wall']].map(([type, label, tip]) =>
          `<tr title="${tip}"><td>${label}</td>${'lrtb'.split('').map(k => `<td><input type="checkbox" data-measure="${type}" data-mside="${k}"${((obj.measure || {})[type] || '').includes(k) ? ' checked' : ''}></td>`).join('')}</tr>`).join('') +
        '</table><p>L, R, T, B are the object’s own sides and turn with it. These lines are drawn with the Dimensions layer.</p>') +
        descriptionField() +
        '<div class="row"><button data-act="rotateLeft">⟲ 90°</button><button data-act="rotateRight">⟳ 90°</button></div>' +
        '<p>Drag to move, drag the squares to resize and the round handle to rotate (Alt for free angle).</p>' +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'wall') {
      h = '<h3>Wall rectangle</h3>' + field('X', 'x', obj.x) + field('Y', 'y', obj.y) + field('Width', 'w', obj.w) + field('Height', 'h', obj.h) +
        descriptionField() +
        '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'opening') {
      h = `<h3>${TITLES[obj.type]}</h3>` + openingFields(obj.type, obj);
      if (obj.type === 'door') h += '<div class="row"><button data-act="flipHinge">Flip hinge</button><button data-act="flipSwing">Flip direction</button></div>';
      if (obj.type === 'window') h += '<div class="row"><button data-act="flipSill">Flip sill side</button></div>';
      if (!resolveOpening(obj).ok) h += '<p class="err">Not inside a wall — drag it onto one.</p>';
      h += descriptionField();
      h += '<div class="row"><button class="danger" data-act="delete">Delete</button></div>';
    } else if (sel && sel.kind === 'dim') {
      const real = realOf(obj);
      h = `<h3>Dimension</h3><p>Drawn: ${fmt(obj.len)} ${doc.units}</p>` +
        `<label class="field">Real size<input type="number" min="0" step="${UNITS[doc.units].step}" data-real placeholder="—" value="${real ? fmt(real) : ''}"><span>${doc.units}</span></label>` +
        '<p>A real size is shown instead of the drawn one, marked with *. It does not change the plan.</p>' +
        `<div class="row">${real ? '<button data-act="clearReal">Clear real size</button>' : ''}<button data-act="hideDim">Hide dimension</button></div>` +
        '<p>To bring it back, click the wall line it measures.</p>' +
        descriptionField();
    } else if (sel && sel.kind === 'edge') {
      const own = dimsOf(obj);
      const hiddenOnWall = allDims().filter(d => d.comp === obj.comp && isHidden(d.key)).length;
      h = `<h3>Wall line</h3><p>${fmt(obj.len)} ${doc.units}</p>` +
        `<label class="check"><input type="checkbox" data-act="toggleDim" ${own.some(d => !isHidden(d.key)) ? 'checked' : ''}> Show dimension${own.length > 1 ? 's' : ''}</label>` +
        `<div class="row"><button data-act="showWallDims" ${hiddenOnWall ? '' : 'disabled'}>Show all on this wall${hiddenOnWall ? ` (${hiddenOnWall})` : ''}</button>` +
        '<button data-act="hideWallDims">Hide all on this wall</button></div>' +
        descriptionField();
    } else {
      const hidden = allDims().filter(d => isHidden(d.key));
      h = '<h3>Floorplan</h3><p>Click a wall, door, window or dimension to edit it. Drag to move.</p>' +
        '<p>Click a dimension and press Delete to hide it.</p>' +
        `<details class="fold" data-fold="hiddenDims"${hiddenDimsOpen ? ' open' : ''}><summary>Hidden dimensions${hidden.length ? ` (${hidden.length})` : ''}</summary>`;
      if (!hidden.length) h += '<p>None.</p>';
      else {
        h += '<ul class="hidden-dims">' + hidden.map(d =>
          `<li data-dim="${d.key}"><span>${d.nx ? '↕' : '↔'} ${dimText(d)} ${doc.units}</span><button data-act="showDim">Show</button></li>`).join('') +
          '</ul><p>Point at a row to see where it is on the plan.</p>';
      }
      h += '</details>';
    }
    // Rebuilding replaces every control, so keep the keyboard focus on the same field afterwards.
    const view = JSON.stringify([tool, sel, showSettings, layerPanel, selLocked()]);
    const active = panel.contains(document.activeElement) ? document.activeElement : null;
    // A dropdown or colour picker that was just opened would be closed by a rebuild; it refreshes on its own change.
    if (active && active !== panelSource && view === panelView && (active.tagName === 'SELECT' || active.type === 'color')) return;
    const key = active && controlKey(active);
    const caret = active && (active.type === 'text' || active.tagName === 'TEXTAREA') ? [active.selectionStart, active.selectionEnd] : null;
    panelView = view;
    const locked = selLocked() && tool === 'select';
    panel.innerHTML = locked ? `<p class="locked">🔒 ${esc(lockedNote())}</p>` + h : h;
    if (locked) for (const el of panel.querySelectorAll('input, select, textarea, button')) el.disabled = true;
    const again = key && panel.querySelector(key);
    if (again) {
      again.focus();
      if (caret) again.setSelectionRange(caret[0], caret[1]);
      else if (again.type === 'number') again.select();
    }
  }

  // A colour input edits one side of a pair; the other side is left as it is.
  const withSide = (pair, input) => Object.assign(toPair(pair), { [input.dataset.side]: input.value });

  function applyLayerSetting(input) {
    const layer = layerById(layerPanel), key = input.dataset.lset;
    if (input.dataset.side) { layer.settings[key] = withSide(layer.settings[key], input); return; }
    const value = input.type === 'number' ? Number(input.value) : input.value;
    layer.settings[key] = cleanSettings(Object.assign({}, doc.settings, { [key]: value }))[key];
  }
  function applySetting(input) {
    const key = input.dataset.set;
    const value = input.dataset.side ? withSide(doc.settings[key], input) : input.type === 'number' ? Number(input.value) : input.value;
    doc.settings = cleanSettings(Object.assign({}, doc.settings, { [key]: value }));
  }
  function applyObjectFill(input) {
    const o = selectedObject(), key = input.dataset.ofill;
    if (input.dataset.side) o[key] = withSide(o[key], input);
    else if (input.value) o[key] = input.value; else delete o[key];
  }
  // Applies one side-panel control to the plan. `live` is true while the user is still typing.
  // Returns 'doc' if the plan changed, 'defaults' if a tool default changed, null if nothing was applied.
  function applyPanelInput(el, live) {
    const ds = el.dataset;
    if (live && el.type === 'number' && el.value.trim() === '') return null;   // half-typed number: wait for a digit
    const object = sel && sel.kind === 'object' ? selectedObject() : null;
    if (ds.ofill && object) { applyObjectFill(el); return 'doc'; }
    if (ds.lset && layerPanel) { applyLayerSetting(el); return 'doc'; }
    if ('lname' in ds && layerPanel) {
      const layer = layerById(layerPanel), name = el.value.trim();
      if (name) layer.name = name;
      return 'doc';
    }
    if (ds.measure && object) {
      const m = object.measure || {}, sides = new Set((m[ds.measure] || '').split(''));
      if (el.checked) sides.add(ds.mside); else sides.delete(ds.mside);
      if (sides.size) m[ds.measure] = 'lrtb'.split('').filter(k => sides.has(k)).join(''); else delete m[ds.measure];
      if (Object.keys(m).length) object.measure = m; else delete object.measure;
      return 'doc';
    }
    if (ds.oflag && object) {
      if (el.checked) object[ds.oflag] = true; else delete object[ds.oflag];
      return 'doc';
    }
    if ('olayer' in ds && object) { object.layer = el.value; return 'doc'; }
    // Text is trimmed only once editing ends, so spaces can be typed mid-name.
    if ('name' in ds && object) { object.name = live ? el.value : el.value.trim(); return 'doc'; }
    if ('desc' in ds && sel) {
      const text = live ? el.value : el.value.trim();
      if (sel.kind === 'dim' || sel.kind === 'edge') {
        if (text) doc.descriptions[keyedNote()] = text; else delete doc.descriptions[keyedNote()];
        return 'doc';
      }
      const target = selectedObject();
      if (!target) return null;
      if (text || sel.kind === 'object') target.description = text; else delete target.description;
      return 'doc';
    }
    if ('rot' in ds && sel && (sel.kind === 'object' || sel.kind === 'compass')) {
      const turned = selectedObject();
      if (!turned) return null;
      turned.rot = normAngle(Number(el.value) || 0);
      return 'doc';
    }
    const title = sel && sel.kind === 'title' ? selectedObject() : null;
    if (title) {
      if ('ttext' in ds) { title.text = live ? el.value : el.value.trim() || 'Title'; return 'doc'; }
      if ('tlayer' in ds) { title.layer = el.value; return 'doc'; }
      if ('tfont' in ds) { if (el.value) title.font = el.value; else delete title.font; return 'doc'; }
      if ('tsize' in ds) {
        const size = Math.round(Number(el.value) || 0);
        if (size > 0) title.fontSize = Math.min(Math.max(size, 6), 200); else delete title.fontSize;
        return 'doc';
      }
      if (ds.tcol) { title.fontColor = withSide(title.fontColor, el); return 'doc'; }
    }
    if (ds.set) { applySetting(el); return 'doc'; }
    if ('real' in ds && sel && sel.kind === 'dim') {
      const mm = Math.round((Number(el.value) || 0) * UNITS[doc.units].factor);
      if (mm > 0) doc.realDimensions[sel.key] = mm; else delete doc.realDimensions[sel.key];
      return 'doc';
    }
    const k = ds.k;
    if (!k) return null;
    const toolMode = tool in defaults;
    const target = toolMode ? defaults[tool] : selectedObject();
    if (!target) return null;
    let v = Math.round((Number(el.value) || 0) * UNITS[doc.units].factor);
    if (k !== 'x' && k !== 'y') v = Math.max(v, k === 'sillDepth' ? 0 : 10);
    target[k] = v;
    return toolMode ? 'defaults' : 'doc';
  }

  // Every keystroke updates the plan at once; the panel itself is left alone so the field keeps focus.
  panel.addEventListener('input', e => {
    const changed = applyPanelInput(e.target, true);
    if (changed === 'doc') { liveDirty = true; rebuild(); renderLayers(); render(); }
    else if (changed === 'defaults') localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
  });

  const normAngle = a => ((Math.round(a) % 360) + 360) % 360;

  // Leaving the field (or Enter) makes the edit final: one undo step, saved, panel refreshed.
  // Only the panel refresh waits a tick so that, when the user is moving to another field, focus has landed there first.
  panel.addEventListener('change', e => {
    const src = e.target, changed = applyPanelInput(src, false);
    if (!changed) return;
    if (changed === 'defaults') localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
    else if (changed === 'doc') { liveDirty = false; commit(true); }
    setTimeout(() => {
      panelSource = src;
      renderPanel();
      render();
      panelSource = null;
    }, 0);
  });

  // Clicking anywhere outside the panel also makes typed changes final, even if the field never reports a change.
  document.addEventListener('pointerdown', e => {
    if (!liveDirty || panel.contains(e.target)) return;
    liveDirty = false;
    commit();
  }, true);

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
  // toggle does not bubble, so it is caught on the way down; the state survives panel redraws
  panel.addEventListener('toggle', e => { if (e.target.dataset.fold === 'hiddenDims') hiddenDimsOpen = e.target.open; }, true);

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
    if (act === 'defaultFill') { delete obj.fillStyle; delete obj.fillColor; }
    if (act === 'delVertex') return deleteSelection();
    if (act === 'defaultTitleStyle') { delete obj.font; delete obj.fontSize; delete obj.fontColor; }
    if (act === 'autoColour') {
      // Back to automatic for one side; an override with nothing left set is dropped altogether.
      const { level, key, side } = e.target.dataset;
      const holder = level === 'data-set' ? doc.settings : level === 'data-lset' ? layerById(layerPanel).settings : obj;
      const pair = Object.assign(toPair(holder[key]), { [side]: null });
      if (level === 'data-set' || pairSet(pair)) holder[key] = pair; else delete holder[key];
    }
    if (act === 'rotateLeft') obj.rot = normAngle(obj.rot - 90);
    if (act === 'rotateRight') obj.rot = normAngle(obj.rot + 90);
    if (act === 'resetSettings') doc.settings = defaultSettings();
    if (act === 'closeSettings') showSettings = false;
    if (act === 'closeLayerPanel') layerPanel = null;
    if (act === 'clearLayerSettings') layerById(layerPanel).settings = {};
    if (act === 'clearReal') delete doc.realDimensions[sel.key];
    if (act === 'showDim') {
      setHidden([e.target.closest('[data-dim]').dataset.dim], false);
      previewDim = null;
    }
    commit();
  });

  function deleteSelection() {
    if (!sel) return;
    if (selLocked()) return toast(lockedNote());
    // With a polygon corner picked, Delete removes that corner rather than the whole object.
    if (sel.kind === 'object' && vertexSel && vertexSel.id === sel.id) {
      const o = selectedObject();
      if (o && o.shape === 'polygon' && o.points.length > 3) {
        o.points.splice(vertexSel.index, 1);
        normalisePolygon(o);
        vertexSel = null;
        return commit();
      }
    }
    if (sel.kind === 'wall') doc.walls = doc.walls.filter(w => w.id !== sel.id);
    else if (sel.kind === 'object') doc.objects = doc.objects.filter(o => o.id !== sel.id);
    else if (sel.kind === 'mark') doc.marks = doc.marks.filter(m => m.id !== sel.id);
    else if (sel.kind === 'title') doc.titles = doc.titles.filter(t => t.id !== sel.id);
    else if (sel.kind === 'compass') doc.compasses = doc.compasses.filter(c => c.id !== sel.id);
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
    select: 'Click to select · drag or arrow keys to move · scroll to zoom · drag empty space or Shift-scroll to pan · Delete removes',
    wall: 'Drag to draw a wall rectangle · Alt disables snapping · Esc to finish',
    object: 'Drag to draw an object, or click to drop one · Esc to cancel',
    ellipse: 'Drag to draw a round object, or click to drop one · Esc to cancel',
    polygon: 'Click each corner · click the first corner, double-click or press Enter to finish · Esc to discard',
    mark: 'Click to place a ceiling height mark · Esc to finish',
    title: 'Click to place a title on the highlighted layer · Esc to cancel',
    compass: 'Click to place a compass rose · Esc to cancel',
    door: 'Click a wall to place a door · Esc to finish',
    doorway: 'Click a wall to place a doorway · Esc to finish',
    window: 'Click a wall to place a window · Esc to finish',
  };

  function setTool(t) {
    tool = t;
    polyDraft = [];
    polyHover = null;
    ghost = null;
    drag = null;
    if (t !== 'select') sel = null;
    svg.setAttribute('class', 'tool-' + t);
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('active', b.dataset.tool === t);
    $('#hint').textContent = HINTS[t];
    renderAll();
  }

  function renderAll(keepPanel) {
    loadGoogleFonts();
    renderLayers();
    if (!keepPanel) renderPanel();   // may drop a selection that is no longer allowed, so it runs before drawing
    render();
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
    if (selLocked()) return toast(lockedNote());
    if (sel.kind === 'wall') {
      const riders = doc.openings.filter(o => o.x >= obj.x && o.x <= obj.x + obj.w && o.y >= obj.y && o.y <= obj.y + obj.h);
      obj.x += dx; obj.y += dy;
      for (const o of riders) { o.x += dx; o.y += dy; }
      rebuild();
      remapHidden(dx, dy);
      commit();
    } else if (['object', 'mark', 'title', 'compass'].includes(sel.kind)) {
      obj.x += dx; obj.y += dy;
      commit();
    } else if (sel.kind === 'opening') {
      const x = obj.x + (obj.axis === 'h' ? dx : 0), y = obj.y + (obj.axis === 'v' ? dy : 0);
      if ((x === obj.x && y === obj.y) || !walls.extent(x, y)) return;   // stay inside the wall
      obj.x = x; obj.y = y;
      commit();
    }
  }

  // Turns the corners clicked with the polygon tool into an object and selects it.
  function finishPolygon() {
    const pts = polyDraft.filter((p, i) => !i || p[0] !== polyDraft[i - 1][0] || p[1] !== polyDraft[i - 1][1]);
    if (pts.length < 3) return toast('A polygon needs at least three corners.');
    const o = { id: doc.nextId++, name: '', description: '', x: 0, y: 0, w: 0, h: 0, rot: 0, layer: targetLayer().id, shape: 'polygon', points: pts };
    normalisePolygon(o);
    doc.objects.push(o);
    setTool('select');
    sel = { kind: 'object', id: o.id };
    commit();
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
    const toolLayer = tool in OBJECT_TOOLS ? targetLayer() : tool === 'title' ? titleTargetLayer()
      : tool === 'mark' || tool === 'compass' ? specialLayer('dimensions') : tool !== 'select' ? specialLayer('walls') : null;
    if (toolLayer && whyBlocked(toolLayer)) return toast(whyBlocked(toolLayer));
    if (tool === 'wall') {
      const a = snapPoint(w, e);
      drag = { kind: 'newwall', a, b: a };
      return;
    }
    if (tool === 'title' || tool === 'compass') {
      const base = { id: doc.nextId++, x: snapv(w.x, e), y: snapv(w.y, e) };
      const made = tool === 'title' ? Object.assign(base, { text: 'Title', layer: titleTargetLayer().id }) : Object.assign(base, { size: 1000, rot: 0 });
      (tool === 'title' ? doc.titles : doc.compasses).push(made);
      const kind = tool;
      setTool('select');
      sel = { kind, id: made.id };
      return commit();
    }
    if (tool === 'mark') {
      doc.marks.push({ id: doc.nextId++, x: snapv(w.x, e), y: snapv(w.y, e), height: defaults.mark.height });
      return commit();
    }
    if (tool === 'polygon') {
      const pt = [snapv(w.x, e), snapv(w.y, e)], first = polyDraft[0] && S(polyDraft[0][0], polyDraft[0][1]);
      if (polyDraft.length >= 3 && Math.hypot(first[0] - p.x, first[1] - p.y) <= 9) return finishPolygon();
      polyDraft.push(pt);
      return render();
    }
    if (tool === 'object' || tool === 'ellipse') {
      const a = { x: snapv(w.x, e), y: snapv(w.y, e) };
      drag = { kind: 'newobject', a, b: a, shape: OBJECT_TOOLS[tool] };
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

    // Select tool: handles of the current selection first, then whatever is on top.
    if (sel && sel.kind === 'wall' && !selLocked()) {
      const rect = selectedObject();
      const hp = rect && handlePoints(rect).find(h => Math.abs(h.p[0] - p.x) <= 6 && Math.abs(h.p[1] - p.y) <= 6);
      if (hp) {
        drag = { kind: 'resize', rect, handle: hp.id, orig: Object.assign({}, rect) };
        return;
      }
    }
    if (sel && sel.kind === 'compass' && !selLocked()) {
      const c = selectedObject();
      const hp = c && compassHandles(c).find(h => Math.abs(h.p[0] - p.x) <= 7 && Math.abs(h.p[1] - p.y) <= 7);
      if (hp) {
        drag = hp.id === 'rot' ? { kind: 'rotateobject', o: c } : { kind: 'resizecompass', o: c };
        return;
      }
    }
    if (sel && sel.kind === 'object' && !selLocked()) {
      const obj = selectedObject();
      const hp = obj && objectHandles(obj).find(h => h.id !== 'top' && Math.abs(h.p[0] - p.x) <= 7 && Math.abs(h.p[1] - p.y) <= 7);
      if (hp && hp.id === 'rot') { drag = { kind: 'rotateobject', o: obj }; return; }
      if (hp && (hp.id === 'v' || hp.id === 'm')) {
        // A corner is picked (for Delete) and can be dragged; an edge dot becomes a new corner first.
        let index = hp.index;
        if (hp.id === 'm') {
          const a = obj.points[index], b = obj.points[(index + 1) % obj.points.length];
          obj.points.splice(++index, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
        vertexSel = { id: obj.id, index };
        drag = { kind: 'movevertex', o: obj, index };
        return renderAll();
      }
      if (hp) {
        drag = { kind: 'resizeobject', o: obj, sx: hp.fx * 2 - 1, sy: hp.fy * 2 - 1, orig: Object.assign({}, obj) };
        return;
      }
    }
    vertexSel = null;
    // The topmost layer under the pointer wins; hidden layers are passed through.
    // On a frozen layer things can be selected (to look at them) but no drag starts.
    for (const layer of doc.layers.slice().reverse()) {
      if (!layer.visible) continue;
      const free = !layer.frozen;
      const title = hitTitle(p, layer.id);   // titles sit on top of everything else in their layer
      if (title) {
        sel = { kind: 'title', id: title.id };
        if (free) drag = { kind: 'moveobject', o: title, w0: w, orig: { x: title.x, y: title.y } };
        return renderAll();
      }
      if (layer.kind === 'objects') {
        const thing = hitObject(w, layer.id);
        if (thing) {
          sel = { kind: 'object', id: thing.id };
          if (free) drag = { kind: 'moveobject', o: thing, w0: w, orig: { x: thing.x, y: thing.y } };
          return renderAll();
        }
      } else if (layer.kind === 'dimensions') {
        const compass = hitCompass(w);
        if (compass) {
          sel = { kind: 'compass', id: compass.id };
          if (free) drag = { kind: 'moveobject', o: compass, w0: w, orig: { x: compass.x, y: compass.y } };
          return renderAll();
        }
        const mark = hitMark(p);
        if (mark) {
          sel = { kind: 'mark', id: mark.id };
          if (free) drag = { kind: 'movemark', o: mark, w0: w, orig: { x: mark.x, y: mark.y } };
          return renderAll();
        }
        const dim = hitDim(p);
        if (dim) {
          sel = { kind: 'dim', key: dim.key };
          return renderAll();
        }
      } else {
        const o = hitOpening(w);
        if (o) {
          sel = { kind: 'opening', id: o.id };
          if (free) drag = { kind: 'moveopening', o };
          return renderAll();
        }
        const edge = hitEdge(p);
        if (edge) {
          sel = { kind: 'edge', key: edge.key };
          if (free) drag = { kind: 'pending', p, w0: w, rect: hitRect(w, 5) };
          return renderAll();
        }
        const rect = hitRect(w);
        if (rect) {
          if (free) startMoveWall(rect, w); else sel = { kind: 'wall', id: rect.id };
          return renderAll();
        }
      }
    }
    sel = null;
    drag = { kind: 'pan', p, ox: view.ox, oy: view.oy };
    renderAll();
  });

  svg.addEventListener('pointermove', e => {
    const p = pointer(e), w = toWorld(p);
    $('#coords').textContent = `x ${fmt(w.x)}  y ${fmt(w.y)} ${doc.units}`;

    if (!drag) {
      if (tool === 'polygon' && polyDraft.length) {
        polyHover = [snapv(w.x, e), snapv(w.y, e)];
        render();
      }
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
    } else if (drag.kind === 'moveobject' || drag.kind === 'movemark') {
      drag.o.x = drag.orig.x + snapv(w.x - drag.w0.x, e);
      drag.o.y = drag.orig.y + snapv(w.y - drag.w0.y, e);
    } else if (drag.kind === 'rotateobject') {
      const step = e.altKey ? 1 : 15;
      const ang = Math.atan2(w.y - drag.o.y, w.x - drag.o.x) * 180 / Math.PI + 90;
      drag.o.rot = normAngle(Math.round(ang / step) * step);
    } else if (drag.kind === 'movevertex') {
      const l = objToLocal(drag.o, { x: snapv(w.x, e), y: snapv(w.y, e) });
      drag.o.points[drag.index] = [l.x, l.y];
    } else if (drag.kind === 'resizecompass') {
      // The centre stays put; the dragged corner sets the diameter.
      const l = objToLocal(drag.o, w);
      drag.o.size = Math.max(100, snapv(2 * Math.max(Math.abs(l.x), Math.abs(l.y)), e));
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
    if (d.kind === 'movevertex') {
      normalisePolygon(d.o);
      return commit();
    }
    if (d.kind === 'newobject') {
      let r = dragRect(d);
      if (!r.w || !r.h) r = { x: d.a.x - 500, y: d.a.y - 300, w: 1000, h: 600 };   // plain click: standard size
      const o = { id: doc.nextId++, name: '', description: '', x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, rot: 0, layer: targetLayer().id };
      if (d.shape) o.shape = d.shape;
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
    if (['resize', 'moveopening', 'moveobject', 'resizeobject', 'rotateobject', 'movemark', 'resizecompass'].includes(d.kind)) return commit();
    render();
  }
  svg.addEventListener('dblclick', () => { if (tool === 'polygon' && polyDraft.length) finishPolygon(); });
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('pointerleave', () => { if (ghost) { ghost = null; render(); } });

  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const p = pointer(e);
    if (e.shiftKey) {
      // Shift + scroll pans; a mouse wheel reports its movement on either axis depending on the browser.
      view.ox -= e.deltaX;
      view.oy -= e.deltaY;
      render();
    } else {
      // Scrolling zooms about the pointer. Pinch gestures arrive as ctrl + wheel with much smaller steps.
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea, dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); stepHistory(e.shiftKey ? 1 : -1); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); stepHistory(1); return; }
    if (mod) return;
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
    if (e.key === 'Enter' && tool === 'polygon' && polyDraft.length) { e.preventDefault(); finishPolygon(); return; }
    if (e.key === 'Escape') {
      if (tool === 'polygon' && polyDraft.length) { polyDraft = []; polyHover = null; render(); }
      else if (tool !== 'select') setTool('select');
      else { sel = null; renderAll(); }
      return;
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow) {
      if (sel && ['wall', 'opening', 'object', 'mark', 'title', 'compass'].includes(sel.kind)) { e.preventDefault(); nudgeSelection(arrow[0] * snap, arrow[1] * snap); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    const t = { v: 'select', w: 'wall', d: 'door', o: 'doorway', n: 'window', b: 'object', e: 'ellipse', g: 'polygon', h: 'mark', t: 'title', c: 'compass' }[e.key.toLowerCase()];
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
    layerPanel = null;
    if (tool !== 'select') setTool('select');
    showSettings = open;
    renderAll();
  };
  $('#btnMode').onclick = () => {
    appearance.mode = currentMode() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('floorplan-appearance', JSON.stringify(appearance));
    applyAppearance();
    renderAll();
  };
  // The calculator is tucked away until asked for; the choice is remembered.
  function showCalculator(on) {
    $('#calc').hidden = !on;
    $('#btnCalc').classList.toggle('on', on);
    localStorage.setItem('floorplan-calc', on ? '1' : '');
  }
  $('#btnCalc').onclick = () => showCalculator($('#calc').hidden);
  showCalculator(localStorage.getItem('floorplan-calc') === '1');
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
    const { format, version, ...rest } = doc;
    const name = fileName, text = JSON.stringify({ format, version, app: APP, ...rest }, null, 2) + '\n', folder = dir;
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

  // ---------- Export (PNG / PDF) ----------
  // The plan is rebuilt as a standalone SVG, drawn onto a large canvas and saved as PNG,
  // or wrapped as a single lossless image page in a PDF written by hand (no libraries).

  const EXPORT_MARGIN = 24;   // px of white around the plan, in screen units

  // Google fonts must travel inside the SVG: an SVG drawn as an image cannot load anything external.
  async function embeddedFontCss(body) {
    const used = new Set();
    const keys = [doc.settings.dimFont, doc.settings.objFont, doc.settings.titleFont]
      .concat(doc.layers.flatMap(l => l.settings ? [l.settings.objFont, l.settings.titleFont] : []), doc.titles.map(t => t.font));
    for (const k of keys) if (k && k.startsWith('g:')) used.add(k.slice(2));
    if (!used.size) return '';
    const chars = Array.from(new Set(body.replace(/<[^>]*>/g, ''))).map(c => c.codePointAt(0));
    const inRange = block => {
      const m = /unicode-range:([^;}]+)/.exec(block);
      if (!m) return true;
      return m[1].split(',').some(part => {
        const r = /U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?/.exec(part);
        if (!r || r[1].includes('?')) return true;
        const lo = parseInt(r[1], 16), hi = r[2] ? parseInt(r[2], 16) : lo;
        return chars.some(c => c >= lo && c <= hi);
      });
    };
    const toDataUrl = blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
    let css = '';
    for (const name of used) {
      for (const weight of ['', ':wght@700']) {
        try {
          const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}${weight}&display=swap`;
          const res = await fetch(url);
          if (!res.ok) continue;
          for (const block of (await res.text()).match(/@font-face\s*{[^}]*}/g) || []) {
            if (!inRange(block)) continue;
            const src = /url\(([^)]+)\)/.exec(block);
            if (!src) continue;
            const data = await toDataUrl(await (await fetch(src[1].replace(/["']/g, ''))).blob());
            css += block.replace(src[0], `url(${data})`);
          }
        } catch (err) { /* offline or blocked: that weight falls back to a default font */ }
      }
    }
    return css;
  }

  async function buildExportSvg(lightColours) {
    const keep = sel, keepPal = pal, keepMode = palMode;
    sel = null;                 // no selection highlight or handles in the export
    if (lightColours) setPalette(PALETTES.light.canvas, 'light');
    const paper = PAPER;
    let body;
    try { body = layersSvg(); } finally { sel = keep; setPalette(keepPal, keepMode); }
    // Measure the drawing in a hidden SVG so labels and dimension lines are included in the frame.
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    probe.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden');
    probe.innerHTML = `<g>${body}</g>`;
    document.body.appendChild(probe);
    const bb = probe.firstChild.getBBox();
    probe.remove();
    if (!bb.width || !bb.height) return null;
    const x = bb.x - EXPORT_MARGIN, y = bb.y - EXPORT_MARGIN, w = bb.width + 2 * EXPORT_MARGIN, hgt = bb.height + 2 * EXPORT_MARGIN;
    const fonts = await embeddedFontCss(body);
    const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="${x} ${y} ${w} ${hgt}">` +
      `<style>${fonts}</style><rect x="${x}" y="${y}" width="${w}" height="${hgt}" fill="${paper}"/>${body}</svg>`;
    return { svgText, w, h: hgt, paper };
  }

  async function renderExportCanvas(longSide, lightColours) {
    const built = await buildExportSvg(lightColours);
    if (!built) return null;
    const k = longSide / Math.max(built.w, built.h);
    const url = URL.createObjectURL(new Blob([built.svgText], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(built.w * k);
      canvas.height = Math.round(built.h * k);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = built.paper;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Pixels as zlib-compressed RGB, fed in strips so a large canvas never needs one huge buffer.
  async function canvasToFlateRgb(canvas) {
    const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter();
    const result = new Response(cs.readable).arrayBuffer();
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, STRIP = 256;
    for (let y = 0; y < H; y += STRIP) {
      const rows = Math.min(STRIP, H - y), src = ctx.getImageData(0, y, W, rows).data, rgb = new Uint8Array(W * rows * 3);
      for (let i = 0, j = 0; i < src.length; i += 4) { rgb[j++] = src[i]; rgb[j++] = src[i + 1]; rgb[j++] = src[i + 2]; }
      await writer.write(rgb);
    }
    await writer.close();
    return new Uint8Array(await result);
  }

  // One page holding the image at 300 dpi.
  async function canvasToPdf(canvas) {
    const data = await canvasToFlateRgb(canvas);
    const W = canvas.width, H = canvas.height, pw = (W * 72 / 300).toFixed(2), ph = (H * 72 / 300).toFixed(2);
    const enc = new TextEncoder(), parts = [], offsets = [];
    let length = 0;
    const push = chunk => { const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk; parts.push(bytes); length += bytes.length; };
    const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`));
    obj(4, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(5, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream');
    });
    const xref = length;
    push('xref\n0 6\n0000000000 65535 f \n' + [1, 2, 3, 4, 5].map(n => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join(''));
    push(`trailer\n<< /Size 6 /Root 1 0 R /Info << /Producer (${APP.name} ${APP.version}) >> >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function exportPlan(format, longSide, lightColours) {
    toast('Exporting…');
    try {
      const canvas = await renderExportCanvas(longSide, lightColours);
      if (!canvas) return toast('Nothing to export — the plan is empty or all layers are hidden.');
      const blob = format === 'pdf' ? await canvasToPdf(canvas) : await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('the image is too large for this browser — try a lower resolution');
      const base = (fileName || 'floorplan.json').replace(/\.json$/i, '');
      downloadBlob(blob, `${base}.${format}`);
      toast(`Exported ${base}.${format} (${canvas.width} × ${canvas.height} px)`);
    } catch (err) {
      toast('Export failed: ' + err.message);
    }
  }

  $('#btnExport').onclick = () => {
    $('#exportDlg').returnValue = '';   // so Esc after an earlier export does not export again
    $('#exportDlg').showModal();
  };
  $('#exportDlg').addEventListener('close', () => {
    if ($('#exportDlg').returnValue === 'ok') exportPlan($('#exportFormat').value, Number($('#exportSize').value), $('#exportColours').value === 'light');
  });

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

  systemDark.addEventListener('change', () => { applyAppearance(); renderAll(); });

  // ---------- Start ----------

  $('#brand').href = APP.repository;
  $('#brand').title = `${APP.name} ${APP.version} (${APP.commit}) — open the repository on GitHub`;


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
