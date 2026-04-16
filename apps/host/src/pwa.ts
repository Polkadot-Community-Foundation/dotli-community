/**
 * PWA auto-update registration.
 *
 * The generated host-sw.js calls skipWaiting() + clientsClaim() on install,
 * so a new SW takes over immediately. We just need to:
 *   1. Register the SW
 *   2. Periodically check for updates
 *   3. Reload when a new SW takes control
 */

const UPDATE_INTERVAL_MS = 15 * 60 * 1000;

navigator.serviceWorker
  .register("/host-sw.js")
  .then((registration) => {
    // Force an update check on every page load.
    void registration.update();

    // Poll every 15 minutes while the tab is open.
    setInterval(() => {
      if (navigator.onLine) {
        void registration.update();
      }
    }, UPDATE_INTERVAL_MS);

    // Check when a hidden tab becomes visible again.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void registration.update();
      }
    });
  })
  .catch((err: unknown) => {
    console.warn("[dot.li] SW registration failed:", err);
  });

// Reload only when an *updated* SW takes control, not on first activation.
let hasController = !!navigator.serviceWorker.controller;
navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (hasController) {
    window.location.reload();
  }
  hasController = true;
});
