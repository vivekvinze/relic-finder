# Relic Finder

A GPS treasure-hunt radar. Static files, no build step, no backend.

## Edit the hunt
Everything is in `config.js`. Lines marked `⬅️ CHANGE` hold the three locations, pictures, and hints. Pictures go in `/images`.

## Set locations on-site (dev mode)
1. Open the site in Safari with `?dev=1`, e.g. `https://<user>.github.io/<repo>/?dev=1`. From the installed app, tap the **MK-II** badge 5 times instead.
2. Tap the screen to power on and allow Location.
3. Stand on spot 1 and tap **Set 1**. Hold still for about 6 seconds while it averages GPS. Repeat for 2 and 3.
4. Tap **Copy config**, paste the lines over the lat/lng lines in `config.js`, bump `CACHE_VERSION` in `sw.js`, and commit.

Spots you set are saved only on the phone that set them, which lets you test right away. They reach other phones only after step 4.

Arrival triggers are off in dev mode so setting a spot doesn't "find" it. Turn **Triggers on** to test arrivals with real GPS. **Exit** leaves dev mode.

## Test from your desk
In dev mode, turn **SIM on** to fake GPS. Tap the radar to teleport, or use **Step** / **Arrive**. ⟲ ⟳ simulate turning. **Reset progress** clears found relics, and `?reset=1` does the same on any device.

Local server: `python3 -m http.server 8000` in this folder.

## Deploy to GitHub Pages
1. Create a public repo and upload these files to the root of `main`.
2. Settings → Pages → Deploy from a branch → `main`, `/ (root)`.
3. Your URL appears there after a minute: `https://<user>.github.io/<repo>/`.

After any change, bump `CACHE_VERSION` in `sw.js` so installed copies update. Opening the app twice may be needed for the new version to take over.

## Install on iPhone
Safari → open the URL → Share → **Add to Home Screen**. Launch from the icon, tap the screen to power on, and allow **Location** and **Motion & Orientation**.

## Good to know
- Works only while the app is open and the screen is on.
- A relic triggers after two GPS fixes in a row inside its radius, and only when accuracy is better than `MAX_ACCURACY_M`.
- If the iPhone's silent switch is on, the pings are muted.
- Progress is saved on the device, so closing the app mid-hunt is fine.
