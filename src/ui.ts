// dot.li — Pure DOM UI helpers
//
// Status messages, error states, and landing page.
// No heavy dependencies — kept in the eager bundle.

const app = document.getElementById("app") ?? document.body;

/**
 * Show a status message in the loading UI.
 */
export function showStatus(message: string): void {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = message;
  }
}

/**
 * Show an error state.
 */
export function showError(title: string, detail: string): void {
  app.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 40px);font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;">
      <div style="max-width:480px;padding:2rem;text-align:center;">
        <h1 style="font-size:1.5rem;color:#fff;margin-bottom:0.75rem;">${title}</h1>
        <p style="color:#888;line-height:1.6;">${detail}</p>
        <div style="margin-top:1.5rem;display:inline-flex;gap:0.5rem;font-size:0.8rem;color:#555;">
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dot.li</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">dotNS</span>
          <span style="padding:0.25rem 0.6rem;border:1px solid #222;border-radius:4px;">Bulletin</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Show the landing page (no subdomain detected).
 */
export function showLanding(): void {
  app.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 40px);font-family:system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;">
      <div style="text-align:center;max-width:520px;">
        <h1 style="font-size:2.8rem;font-weight:700;color:#fff;letter-spacing:-0.03em;margin-bottom:0.5rem;">
          dot<span style="color:#555;">.li</span>
        </h1>
        <p style="font-size:1.05rem;color:#888;line-height:1.7;margin-bottom:2rem;">
          The decentralized web, in your browser.<br>
          Type <span style="color:#ccc;font-weight:500;">name</span><span style="color:#555;">.dot.li</span> to visit any Polkadot app.
        </p>
        <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:2.5rem;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;"></span>
          <span style="font-size:0.78rem;color:#666;">Resolved client-side via light client — no servers involved</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0.5rem;font-size:0.72rem;color:#555;">
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Trustless</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Client-side</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Light client</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">IPFS</span>
          <span style="padding:4px 10px;border:1px solid #222;border-radius:6px;">Polkadot</span>
        </div>
      </div>
    </div>
  `;
}
