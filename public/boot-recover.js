// Runs before the app (index.html). If one of the app's own scripts fails to load — a page kept from before a deploy
// asks for an asset the deploy removed, and the Worker answers it with index.html ("'text/html' is not a valid
// JavaScript MIME type"), so the app never starts and the window stays blank (Safari, 2026-10-16) — reload once;
// if it fails again within a minute, empty the stored app's caches (the service worker stays, so push keeps working)
// and reload a last time.
// The app's own "vite:preloadError" handler (src/main.tsx) covers lazy pages once the app is running.
// Plain script, no Hebrew, no dependencies: it must work when nothing else does.
(function () {
  var KEY = "app.bootRecover";
  var done = false;
  function recover() {
    if (done) return;
    done = true;
    var now = Date.now();
    var state = null;
    try { state = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { /* storage blocked */ }
    var recent = state && now - state.at < 60000;
    var attempt = recent ? state.n + 1 : 1;
    if (attempt > 2) return; // gave up within this minute: no reload loop
    try { sessionStorage.setItem(KEY, JSON.stringify({ at: now, n: attempt })); } catch (e) { /* storage blocked */ }
    if (attempt === 1) { location.reload(); return; }
    var steps = [];
    // Keep the service worker registered: unregistering it would cancel this device's push subscription.
    // Emptying its caches is enough — a precache miss falls back to the network, so the page comes fresh.
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      steps.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.update().catch(function () {}); }));
      }));
    }
    if (window.caches && caches.keys) {
      steps.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }));
    }
    Promise.all(steps).catch(function () {}).then(function () { location.reload(); });
  }
  window.addEventListener("error", function (event) {
    var el = event.target;
    if (el && el.tagName === "SCRIPT" && el.src && el.src.indexOf(location.origin + "/assets/") === 0) recover();
  }, true);
})();
