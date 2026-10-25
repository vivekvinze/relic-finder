/* Relic Finder — app logic.
 * Content (locations, pictures, hints) lives in config.js; you shouldn't need
 * to touch this file to run a new hunt.
 *
 * Sections: storage · state · geo math · sensors (GPS, compass, wake lock)
 *           · arrival detection · audio · radar rendering · UI
 *           · dev mode (set locations on-site, simulated GPS)
 */
(() => {
  'use strict';

  const C = window.HUNT_CONFIG;
  const $ = (s) => document.querySelector(s);
  const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

  C.TARGETS.forEach((t, i) => { t.id = t.id || 'relic-' + (i + 1); });
  const TOTAL = C.TARGETS.length;
  const RANGES = C.RANGES_M || [50, 150, 500, 2000, 10000];

  /* ---------------- storage ---------------- */
  const NS = 'relic-finder:' + (C.HUNT_ID || 'default');
  const KEY = NS;                 // progress
  const SPOTS_KEY = NS + ':spots'; // locations set on-site in dev mode (this device only)
  const DEV_KEY = 'relic-finder:dev';
  const get = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const del = (k) => { try { localStorage.removeItem(k); } catch {} };
  const persist = () => put(KEY, { found: S.found, sound: S.sound, introSeen: S.introSeen });

  const params = new URLSearchParams(location.search);
  if (params.has('reset')) del(KEY); // ?reset=1 clears progress
  if (params.get('dev') === '0') del(DEV_KEY);
  const DEV = params.has('dev') && params.get('dev') !== '0' || !!C.DEV_MODE || get(DEV_KEY) === true;

  // Locally set spots override config.js on this device, so you can test
  // straight after setting them. Copy config → paste into config.js to make
  // them real for everyone.
  const spots = get(SPOTS_KEY) || {};
  for (const t of C.TARGETS) {
    t.cfg = { lat: t.lat, lng: t.lng };
    if (spots[t.id]) { t.lat = spots[t.id].lat; t.lng = spots[t.id].lng; }
  }

  /* ---------------- state ---------------- */
  const saved = get(KEY) || {};
  const S = {
    found: Array.isArray(saved.found) ? saved.found.filter((id) => C.TARGETS.some((t) => t.id === id)) : [],
    sound: saved.sound !== false,
    introSeen: !!saved.introSeen,
    pos: null,          // { lat, lng, acc } — what the radar uses
    realPos: null,      // latest real GPS fix
    fixes: [],          // recent real fixes, used when setting a spot
    heading: null,      // degrees, 0 = north; null = no compass (north-up)
    rangeIdx: -1,       // -1 = AUTO
    inside: {},
    started: false,
    gpsMsg: null,
    modalOpen: false,
    sim: false,         // dev: simulated GPS
    triggers: !DEV,     // dev: arrivals off by default so setting spots doesn't fire them
    capturing: false,
  };

  const unfound = () => C.TARGETS.filter((t) => !S.found.includes(t.id));
  const active = () => (C.SEQUENTIAL === false ? unfound() : unfound().slice(0, 1));
  const done = () => S.found.length >= TOTAL;

  /* ---------------- geo math ---------------- */
  const EARTH = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function dist(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
              Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function offset(p, meters, brg) {
    const d = meters / EARTH, b = rad(brg), la = rad(p.lat), lo = rad(p.lng);
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return { lat: deg(la2), lng: deg(lo2) };
  }
  function nearest() {
    if (!S.pos) return null;
    let best = null;
    for (const t of active()) {
      const d = dist(S.pos, t);
      if (!best || d < best.d) best = { t, d };
    }
    return best;
  }

  /* ---------------- formatting ---------------- */
  const IMPERIAL = C.UNITS === 'imperial';
  function fmtDist(m) {
    if (IMPERIAL) {
      const ft = m * 3.28084;
      if (ft < 1000) return Math.round(ft) + ' ft';
      const mi = m / 1609.344;
      return (mi < 10 ? mi.toFixed(2) : mi < 100 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
    }
    if (m < 1000) return Math.round(m) + ' m';
    const km = m / 1000;
    return (km < 10 ? km.toFixed(2) : km < 100 ? km.toFixed(1) : Math.round(km)) + ' km';
  }
  function fmtShort(m) {
    if (IMPERIAL) {
      const ft = m * 3.28084;
      return ft < 1000 ? Math.round(ft) + 'ft' : +(m / 1609.344).toFixed(1) + 'mi';
    }
    return m < 1000 ? Math.round(m) + 'm' : +(m / 1000).toFixed(1) + 'km';
  }
  const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const cardinal = (h) => CARD[Math.round(h / 45) % 8];

  function currentRange() {
    if (S.rangeIdx >= 0) return RANGES[S.rangeIdx];
    const n = nearest();
    if (!n) return RANGES[2] || RANGES[0];
    for (const r of RANGES) if (n.d <= r * 0.8) return r;
    return RANGES[RANGES.length - 1];
  }

  /* ---------------- sensors ---------------- */
  let gpsStarted = false;
  function startGPS() {
    if (gpsStarted) return;
    gpsStarted = true;
    if (!('geolocation' in navigator)) { S.gpsMsg = 'GPS not available on this device.'; return; }
    S.gpsMsg = 'Acquiring signal…';
    navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
        S.realPos = fix;
        S.fixes.push(fix);
        if (S.fixes.length > 40) S.fixes.shift();
        S.gpsMsg = null;
        if (!S.sim) { S.pos = fix; checkArrival(); }
      },
      (e) => {
        S.gpsMsg = e.code === 1
          ? 'Location is blocked. Allow it in Settings › Privacy › Location Services › Safari Websites.'
          : 'Searching for signal… step outside if you can.';
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  // iOS: webkitCompassHeading (needs permission, requested on the power-on tap).
  // Android/Chrome: deviceorientationabsolute alpha.
  function listenCompass() {
    const on = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) h = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
      if (h == null || Number.isNaN(h)) return;
      const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (h + so + 360) % 360;
      if (S.heading == null) S.heading = h;
      else {
        const d = ((h - S.heading + 540) % 360) - 180; // shortest way round
        S.heading = (S.heading + d * 0.25 + 360) % 360; // smooth the jitter
      }
    };
    window.addEventListener('deviceorientationabsolute', on, true);
    window.addEventListener('deviceorientation', on, true);
  }

  function requestCompass() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      // Must be called synchronously inside the tap handler on iOS.
      DOE.requestPermission().then((r) => { if (r === 'granted') listenCompass(); }).catch(() => {});
    } else {
      listenCompass();
    }
  }

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.started) keepAwake();
  });

  /* ---------------- arrival detection ---------------- */
  function checkArrival() {
    if (!S.pos || S.modalOpen || done() || !S.triggers || S.capturing) return;
    if (S.pos.acc > (C.MAX_ACCURACY_M ?? 40)) return; // too fuzzy to trust
    const needed = S.sim ? 1 : 2; // two real fixes in a row avoids GPS-jitter false alarms
    for (const t of active()) {
      const r = t.radiusM ?? C.TRIGGER_RADIUS_M ?? 25;
      if (dist(S.pos, t) <= r) {
        S.inside[t.id] = (S.inside[t.id] || 0) + 1;
        if (S.inside[t.id] >= needed) { secure(t); return; }
      } else {
        S.inside[t.id] = 0;
      }
    }
  }

  async function secure(t) {
    S.found.push(t.id);
    S.inside = {};
    persist();
    chime();
    if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
    const scr = $('#screen');
    scr.classList.remove('flash'); void scr.offsetWidth; scr.classList.add('flash');
    $('#led').classList.add('blink');
    setTimeout(() => $('#led').classList.remove('blink'), 600);

    await showModal({
      kicker: `RELIC ${S.found.length}/${TOTAL} SECURED`,
      title: t.name,
      image: t.image,
      body: t.hint || '',
      button: done() ? 'CONTINUE' : 'NEXT SIGNAL',
    });
    if (done()) showFinale();
    else checkArrival(); // in case the next relic is right here too
  }

  function showFinale() {
    const f = C.FINALE || {};
    return showModal({ kicker: 'HUNT COMPLETE', title: f.title || 'All relics secured', body: f.message || '', button: 'CLOSE' });
  }

  /* ---------------- audio ---------------- */
  let AC = null;
  let nextPing = 0;
  function initAudio() {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
    } catch { AC = null; }
  }
  function tone(freq, dur, when = 0, type = 'sine', vol = 0.16) {
    if (!AC || !S.sound) return;
    const t0 = AC.currentTime + when;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(AC.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }
  const chime = () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, i * 0.09, 'triangle', 0.2)); };
  const powerUp = () => { [220, 330, 495, 742].forEach((f, i) => tone(f, 0.14, i * 0.07, 'square', 0.05)); };

  // Ping rate and pitch climb as he closes in.
  function schedulePing(now) {
    if (!S.started || S.modalOpen || done()) return;
    const n = nearest();
    if (!n || now < nextPing) return;
    const trig = n.t.radiusM ?? C.TRIGGER_RADIUS_M ?? 25;
    const lo = Math.log10(Math.max(trig, 5)), hi = Math.log10(2000);
    const k = Math.min(1, Math.max(0, (Math.log10(Math.max(n.d, 1)) - lo) / (hi - lo))); // 0 near → 1 far
    tone(1180 - k * 520, 0.07, 0, 'sine', 0.14);
    nextPing = now + 180 + k * 2200;
  }

  /* ---------------- radar rendering ---------------- */
  const cv = $('#radar');
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function fit() {
    const r = cv.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 3);
    W = r.width; H = r.height;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  }
  new ResizeObserver(fit).observe(cv);
  fit();

  const SWEEP_MS = 2600;
  const amber = (a) => `rgba(255,178,62,${a})`;
  const polar = (cx, cy, r, thetaDeg) => [cx + Math.sin(rad(thetaDeg)) * r, cy - Math.cos(rad(thetaDeg)) * r];

  function draw(now) {
    if (!W) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 8;
    const rot = S.heading == null ? 0 : S.heading; // world bearing b sits at screen angle (b - rot)
    const range = currentRange();

    const bg = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 1.25);
    bg.addColorStop(0, '#2b1707'); bg.addColorStop(1, '#0d0602');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.strokeStyle = amber(i === 4 ? 0.6 : 0.17);
      ctx.beginPath(); ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = amber(0.07);
    for (let b = 0; b < 360; b += 45) {
      const [x, y] = polar(cx, cy, R, b - rot);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    for (let b = 0; b < 360; b += 5) {
      const big = b % 90 === 0, mid = b % 30 === 0;
      const len = big ? 13 : mid
