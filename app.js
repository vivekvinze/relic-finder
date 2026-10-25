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
      const len = big ? 13 : mid ? 8 : 4;
      ctx.strokeStyle = amber(big ? 0.85 : mid ? 0.55 : 0.25);
      ctx.lineWidth = big ? 2 : 1;
      const [x1, y1] = polar(cx, cy, R - len, b - rot);
      const [x2, y2] = polar(cx, cy, R, b - rot);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.lineWidth = 1;
    const fs = Math.max(10, R * 0.068);
    ctx.font = `700 ${fs}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [l, b] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const [x, y] = polar(cx, cy, R - 13 - fs * 0.9, b - rot);
      ctx.fillStyle = l === 'N' ? '#ff7a63' : amber(0.75);
      ctx.fillText(l, x, y);
    }
    ctx.font = `600 ${Math.max(9, R * 0.05)}px ${MONO}`;
    ctx.fillStyle = amber(0.45);
    for (const i of [2, 4]) {
      const [x, y] = polar(cx, cy, (R * i) / 4 - (i === 4 ? 26 : 8), 135);
      ctx.fillText(fmtShort((range * i) / 4), x, y);
    }

    const sw = ((now % SWEEP_MS) / SWEEP_MS) * 360;
    const SLICES = 36, SPAN = 1.6;
    for (let k = 0; k < SLICES; k++) {
      const a1 = rad(sw - k * SPAN - 90), a0 = rad(sw - (k + 1) * SPAN - 90);
      ctx.fillStyle = amber(0.2 * (1 - k / SLICES) ** 1.6);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath(); ctx.fill();
    }
    {
      const [x, y] = polar(cx, cy, R, sw);
      ctx.strokeStyle = amber(0.9); ctx.lineWidth = 1.5;
      ctx.shadowColor = '#ffb23e'; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.shadowBlur = 0; ctx.lineWidth = 1;
    }

    if (S.pos) {
      const accR = Math.min(R, (S.pos.acc / range) * R);
      if (accR > 4) {
        ctx.setLineDash([3, 4]); ctx.strokeStyle = amber(0.28);
        ctx.beginPath(); ctx.arc(cx, cy, accR, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
      for (const t of active()) {
        const d = dist(S.pos, t), th = bearing(S.pos, t) - rot;
        const since = (((sw - th) % 360) + 360) % 360;
        const glow = 0.35 + 0.65 * Math.exp(-since / 65);
        if (d <= range) {
          const [x, y] = polar(cx, cy, (d / range) * R, th);
          const zr = ((t.radiusM ?? C.TRIGGER_RADIUS_M ?? 25) / range) * R;
          if (zr > 6) {
            ctx.strokeStyle = 'rgba(255,122,99,0.35)'; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.arc(x, y, zr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          }
          drawBlip(x, y, glow, now);
        } else {
          const [x, y] = polar(cx, cy, R - 22, th);
          const a = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(now / 160));
          ctx.save(); ctx.translate(x, y); ctx.rotate(rad(th));
          ctx.fillStyle = `rgba(255,122,99,${a})`; ctx.shadowColor = '#ff6b57'; ctx.shadowBlur = 10;
          ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(8, 5); ctx.lineTo(0, 1); ctx.lineTo(-8, 5); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
    }

    ctx.save(); ctx.translate(cx, cy);
    ctx.fillStyle = '#ffe2ad'; ctx.shadowColor = '#ffb23e'; ctx.shadowBlur = 10;
    if (S.heading != null) {
      ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7); ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    let status = null;
    if (S.started && done()) status = 'ALL RELICS SECURED';
    else if (S.started && !S.pos) status = 'ACQUIRING SIGNAL';
    if (status && Math.floor(now / 600) % 2 === 0) {
      ctx.font = `800 ${Math.max(11, R * 0.065)}px ${MONO}`;
      ctx.fillStyle = '#ffd28a'; ctx.shadowColor = '#ffb23e'; ctx.shadowBlur = 10;
      ctx.fillText(status, cx, cy + R * 0.42);
      ctx.shadowBlur = 0;
    }
  }

  function drawBlip(x, y, glow, now) {
    const p = (now % 1400) / 1400;
    ctx.strokeStyle = `rgba(255,122,99,${0.6 * (1 - p)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 6 + p * 18, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.save(); ctx.translate(x, y);
    ctx.shadowColor = '#ff6b57'; ctx.shadowBlur = 14 * glow;
    ctx.fillStyle = `rgba(255,122,99,${glow})`;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(7, 0); ctx.lineTo(0, 8); ctx.lineTo(-7, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = `rgba(255,240,220,${glow})`;
    ctx.beginPath(); ctx.moveTo(0, -3.5); ctx.lineTo(3, 0); ctx.lineTo(0, 3.5); ctx.lineTo(-3, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* ---------------- UI ---------------- */
  const el = {
    dist: $('#vDist'), hdg: $('#vHdg'), acc: $('#vAcc'), relics: $('#vRelics'),
    clue: $('#clue'), lRange: $('#lRange'), lSound: $('#lSound'), led: $('#led'), pips: $('#pips'),
  };
  for (let i = 0; i < TOTAL; i++) el.pips.append(Object.assign(document.createElement('span'), { className: 'pip' }));

  let lastUI = 0;
  function updateUI(now) {
    if (now - lastUI < 200) return;
    lastUI = now;
    const n = nearest();
    el.dist.textContent = done() ? 'DONE' : n ? fmtDist(n.d) : '—';
    el.hdg.textContent = S.heading == null ? 'N-UP' : `${Math.round(S.heading)}° ${cardinal(S.heading)}`;
    el.acc.textContent = S.pos ? '±' + fmtShort(S.pos.acc) : '—';
    el.relics.textContent = `${S.found.length}/${TOTAL}`;
    el.lRange.textContent = S.rangeIdx < 0 ? 'AUTO' : fmtShort(RANGES[S.rangeIdx]);
    el.lSound.textContent = S.sound ? 'ON' : 'OFF';
    [...el.pips.children].forEach((p, i) => p.classList.toggle('on', i < S.found.length));

    let clue;
    if (!S.started) clue = 'Standing by. Tap the screen to power on.';
    else if (done()) clue = 'Hunt complete.';
    else if (S.gpsMsg && !S.sim) clue = S.gpsMsg;
    else if (C.SEQUENTIAL === false) clue = C.DEFAULT_CLUE || 'Follow the signal.';
    else clue = (active()[0] && active()[0].clue) || C.DEFAULT_CLUE || 'Follow the signal.';
    if (el.clue.textContent !== clue) el.clue.textContent = clue;

    if (DEV) updateDev();
  }

  // Promise-based modal. body: string, array of {title, text, image}, or a Node.
  function showModal({ kicker = '', title = '', body = '', image = null, button = 'OK' }) {
    S.modalOpen = true;
    $('#mKicker').textContent = kicker;
    $('#mTitle').textContent = title;
    const img = $('#mImg');
    if (image) { img.src = image; img.hidden = false; img.onerror = () => { img.hidden = true; }; }
    else { img.hidden = true; img.removeAttribute('src'); }
    const b = $('#mBody');
    b.replaceChildren();
    if (body instanceof Node) b.append(body);
    else if (Array.isArray(body)) {
      for (const e of body) {
        const d = document.createElement('div'); d.className = 'entry';
        const h = document.createElement('b'); h.textContent = e.title;
        d.append(h);
        if (e.image) {
          const im = document.createElement('img'); im.src = e.image; im.alt = '';
          im.onerror = () => im.remove();
          d.append(im);
        }
        const p = document.createElement('div'); p.textContent = e.text;
        d.append(p); b.append(d);
      }
    } else b.textContent = body;
    $('#mBtn').textContent = button;
    $('#modal').hidden = false;
    $('.card').scrollTop = 0;
    return new Promise((resolve) => {
      $('#mBtn').onclick = () => {
        $('#modal').hidden = true;
        S.modalOpen = false;
        resolve();
      };
    });
  }

  function powerOn() {
    // Order matters on iOS: audio + compass permission must start inside the tap.
    initAudio();
    requestCompass();
    startGPS();
    keepAwake();
    S.started = true;
    el.led.classList.add('on');
    $('#boot').classList.add('off');
    powerUp();
    setTimeout(async () => {
      if (done()) { showFinale(); return; }
      if (!S.introSeen && C.INTRO && !DEV) {
        S.introSeen = true; persist();
        await showModal({ kicker: 'INCOMING', title: C.INTRO.title, body: C.INTRO.message, button: 'BEGIN' });
      }
      checkArrival();
    }, 650);
  }

  function bootScreen() {
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const lines = [
      ['Dragon Ball Radar', ''],
      ['SENSOR ARRAY ......... OK', 'dim'],
      ['PHOSPHOR ............. OK', 'dim'],
      [`Dragon Balls detected ...... ${TOTAL}`, 'dim'],
    ];
    if (ios && !standalone && !DEV) lines.push(['', ''], ['TIP: SHARE › ADD TO HOME SCREEN', 'dim']);
    if (DEV) lines.push(['', ''], ['DEV MODE', '']);
    const box = $('#bootLines');
    lines.forEach(([txt, cls], i) => {
      const d = document.createElement('div');
      d.textContent = txt || ' ';
      if (cls) d.className = cls;
      d.style.animationDelay = `${0.25 + i * 0.28}s`;
      box.append(d);
    });
    const cta = document.createElement('div');
    cta.className = 'cta';
    cta.textContent = '[ TAP TO POWER ON ]';
    const delay = `${0.25 + lines.length * 0.28}s`;
    cta.style.animationDelay = `${delay}, ${delay}`;
    box.append(cta);
    $('#boot').addEventListener('click', powerOn, { once: true });
  }

  // Warm the cache so pictures still show with no signal.
  C.TARGETS.forEach((t) => { if (t.image) new Image().src = t.image; });

  $('#btnRange').addEventListener('click', () => {
    S.rangeIdx = S.rangeIdx + 1 >= RANGES.length ? -1 : S.rangeIdx + 1;
    tone(880, 0.05, 0, 'square', 0.05);
  });
  $('#btnSound').addEventListener('click', () => {
    S.sound = !S.sound; persist();
    tone(660, 0.06, 0, 'square', 0.05);
  });
  $('#btnLog').addEventListener('click', () => {
    if (S.modalOpen) return;
    const found = C.TARGETS.filter((t) => S.found.includes(t.id));
    showModal({
      kicker: `FIELD LOG · ${found.length}/${TOTAL}`,
      title: found.length ? 'Relics secured' : 'Nothing yet',
      body: found.length
        ? found.map((t) => ({ title: t.name.toUpperCase(), image: t.image, text: t.hint || '' }))
        : 'Follow the blip to find your first relic.',
      button: 'CLOSE',
    });
  });

  // Hidden way into dev mode from the installed app: tap the MK-II badge 5×.
  {
    let taps = 0, timer = 0;
    $('#badge').addEventListener('click', () => {
      taps++; clearTimeout(timer); timer = setTimeout(() => { taps = 0; }, 1500);
      if (taps >= 5) { put(DEV_KEY, true); location.reload(); }
    });
  }

  /* ---------------- dev mode ----------------
   * Real-GPS mode: stand on a spot → "Set N" averages ~6 s of fixes and saves
   * it on this device. "Copy config" gives you lines to paste into config.js.
   * SIM mode: fake GPS for desk testing (tap radar / Step / Arrive).
   */
  let devMsgTimer = 0;
  function devMsg(t, ms = 4000) {
    $('#devMsg').textContent = t;
    clearTimeout(devMsgTimer);
    if (ms) devMsgTimer = setTimeout(() => { $('#devMsg').textContent = ''; }, ms);
  }

  function updateDev() {
    const r = S.realPos;
    const age = r ? Math.round((Date.now() - r.t) / 1000) : null;
    $('#devStatus').textContent = S.sim ? 'SIM GPS'
      : r ? `GPS ±${Math.round(r.acc)}m · ${age}s ago` : (S.started ? 'GPS waiting…' : 'GPS — power on first');
    $('#devSim').textContent = S.sim ? 'SIM on' : 'SIM off';
    $('#devSim').classList.toggle('hot', S.sim);
    $('#devTrig').textContent = S.triggers ? 'Triggers on' : 'Triggers off';
    $('#devTrig').classList.toggle('hot', S.triggers);
    $('#devSimRow').hidden = !S.sim;
    C.TARGETS.forEach((t, i) => {
      const b = $(`#devSet [data-idx="${i}"]`);
      if (!b) return;
      b.disabled = S.capturing;
      b.classList.toggle('hot', !!spots[t.id]);
    });
  }

  function averageFixes(fixes) {
    // weight by 1/acc² so sharp fixes dominate
    let w = 0, lat = 0, lng = 0;
    for (const f of fixes) { const k = 1 / Math.max(f.acc, 1) ** 2; w += k; lat += f.lat * k; lng += f.lng * k; }
    const best = Math.min(...fixes.map((f) => f.acc));
    return { lat: lat / w, lng: lng / w, acc: best };
  }

  async function setSpot(i) {
    const t = C.TARGETS[i];
    if (S.sim) {
      if (!S.pos) return devMsg('No simulated position yet.');
      saveSpot(t, { lat: S.pos.lat, lng: S.pos.lng, acc: S.pos.acc });
      return;
    }
    if (!S.started) return devMsg('Tap the screen to power on first.');
    S.capturing = true;
    const start = Date.now();
    for (let s = 6; s > 0; s--) { devMsg(`Hold still… sampling GPS for ${t.name} (${s})`, 0); await new Promise((r) => setTimeout(r, 1000)); }
    S.capturing = false;
    const fixes = S.fixes.filter((f) => f.t >= start - 1500);
    if (!fixes.length) return devMsg('No GPS fix yet. Wait for a signal and try again.');
    const bestAcc = Math.min(...fixes.map((f) => f.acc));
    const good = fixes.filter((f) => f.acc <= bestAcc * 1.5);
    const spot = averageFixes(good);
    saveSpot(t, spot);
    if (spot.acc > 20) devMsg(`${t.name} set, but accuracy is ±${Math.round(spot.acc)} m. Try again in the open sky.`, 7000);
  }

  function saveSpot(t, spot) {
    spots[t.id] = { lat: +spot.lat.toFixed(6), lng: +spot.lng.toFixed(6), acc: Math.round(spot.acc), at: Date.now() };
    put(SPOTS_KEY, spots);
    t.lat = spots[t.id].lat; t.lng = spots[t.id].lng;
    S.inside = {};
    tone(990, 0.12, 0, 'triangle', 0.15);
    devMsg(`${t.name} set to ${t.lat}, ${t.lng} (±${spots[t.id].acc} m). Copy config when done.`, 6000);
  }

  function configSnippet() {
    return C.TARGETS.map((t, i) =>
      `lat: ${t.lat.toFixed(6)}, lng: ${t.lng.toFixed(6)}, // ⬅️ CHANGE location ${i + 1}`).join('\n');
  }

  async function copyConfig() {
    const text = configSnippet();
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {}
    const pre = document.createElement('pre'); pre.textContent = text;
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    const unset = C.TARGETS.map((t, i) => (spots[t.id] ? null : i + 1)).filter(Boolean);
    p.textContent = (copied ? 'Copied. ' : 'Copy these lines. ') +
      'In config.js, replace each target\'s lat/lng line with the matching line below, then commit and bump CACHE_VERSION in sw.js.' +
      (unset.length ? ` Location ${unset.join(' & ')} not set on-site yet, so ${unset.length > 1 ? 'those lines are' : 'that line is'} unchanged.` : '');
    p.style.marginBottom = '10px';
    wrap.append(p, pre);
    showModal({ kicker: 'DEV', title: 'Locations for config.js', body: wrap, button: 'DONE' });
  }

  if (DEV) {
    $('#dev').hidden = false;
    const setRow = $('#devSet');
    const lbl = document.createElement('span'); lbl.textContent = 'Set location:';
    setRow.append(lbl);
    C.TARGETS.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.idx = i; b.textContent = `Set ${i + 1}`;
      b.addEventListener('click', () => setSpot(i));
      setRow.append(b);
    });

    cv.addEventListener('pointerdown', (e) => {
      if (!S.sim || !S.pos) return;
      const r = cv.getBoundingClientRect();
      const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      const R = Math.min(r.width, r.height) / 2 - 8;
      const m = (Math.hypot(dx, dy) / R) * currentRange();
      const th = (deg(Math.atan2(dx, -dy)) + 360) % 360 + (S.heading || 0);
      S.pos = { ...offset(S.pos, m, th), acc: 8 };
      checkArrival();
    });

    $('#dev').addEventListener('click', (e) => {
      const a = e.target.dataset.dev; if (!a) return;
      const t = active()[0];
      if (a === 'sim') {
        S.sim = !S.sim;
        if (S.sim) {
          const base = S.realPos || C.DEV_START || offset(C.TARGETS[0], 350, 200);
          S.pos = { lat: base.lat, lng: base.lng, acc: 8 };
          S.triggers = true;
        } else {
          S.pos = S.realPos;
        }
        S.inside = {};
      }
      if (a === 'triggers') { S.triggers = !S.triggers; S.inside = {}; checkArrival(); }
      if (a === 'exit') { del(DEV_KEY); location.href = location.pathname; }
      if (a === 'copy') copyConfig();
      if (a === 'clear') {
        if (!confirm('Clear the locations set on this device and go back to config.js?')) return;
        del(SPOTS_KEY); location.reload();
      }
      if (a === 'reset') { del(KEY); location.reload(); }
      if (a === 'step' && t && S.pos) { S.pos = { ...offset(S.pos, dist(S.pos, t) * 0.5, bearing(S.pos, t)), acc: 8 }; checkArrival(); }
      if (a === 'arrive' && t) { S.pos = { lat: t.lat, lng: t.lng, acc: 8 }; checkArrival(); }
      if (a === 'left') S.heading = ((S.heading ?? 0) - 15 + 360) % 360;
      if (a === 'right') S.heading = ((S.heading ?? 0) + 15) % 360;
    });

    if (Object.keys(spots).length) devMsg(`Using ${Object.keys(spots).length} location(s) set on this device.`, 6000);
  }

  /* ---------------- main loop ---------------- */
  function loop(now) {
    draw(now);
    updateUI(now);
    schedulePing(now);
    requestAnimationFrame(loop);
  }

  bootScreen();
  requestAnimationFrame(loop);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
