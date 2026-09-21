// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  stops:      {},   // slug → {name, lat, lon}
  network:    {},   // route_name → {name, directions: [[slug,…],…]}
  challenges: [],   // [{id, from, to, difficulty}]
  routeStops: {},   // route_name → Set<slug>
  stopRoutes: {},   // slug → Set<route_name>
  adjacency:  {},   // slug → [{to: slug, via: route_name}] — consecutive stop pairs

  difficulty: localStorage.getItem('kmq_diff') ?? 'easy',
  lang:       localStorage.getItem('kmq_lang') ?? 'pl',
  solved:     new Set(JSON.parse(localStorage.getItem('kmq_solved') ?? '[]')),

  challenge:  null,
  userLines:  [],
  submitted:  false,
};

// ── Plurals ───────────────────────────────────────────────────────────────────

function _plLine(n) {
  if (n === 1) return 'linia';
  const m10 = n % 10, m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'linie';
  return 'linii';
}

function _plStop(n) {
  if (n === 1) return 'przystanek';
  const m10 = n % 10, m100 = n % 100;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'przystanki';
  return 'przystanków';
}

// ── Translations ──────────────────────────────────────────────────────────────

const LANG = {
  pl: {
    appTitle:    'Krakowski Szybki Tramwaj',
    diffLabel:   { easy: 'Łatwy', normal: 'Średni', hard: 'Trudny' },
    loading:     'Ładowanie danych…',
    loadError:   (msg) => `Błąd wczytywania danych: ${msg}`,
    labelFrom:   'Skąd',
    labelTo:     'Dokąd',
    labelRoute:  'Twoja trasa',
    labelLines:  'Linie',
    submit:      'Sprawdź',
    nextBtn:     'Następne →',
    resetDiff:   'Resetuj poziom',
    routeHint:   'wybierz linię poniżej',
    allDone:     (diff) => {
      const d = { easy: 'łatwe', normal: 'średnie', hard: 'trudne' }[diff] ?? diff;
      return `Wszystkie ${d} wyzwania ukończone!`;
    },
    correct:     (_n) => 'Poprawna odpowiedź',
    wrongCount:  (u, o) => `Użyto ${u} ${_plLine(u)} — wystarczy ${o} ${_plLine(o)}.`,
    optimal:     (names) => `Optymalna trasa: ${names}`,
    linePrefix:  'linia ',
    xfer:        (name) => `przesiadka na ${name}`,
    tipDesc:     (desc, diff) => `Wskazówka: ${desc} jest o ${diff} ${_plStop(diff)} krótsze.`,
    validNoLines:  'Nie wybrano żadnej linii.',
    validNoServe:  (line, stop) => `Linia ${line} nie zatrzymuje się na ${stop}.`,
    validNoCommon: (l1, l2) => `Linie ${l1} i ${l2} nie mają wspólnego przystanku.`,
    mapFrom:     'Skąd',
    mapTo:       'Dokąd',
    mapLine:     (name) => `Linia ${name}`,
    mapSeg:      (line, from, to) => `Linia ${line}: ${from} → ${to}`,
  },
  en: {
    appTitle:    'Krakowski Szybki Tramwaj',
    diffLabel:   { easy: 'Easy', normal: 'Normal', hard: 'Hard' },
    loading:     'Loading data…',
    loadError:   (msg) => `Failed to load data: ${msg}`,
    labelFrom:   'From',
    labelTo:     'To',
    labelRoute:  'Your route',
    labelLines:  'Lines',
    submit:      'Submit',
    nextBtn:     'Next challenge →',
    resetDiff:   'Reset this difficulty',
    routeHint:   'tap a line below to start',
    allDone:     (diff) => `All ${diff} challenges solved!`,
    correct:     (n) => `Correct! ${n} line${n !== 1 ? 's' : ''} needed.`,
    wrongCount:  (u, o) => `${u} line${u !== 1 ? 's' : ''} used — only ${o} line${o !== 1 ? 's' : ''} needed.`,
    optimal:     (names) => `Optimal: ${names}`,
    linePrefix:  'line ',
    xfer:        (name) => `transfer at ${name}`,
    tipDesc:     (desc, diff) => `Tip: ${desc} is ${diff} stop${diff !== 1 ? 's' : ''} shorter.`,
    validNoLines:  'No lines selected.',
    validNoServe:  (line, stop) => `Line ${line} doesn't serve ${stop}.`,
    validNoCommon: (l1, l2) => `Lines ${l1} and ${l2} share no common stop.`,
    mapFrom:     'From',
    mapTo:       'To',
    mapLine:     (name) => `Line ${name}`,
    mapSeg:      (line, from, to) => `Line ${line}: ${from} → ${to}`,
  },
};

// ── Persistence ───────────────────────────────────────────────────────────────

function saveSolved() {
  localStorage.setItem('kmq_solved', JSON.stringify([...state.solved]));
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  const [stops, network, challenges] = await Promise.all([
    fetch('data/stops.json').then(r => r.json()),
    fetch('data/network.json').then(r => r.json()),
    fetch('data/challenges.json').then(r => r.json()),
  ]);

  state.stops      = stops;
  state.network    = network;
  state.challenges = challenges;

  for (const [name, data] of Object.entries(network)) {
    state.routeStops[name] = new Set(data.directions.flat());
    for (const slug of state.routeStops[name]) {
      (state.stopRoutes[slug] ??= new Set()).add(name);
    }
  }

  // Build stop-level adjacency from sequential stop pairs in each route direction.
  // Used for minimum-stop BFS to detect suboptimal user routes.
  state.adjacency = {};
  for (const [rname, data] of Object.entries(network)) {
    for (const dir of data.directions) {
      for (let i = 0; i < dir.length - 1; i++) {
        const [a, b] = [dir[i], dir[i + 1]];
        (state.adjacency[a] ??= []).push({ to: b, via: rname });
        (state.adjacency[b] ??= []).push({ to: a, via: rname });
      }
    }
  }
}

// ── BFS ───────────────────────────────────────────────────────────────────────

// Minimum number of lines needed to travel from src to dst.
// Each iteration = boarding one additional line and riding it anywhere on it.
function minLines(src, dst) {
  if (src === dst) return 0;
  const visited = new Set([src]);
  let frontier = new Set([src]);
  let n = 0;
  while (frontier.size) {
    n++;
    const next = new Set();
    for (const stop of frontier)
      for (const route of state.stopRoutes[stop] ?? [])
        for (const nb of state.routeStops[route]) {
          if (nb === dst) return n;
          if (!visited.has(nb)) { visited.add(nb); next.add(nb); }
        }
    frontier = next;
  }
  return 999;
}

// Number of stops between stopA and stopB on a given route (index distance).
function stopsOnRoute(routeName, stopA, stopB) {
  for (const dir of state.network[routeName]?.directions ?? []) {
    const i = dir.indexOf(stopA), j = dir.indexOf(stopB);
    if (i !== -1 && j !== -1) return Math.abs(j - i);
  }
  return Infinity;
}

// BFS on the stop-level adjacency graph — returns the minimum-stop path as
// {cost: number, segments: [{line, boardAt, alightAt}, …]}, or null if unreachable.
function minStopsBFS(src, dst) {
  if (src === dst) return { cost: 0, segments: [] };
  const parent = new Map([[src, null]]); // stop → {from, via} | null
  const queue  = [src];
  while (queue.length) {
    const stop = queue.shift();
    for (const { to, via } of state.adjacency[stop] ?? []) {
      if (parent.has(to)) continue;
      parent.set(to, { from: stop, via });
      if (to === dst) {
        const steps = [];
        let cur = dst;
        while (parent.get(cur)) {
          const { from, via: route } = parent.get(cur);
          steps.unshift({ from, stop: cur, route });
          cur = from;
        }
        // Merge consecutive steps on the same route into segments
        const segs = [];
        for (const step of steps) {
          const last = segs.at(-1);
          if (last && last.line === step.route) last.alightAt = step.stop;
          else segs.push({ line: step.route, boardAt: step.from, alightAt: step.stop });
        }
        return { cost: steps.length, segments: segs };
      }
      queue.push(to);
    }
  }
  return null;
}

// DP: minimum stops achievable when the user MUST use exactly these lines in order.
// For each line, boards from every stop reachable so far and rides to any stop on that line.
function userRouteMinStops(lines, src, dst) {
  let reachable = new Map([[src, 0]]); // stop → min stops from src so far
  for (const line of lines) {
    const next = new Map();
    for (const [stop, cost] of reachable) {
      if (!state.routeStops[line]?.has(stop)) continue;
      for (const nb of state.routeStops[line]) {
        const d = stopsOnRoute(line, stop, nb);
        if (d === Infinity) continue;
        const total = cost + d;
        if (!next.has(nb) || next.get(nb) > total) next.set(nb, total);
      }
    }
    reachable = next;
  }
  return reachable.get(dst) ?? Infinity;
}

// Find the optimal path as detailed segments: [{line, boardAt, alightAt}, …]
// Uses layer BFS — each while-iteration = one additional line boarded.
// boardAt / alightAt are the logical stop slugs where the rider gets on / off.
function findDetailedPath(src, dst) {
  if (src === dst) return [];
  const reached = new Map([[src, null]]); // stop → {line, from} | null
  let frontier = new Set([src]);

  while (frontier.size) {
    const next = new Set();
    for (const stop of frontier)
      for (const line of state.stopRoutes[stop] ?? [])
        for (const nb of state.routeStops[line]) {
          if (reached.has(nb)) continue;
          reached.set(nb, { line, from: stop });
          next.add(nb);
          if (nb === dst) {
            // Reconstruct raw step list, then merge consecutive same-line steps
            const raw = [];
            let cur = nb;
            while (reached.get(cur)) {
              const { line: l, from } = reached.get(cur);
              raw.unshift({ line: l, boardAt: from, alightAt: cur });
              cur = from;
            }
            return raw.reduce((acc, seg) => {
              if (acc.length && acc.at(-1).line === seg.line)
                acc.at(-1).alightAt = seg.alightAt; // extend same-line segment
              else
                acc.push({ ...seg });
              return acc;
            }, []);
          }
        }
    frontier = next;
  }
  return null;
}

// Ordered stop slugs for routeName between stopA and stopB (either direction).
function getStopSubsequence(routeName, stopA, stopB) {
  for (const dir of state.network[routeName]?.directions ?? []) {
    const i = dir.indexOf(stopA), j = dir.indexOf(stopB);
    if (i !== -1 && j !== -1 && i !== j)
      return i < j ? dir.slice(i, j + 1) : [...dir.slice(j, i + 1)].reverse();
  }
  return null;
}

// Check whether a sequence of lines actually forms a valid route from → to.
// Returns {ok:true} or {ok:false, err, …} — error codes so callers can translate.
function validateRoute(lines, from, to) {
  if (!lines.length)
    return { ok: false, err: 'noLines' };
  if (!state.routeStops[lines[0]]?.has(from))
    return { ok: false, err: 'noServe', line: lines[0], stop: state.stops[from]?.name ?? from };
  if (!state.routeStops[lines.at(-1)]?.has(to))
    return { ok: false, err: 'noServe', line: lines.at(-1), stop: state.stops[to]?.name ?? to };
  for (let i = 0; i < lines.length - 1; i++) {
    const a = state.routeStops[lines[i]], b = state.routeStops[lines[i + 1]];
    if (![...a].some(s => b.has(s)))
      return { ok: false, err: 'noCommon', l1: lines[i], l2: lines[i + 1] };
  }
  return { ok: true };
}

function validationMsg(v) {
  const L = LANG[state.lang];
  if (v.err === 'noLines')  return L.validNoLines;
  if (v.err === 'noServe')  return L.validNoServe(v.line, v.stop);
  if (v.err === 'noCommon') return L.validNoCommon(v.l1, v.l2);
  return '?';
}

// ── Map ───────────────────────────────────────────────────────────────────────

let map;
let routeLayers = []; // user's current lines (cleared on each update)
let pinLayers   = []; // start / end markers

// Colors assigned by position in user's route (first line, second line, …)
const LINE_COLORS = ['#2563eb', '#d97706', '#16a34a', '#9333ea', '#0891b2'];

// Colors used when drawing the optimal/correct-answer route after a wrong submit.
// Deliberately chosen to not overlap with LINE_COLORS so the two are always distinct.
const SOLUTION_COLORS = ['#dc2626', '#0d9488', '#7c3aed', '#be185d', '#ca8a04'];

function initMap() {
  map = L.map('map', { zoomControl: true });
  // Esri World Light Gray Canvas — clean minimalistic style, no API key required.
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
      maxZoom: 16,
    }
  ).addTo(map);
  map.setView([50.061, 19.937], 12);
}

function stopLatLng(slug) {
  const s = state.stops[slug];
  return s ? [s.lat, s.lon] : null;
}

// Draw lines the user has picked while building their answer (before submit).
function updateMapLines(lines) {
  routeLayers.forEach(l => l.remove());
  routeLayers = [];

  const T = LANG[state.lang];
  lines.forEach((name, i) => {
    const data = state.network[name];
    if (!data) return;
    const dir = data.directions.reduce((a, b) => a.length >= b.length ? a : b);
    const latlngs = dir.map(stopLatLng).filter(Boolean);
    if (latlngs.length < 2) return;
    routeLayers.push(
      L.polyline(latlngs, { color: LINE_COLORS[i % LINE_COLORS.length], weight: 7, opacity: .9 })
        .addTo(map).bindTooltip(T.mapLine(name))
    );
  });

  fitBounds();
}

// After submit: draw each segment's full line faint + the used portion thick + a number badge.
function drawOptimalSegments(segments) {
  // Fade user's lines instead of removing — player can still see what they picked
  routeLayers.forEach(l => { if (l.setStyle) l.setStyle({ opacity: 0.28, weight: 3 }); });

  const T = LANG[state.lang];
  segments.forEach((seg, i) => {
    const data = state.network[seg.line];
    if (!data) return;
    const color = SOLUTION_COLORS[i % SOLUTION_COLORS.length];

    // Full line extent — same color but very faint so lines stay distinct
    const fullDir = data.directions.reduce((a, b) => a.length >= b.length ? a : b);
    const fullLL  = fullDir.map(stopLatLng).filter(Boolean);
    if (fullLL.length >= 2)
      routeLayers.push(
        L.polyline(fullLL, { color, weight: 3, opacity: 0.32 })
          .addTo(map).bindTooltip(T.mapLine(seg.line))
      );

    // Used segment — colored and thick
    const sub   = getStopSubsequence(seg.line, seg.boardAt, seg.alightAt);
    const subLL = (sub ?? []).map(stopLatLng).filter(Boolean);
    if (subLL.length < 2) return;

    routeLayers.push(
      L.polyline(subLL, { color, weight: 7, opacity: 0.9 })
        .addTo(map)
        .bindTooltip(T.mapSeg(
          seg.line,
          state.stops[seg.boardAt]?.name,
          state.stops[seg.alightAt]?.name
        ))
    );

    // Number badge at midpoint of used segment
    const mid  = subLL[Math.floor(subLL.length / 2)];
    const icon = L.divIcon({
      html: `<div style="
        background:${color};color:#fff;
        font:700 12px/1.4 system-ui,sans-serif;
        padding:2px 7px;border-radius:4px;
        box-shadow:0 1px 4px rgba(0,0,0,.4);
        transform:translate(-50%,-50%);display:inline-block;
        pointer-events:none">${seg.line}</div>`,
      className: '',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    routeLayers.push(L.marker(mid, { icon, interactive: false }).addTo(map));
  });

  fitBounds();
}

function setMapPins(fromSlug, toSlug) {
  pinLayers.forEach(l => l.remove());
  pinLayers = [];

  const pin = (slug, fill, label) => {
    const ll = stopLatLng(slug);
    if (!ll) return;
    const m = L.circleMarker(ll, {
      radius: 9, color: '#fff', weight: 2.5,
      fillColor: fill, fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip(`${label}: ${state.stops[slug].name}`, { permanent: false });
    pinLayers.push(m);
  };

  const T = LANG[state.lang];
  pin(fromSlug, '#16a34a', T.mapFrom);
  pin(toSlug, '#e63946', T.mapTo);
}

function fitBounds() {
  const all = [...routeLayers, ...pinLayers];
  if (!all.length) return;
  try {
    map.fitBounds(L.featureGroup(all).getBounds().pad(0.15));
  } catch (_) { /* bounds empty */ }
}


// ── UI helpers ────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function renderDiffButtons() {
  const L = LANG[state.lang];
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.diff === state.difficulty);
    btn.textContent = L.diffLabel[btn.dataset.diff] ?? btn.dataset.diff;
  });
}

function renderRouteDisplay() {
  const div = $('route-display');
  if (!state.userLines.length) {
    div.innerHTML = `<span class="route-hint">${LANG[state.lang].routeHint}</span>`;
    return;
  }
  div.innerHTML = state.userLines.map((line, i) => {
    const color = LINE_COLORS[i % LINE_COLORS.length];
    return `
      ${i > 0 ? '<span class="route-sep">→</span>' : ''}
      <button class="route-chip" data-idx="${i}"
        style="--chip-color:${color}"
        ${state.submitted ? 'disabled' : ''}>
        ${line}<span class="chip-x"> ×</span>
      </button>`;
  }).join('');
}

function renderLineGrid() {
  const grid = $('line-grid');
  const sorted = Object.keys(state.network).sort((a, b) => +a - +b || a.localeCompare(b));
  grid.innerHTML = sorted.map(name => {
    const usedIdx = state.userLines.indexOf(name);
    const isUsed  = usedIdx !== -1;
    const color   = isUsed ? LINE_COLORS[usedIdx % LINE_COLORS.length] : null;
    return `<button
      class="line-btn${isUsed ? ' line-used' : ''}"
      data-line="${name}"
      ${color ? `style="--line-color:${color}"` : ''}
      ${state.submitted || isUsed ? 'disabled' : ''}
    >${name}</button>`;
  }).join('');
}

function renderSubmitBtn() {
  $('submit-btn').disabled = state.submitted || state.userLines.length === 0;
}

// ── Challenge flow ────────────────────────────────────────────────────────────

function showChallenge(ch) {
  state.challenge  = ch;
  state.userLines  = [];
  state.submitted  = false;

  $('from-name').textContent = state.stops[ch.from]?.name ?? ch.from;
  $('to-name').textContent   = state.stops[ch.to]?.name   ?? ch.to;

  $('quiz').classList.remove('hidden');
  $('result-panel').classList.add('hidden');
  $('all-done').classList.add('hidden');

  renderRouteDisplay();
  renderLineGrid();
  renderSubmitBtn();

  setMapPins(ch.from, ch.to);
  updateMapLines([]);
  fitBounds();
}

function pickChallenge() {
  const pool = state.challenges.filter(
    c => c.difficulty === state.difficulty && !state.solved.has(c.id)
  );
  if (!pool.length) {
    $('quiz').classList.add('hidden');
    $('all-done').classList.remove('hidden');
    $('done-text').textContent = LANG[state.lang].allDone(state.difficulty);
    return;
  }
  showChallenge(pool[Math.floor(Math.random() * pool.length)]);
}

function handleSubmit() {
  const { challenge, userLines } = state;
  const { from, to } = challenge;

  state.submitted = true;
  renderLineGrid();
  renderRouteDisplay();
  $('submit-btn').disabled = true;
  $('result-panel').classList.remove('hidden');

  const validation = validateRoute(userLines, from, to);
  const optimal    = minLines(from, to);
  const optSegs    = findDetailedPath(from, to);
  const optNames   = optSegs ? optSegs.map(s => s.line).join(' → ') : '';

  const L    = LANG[state.lang];
  const optEl = $('result-optimal');

  if (!validation.ok) {
    setResultUI('✗', 'wrong', validationMsg(validation));
    optEl.className = 'result-optimal';
    optEl.textContent = optNames ? L.optimal(optNames) : '';
  } else if (userLines.length === optimal) {
    setResultUI('✓', 'correct', L.correct(optimal));
    state.solved.add(challenge.id);
    saveSolved();

    // Check whether the user's specific route is optimal in total stops.
    const globalBest = minStopsBFS(from, to);
    if (globalBest && globalBest.segments.length === optimal) {
      const userMin = userRouteMinStops(userLines, from, to);
      const diff = userMin - globalBest.cost;
      if (diff > 0) {
        const segs = globalBest.segments;
        const routePart = segs.map(s => s.line).join(' → ');
        const xferPart  = segs.slice(0, -1)
          .map(s => L.xfer(state.stops[s.alightAt]?.name ?? s.alightAt))
          .join(', ');
        const desc = xferPart ? `${routePart} (${xferPart})` : `${L.linePrefix}${routePart}`;
        optEl.className = 'result-optimal result-tip';
        optEl.textContent = L.tipDesc(desc, diff);
      } else {
        optEl.className = 'result-optimal';
        optEl.textContent = '';
      }
    } else {
      optEl.className = 'result-optimal';
      optEl.textContent = '';
    }
  } else {
    setResultUI('✗', 'wrong', L.wrongCount(userLines.length, optimal));
    optEl.className = 'result-optimal';
    optEl.textContent = optNames ? L.optimal(optNames) : '';
  }

  // Only show optimal path when the user's answer was wrong.
  // For correct answers the map already shows their route — leave it.
  const isCorrect = validation.ok && userLines.length === optimal;
  if (optSegs && !isCorrect) drawOptimalSegments(optSegs);
}

function setResultUI(icon, cls, text) {
  const iconEl = $('result-icon');
  iconEl.textContent = icon;
  iconEl.className   = `result-icon ${cls}`;
  $('result-text').textContent = text;
}

// ── Translations ─────────────────────────────────────────────────────────────

function applyTranslations() {
  const L = LANG[state.lang];
  $('app-title').textContent  = L.appTitle;
  $('lang-btn').textContent   = state.lang === 'pl' ? '🇬🇧 EN' : '🇵🇱 PL';
  $('label-from').textContent = L.labelFrom;
  $('label-to').textContent   = L.labelTo;
  $('label-route').textContent = L.labelRoute;
  $('label-lines').textContent = L.labelLines;
  $('submit-btn').textContent = L.submit;
  $('next-btn').textContent   = L.nextBtn;
  $('reset-btn').textContent  = L.resetDiff;
  $('loading').textContent    = L.loading;
  renderDiffButtons();
  renderRouteDisplay();
  // Update all-done text if that section is currently visible
  if (!$('all-done').classList.contains('hidden'))
    $('done-text').textContent = L.allDone(state.difficulty);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // Difficulty selector
  document.querySelectorAll('.diff-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      state.difficulty = btn.dataset.diff;
      localStorage.setItem('kmq_diff', state.difficulty);
      renderDiffButtons();
      pickChallenge();
    })
  );

  // Line grid (delegated)
  $('line-grid').addEventListener('click', e => {
    const btn = e.target.closest('.line-btn');
    if (!btn || state.submitted || btn.disabled) return;
    state.userLines.push(btn.dataset.line);
    renderRouteDisplay();
    renderLineGrid();
    renderSubmitBtn();
    updateMapLines(state.userLines);
  });

  // Route chips: click truncates at that position (removes it and everything after)
  $('route-display').addEventListener('click', e => {
    const chip = e.target.closest('.route-chip');
    if (!chip || state.submitted) return;
    state.userLines = state.userLines.slice(0, +chip.dataset.idx);
    renderRouteDisplay();
    renderLineGrid();
    renderSubmitBtn();
    updateMapLines(state.userLines);
  });

  $('lang-btn').addEventListener('click', () => {
    state.lang = state.lang === 'pl' ? 'en' : 'pl';
    localStorage.setItem('kmq_lang', state.lang);
    applyTranslations();
  });

  $('submit-btn').addEventListener('click', handleSubmit);

  $('next-btn').addEventListener('click', pickChallenge);

  $('reset-btn').addEventListener('click', () => {
    // Clear only the current difficulty's solved challenges
    state.challenges
      .filter(c => c.difficulty === state.difficulty)
      .forEach(c => state.solved.delete(c.id));
    saveSolved();
    pickChallenge();
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  initMap();
  try {
    await loadData();
    $('loading').classList.add('hidden');
    wireEvents();
    applyTranslations();
    renderLineGrid();
    pickChallenge();
  } catch (err) {
    $('loading').textContent = LANG[state.lang].loadError(err.message);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
