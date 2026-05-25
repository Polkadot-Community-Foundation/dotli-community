// Surfaces a banner when the browser reports offline status.
//
// As a PWA the host shell boots entirely from the service worker cache, so
// losing connectivity is otherwise invisible to the user. The banner sits
// below the topbar and clears itself once `online` fires again.

let banner: HTMLElement | null = null;

function ensureBanner(): HTMLElement {
  if (banner) {
    return banner;
  }
  const el = document.createElement("div");
  el.id = "offline-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = "You are offline";
  el.style.cssText = [
    "position: fixed",
    "top: 40px",
    "left: 0",
    "right: 0",
    "z-index: 999",
    "background: #b45309",
    "color: #fff",
    "font-size: 0.75rem",
    "font-weight: 500",
    "text-align: center",
    "padding: 4px 12px",
    "letter-spacing: 0.02em",
    "display: none",
  ].join("; ");
  document.body.appendChild(el);
  banner = el;
  return el;
}

function update(): void {
  const el = ensureBanner();
  el.style.display = navigator.onLine ? "none" : "block";
}

window.addEventListener("online", update);
window.addEventListener("offline", update);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", update, { once: true });
} else {
  update();
}
