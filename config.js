/* ============================================================================
 * RELIC FINDER — HUNT CONFIG
 * ----------------------------------------------------------------------------
 * Everything you'll want to change lives in this file. app.js reads
 * window.HUNT_CONFIG and never needs editing for content.
 *
 * SETTING LOCATIONS — two ways:
 *   A) On-site (easiest): open the app in Safari with ?dev=1 (or tap the
 *      MK-II badge 5 times), stand on each spot, tap "Set 1/2/3", then
 *      "Copy config" and paste the lines it gives you over the lat/lng below.
 *   B) By hand: long-press a spot in Apple/Google Maps, copy "lat, lng".
 *
 * After editing and pushing to GitHub Pages, bump CACHE_VERSION in sw.js so
 * installed copies pick up the change.
 * ========================================================================== */

window.HUNT_CONFIG = {
  // Changing this starts a fresh save slot (progress is stored per HUNT_ID).
  HUNT_ID: 'hunt-001',

  // 'metric' (m / km) or 'imperial' (ft / mi). Display only; radii below are
  // always in meters.
  UNITS: 'metric',

  // true  = one relic at a time, in the order listed (trail of clues).
  // false = every unfound relic shows on the radar at once.
  SEQUENTIAL: true,

  // How close (meters) counts as "arrived". Phone GPS is ~5–20 m outdoors,
  // so 20–30 m feels fair. Any target can override with its own `radiusM`.
  TRIGGER_RADIUS_M: 25,

  // Ignore GPS fixes worse than this (meters), so one wild reading can't
  // trigger a relic early.
  MAX_ACCURACY_M: 40,

  // Shown once, the first time the app is powered on.
  INTRO: {
    title: 'Signal detected',
    message:
      'Three dragon balls are hidden nearby.\n' +
      'Follow the blip. The closer you get, the faster it pings.',
  },

  // Shown in the transmission strip while hunting a relic with no `clue`.
  DEFAULT_CLUE: 'Follow the signal.',

  /* --------------------------------------------------------------------------
   * ⬇️ CHANGE: THE TARGETS (in hunt order)
   *
   *   name    – title on the "found" card
   *   lat/lng – the spot (placeholders below are in Central Park, NYC)
   *   image   – picture shown above the hint. Drop your own file into
   *             /images and point to it. Square-ish works best (~600px).
   *   hint    – revealed when he ARRIVES at this spot
   *   clue    – optional: shown on the device WHILE he's hunting this spot
   *   radiusM – optional per-target trigger radius
   * ------------------------------------------------------------------------ */
  TARGETS: [
    {
      name: 'Relic 1',
      lat: 40.77394, lng: -73.97108, // ⬅️ CHANGE location 1
      image: 'images/db1-relc.png',   // ⬅️ CHANGE picture 1
      hint: 'This is a slower version of instant transmission. ',              // ⬅️ CHANGE hint 1
      clue: 'This is the standard LLD interview question',
    },
    {
      name: 'Relic 2',
      lat: 40.77566, lng: -73.97186, // ⬅️ CHANGE location 2
      image: 'images/db2-relic.png',   // ⬅️ CHANGE picture 2
      hint: 'Vegeta would never skip a day here. Head to where Saiyans push past their limits and train until they break the 100x gravity.',              // ⬅️ CHANGE hint 2
      clue: '',
    },
    {
      name: 'Relic 3',
      lat: 40.77938, lng: -73.96913, // ⬅️ CHANGE location 3
      image: 'images/db4-relic.png',   // ⬅️ CHANGE picture 3
      hint: 'You’ve gathered all three Dragon Balls. Now find a place with nothing above you but open sky, and call out Shenron!',              // ⬅️ CHANGE hint 3
      clue: '',
    },
  ],

  // ⬇️ CHANGE: shown after the last relic is found.
  FINALE: {
    title: 'All dragon balls secured',
    message: 'You did it.',
  },

  // Radar zoom steps in meters. The RANGE button cycles AUTO → these.
  RANGES_M: [50, 150, 500, 2000, 10000],

  // Dev mode is normally opened with ?dev=1 in the URL (or 5 taps on the
  // MK-II badge). Leave this false for the real hunt.
  DEV_MODE: false,
  // Starting point for simulated GPS; defaults to ~350 m from relic 1.
  DEV_START: null, // e.g. { lat: 40.7681, lng: -73.9819 }
};
