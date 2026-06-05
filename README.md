<div align="center">

# dot.li

[![Website](https://img.shields.io/badge/dot.li-online-blue?style=flat-square)](https://dot.li)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Polkadot](https://img.shields.io/badge/polkadot-ecosystem-E6007A?style=flat-square&logo=polkadot)](https://polkadot.com)

A decentralized web browser that runs in your browser. Visit any Polkadot application with fully trustless, client-side resolution — no servers in the loop.

[Website](https://dot.li) | [Report an Issue](https://github.com/paritytech/dotli/issues)

</div>

---

> [!IMPORTANT]
> dot.li is open-sourced as a proof-of-concept from Parity's Product Engineering team, provided for reference and educational use. Read it, fork it, and deploy your own version to whatever network and name you choose. It has not undergone a formal security audit. See [Security](#security) before relying on it.

## How to access apps

dot.li resolves apps by **subdomain** — the `.dot` name is the host:

| Format        | Example                     |
| ------------- | --------------------------- |
| **Subdomain** | `https://testingout.dot.li` |

### Landing page

When visiting the root (`dot.li`), a landing page is shown with:

- A **search bar** where users type an app name (a `.dot` suffix label is shown next to the input) and navigate
- **Recently visited** apps shown as pill-shaped shortcuts (persisted in localStorage)
- A **login** button in the top-right corner

The topbar is hidden on the landing page and only appears when viewing an app.

## Architecture

dot.li uses a **two-build, per-product subdomain architecture** that separates concerns between the host shell and the app content layer:

```
name.dot.li              Host build (topbar, dotns resolution, smoldot, bridge)
                          Resolves name -> CID, iframes name.app.dot.li with the CID
                          threaded through the URL contract

name.app.dot.li          App build (CID from URL contract, content fetch, render)
                          Reads CID from URL, fetches via bitswap/gateway, renders
```

| URL                     | Role         | What happens                                                                |
| ----------------------- | ------------ | --------------------------------------------------------------------------- |
| `testingout.dot.li`     | Host shell   | Resolves `testingout` via dotns, iframes `testingout.app.dot.li?cid=bafy..` |
| `testingout.app.dot.li` | App content  | Reads CID from URL contract, fetches content, renders                       |
| `dot.li`                | Landing page | Search bar, recent apps                                                     |

Each product gets its own `<label>.app.dot.li` origin, so versions of the same product share an origin while different products stay isolated for SW/storage/security purposes.

### What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/paritytech/smoldot) light client connected to Asset Hub Paseo, querying dotNS contracts through the Revive EVM pallet.
2. **Fetches** content from the [Bulletin Chain](https://github.com/paritytech/polkadot-bulletin-chain) via smoldot `bitswap_v1_get` JSON-RPC or an IPFS gateway according to what the user picks.
3. **Renders** the content in a sandboxed iframe with a full host-container bridge, so loaded SPAs can request accounts, sign transactions, connect to chains, and use scoped storage — all through postMessage.

```
testingout.dot.li
    -> Host: smoldot resolves dotNS -> IPFS CID
    -> Host: iframes <label>.app.dot.li with cid in URL contract
    -> App:  fetches content via smoldot bitswap_v1_get or IPFS gateway
    -> App:  renders dApp in sandboxed iframe with container bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served through a Service Worker that acts as a virtual file system.

### What it doesn't do

- It is **not** a wallet or key custodian. Per-app keys are derived on demand via HDKD soft derivation, and signing is delegated to the connected Polkadot App session.
- It does **not** run its own RPC servers or backends. Chain access is through an in-browser smoldot light client, and dotNS records are read directly from the Revive pallet's contract storage (read-only).
- It does **not** pin or host content. Content is fetched from the Bulletin Chain or an IPFS gateway and served locally per session.
- It is **not** a production-hardened product. Treat it as a reference blueprint (see [Security](#security)).

## How resolution works

1. Parse the label from the subdomain (`testingout.dot.li` -> `testingout`)
2. Compute the ENS-style namehash (`node`) of the name — the resolver tries `app.<label>.dot` first and falls back to `<label>.dot`
3. Read the `contenthash` bytes for `node` directly from the dotNS ContentResolver contract storage — the resolver computes the Solidity mapping slot and reads it via `chainHead_v1_storage` (no contract method call, no dry-run)
4. Decode the contenthash bytes to an IPFS CID (using `@ensdomains/content-hash`)
5. Create an iframe to `<label>.app.dot.li?cid=<cid>` which fetches and renders the content

All chain access is read-only storage reads through the smoldot light client — no RPC server needed. (An optional gateway backend reads the same storage over a public RPC node instead.)

## How multi-file SPAs work

When a CID points to an IPFS directory (not a single file):

1. The gateway returns a CAR (Content-Addressable aRchive) containing all files
2. `archive.ts` parses the CAR using `@ipld/car` + `@ipld/dag-pb` + `ipfs-unixfs` to extract a file map
3. The file map is sent to the app Service Worker via `postMessage`
4. The iframe loads from `/dotli-app/index.html` — the SW intercepts all requests and serves files from the in-memory archive
5. Relative imports (`<script src="main.js">`, `<link href="styles.css">`) just work

## Caching and verification

dot.li uses a two-layer cache for fast repeat visits:

1. **CID cache** (IndexedDB) — maps `.dot` labels to their last-known CID
2. **Archive cache** (Service Worker) — stores fetched file maps keyed by domain; a cache hit additionally requires the stored CID (and content backend) to match

On repeat visits, content renders instantly from the cache while it is resolved in the background. The topbar shield shows how the current page was loaded:

| Shield           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Green (Verified) | Checked by your in-browser light client (the default smoldot backend)         |
| Orange (Trusted) | Served by an external RPC provider or IPFS gateway, not light-client verified |

If a background re-resolution finds the on-chain CID has changed, dot.li shows a **New version available** notification with a **Reload** action rather than swapping content silently.

## Host-container bridge

Loaded SPAs communicate with dot.li through a postMessage-based protocol. The bridge exposes:

| Handler                        | What it does                                                           |
| ------------------------------ | ---------------------------------------------------------------------- |
| `accountGet`                   | Derives a per-app public key via HDKD soft derivation                  |
| `getLegacyAccounts`            | Returns non-derived (imported) accounts — always empty on the web host |
| `signPayload` / `signRaw`      | Shows signing modals, delegates to host-papp session                   |
| `chainConnection`              | Returns a smoldot-backed JsonRpcProvider for supported chains          |
| `localStorageRead/Write/Clear` | Scoped `localStorage` per `.dot` domain                                |
| `navigateTo`                   | Opens URLs in new tabs                                                 |
| `featureSupported`             | Reports whether a feature is supported (e.g. a chain's genesis hash)   |
| `connectionStatus`             | Streams auth state changes to the SPA                                  |

### Nested dApp support

dApps can embed other dApps via iframes (e.g. a marketplace app embedding a payments app). The host automatically detects nested dApps and creates separate bridges for each one, regardless of nesting depth.

When the host receives a protocol message from an unknown iframe window, it dynamically creates a new container bridge targeting that window. The dApp SDK always sends to `window.top`, so all nested dApps communicate directly with the host — no relay needed.

The app context uses `document.write()` to eliminate extra iframe nesting: when loaded inside a host iframe, the app replaces its own document with the dApp content so the dApp occupies the iframe directly.

## Development

### Prerequisites

- A recent Chromium- or Firefox-based browser with SharedWorker and Service Worker support.
- [Bun](https://bun.sh) 1.3+ and Node 22+ to build locally.
- **No funded account is required** to browse and resolve `.dot` names — resolution is trustless, client-side, and read-only.
- A Polkadot wallet/extension is only needed to log in via the Polkadot App and sign transactions inside a loaded dApp.
- The app targets **Paseo testnet** out of the box (see [Network configuration](#network-configuration)); point it at another chain by editing `packages/config`.

The project uses [Bun](https://bun.sh) and [Turborepo](https://turbo.build).

```bash
curl -fsSL https://bun.sh/install | bash
bun install
bun run preview          # Build + serve both apps on localhost:5173
```

Local development uses wildcard subdomains:

- `testingout.localhost:5173` — resolves `testingout.dot` via the host
- `bafyrei....app.localhost:5173` — fetches and renders CID content directly

### Running an approved build

Releases are published as GitHub Releases tagged `vX.Y.Z` (the latest published tag is what the hosted dot.li deployment runs). To reproduce a specific approved version from a fresh checkout:

```bash
git checkout v0.5.0       # any published release tag
bun install
bun run build:prod        # production build of both apps
```

The published tag on the [Releases page](https://github.com/paritytech/dotli/releases) is the source of truth for what is deployed; rebuild from that tag to verify a deployment.

## Debug panel

dot.li ships a TrUAPI debug panel that aggregates host-side activity (boot/resolve/render/bridge events, TrUAPI host↔product messages, host-papp SSO/session events) into one time-aligned inspector. The panel chunk is dynamically imported, so users who never see it pay no download cost.

In builds compiled with `VITE_APP_DEBUG=true` (local `bun run preview:debug`, and the staging dev deploys at `paseoli.dev` / `dotli.dev`) the panel auto-mounts collapsed. In staging/production it's off until you click **Open in debug mode** in the host Settings menu (or append `?debug=true` to any URL). The choice is sessionStorage-scoped — closing the tab clears it. Use `?debug=off` to silence it explicitly within the same session.

See [packages/truapi-debug/DEBUG_PANEL.md](packages/truapi-debug/DEBUG_PANEL.md) for the full reference — event sources, views, filters, correlation keys, and how to add a new instrumentation hook.

## Sandbox API Checker

dApps rendered in dot.li's sandboxed iframe should communicate exclusively through the container bridge (postMessage), not use web APIs directly. The sandbox checker detects restricted API usage and reports violations in a UI panel.

The checker is activated by defining `VITE_SANDBOX_CHECKER` at build time (e.g. `=true`). When the env var is unset, the gated import is statically eliminated, so the checker is tree-shaken out of production builds entirely.

### Monitored APIs

| Category | APIs                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| Network  | `fetch`, `XMLHttpRequest`, `WebSocket`, `RTCPeerConnection`, `EventSource`, `sendBeacon` |
| Workers  | `Worker`, `SharedWorker`, `ServiceWorker.register`                                       |
| Storage  | `localStorage`, `sessionStorage`, `IndexedDB`, `CacheStorage`, `document.cookie`         |
| DOM      | `document.createElement('iframe')`                                                       |
| Wallet   | `window.injectedWeb3`, `window.polkadot`, `window.ethereum`                              |

Same-origin requests (static dApp files served by the Service Worker) are excluded from reporting for `fetch` and `XMLHttpRequest`. Violations are logged, but calls still proceed (log-and-forward pattern).

The violation panel appears at the bottom of the viewport when the first violation is detected, showing the API name, details, and timestamp for each call.

## Network configuration

The app targets **Paseo testnet** out of the box, via the `PASEO_NEXT_V2` network (the default returned by `defaultNetwork()`):

- **dotNS Registry**: `0xa1b2b939E82b2ecE55Bd8a0E283818BfC1CA6CDc`
- **dotNS ContentResolver**: `0x8A26480b0B5Df3d4D9b95adc24a5Ecb33A5b8F64`
- **Bulletin Chain RPC**: `wss://paseo-bulletin-next-rpc.polkadot.io` (WebSocket)
- **IPFS gateway**: `https://paseo-bulletin-next-ipfs.polkadot.io`

All addresses and endpoints live in `packages/config/src/network.ts` (`NETWORK_NAME_TO_SERVICES_CONFIG`).

## Security

dot.li is a **proof-of-concept reference implementation** and has **not** undergone a formal, independent security audit. Treat it accordingly:

- **Use as a reference, not a dependency.** The `@dotli/*` packages are workspace-internal (`private`) and are not published to npm. Copying or vendoring this code into another system means inheriting unaudited code — review it yourself and pin to a specific commit or tag.
- **Trust model.** Name resolution and content verification run client-side against the configured chain. Content fetched via an IPFS gateway is marked gateway-resolved until the on-chain CID is confirmed (see [Caching and verification](#caching-and-verification)). Do not treat gateway-served content as chain-verified.
- **Sandboxing.** Loaded dApps run in a cross-origin sandboxed iframe and must communicate through the postMessage container bridge. The optional [Sandbox API Checker](#sandbox-api-checker) helps catch dApps that reach for restricted web APIs directly.

### Reporting a vulnerability

This repository inherits the organization-wide security policy. **Do not** open a public issue for security reports. Follow the Parity security policy at [SECURITY](./SECURITY.md).

## License

dot.li is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`). See [LICENSE](./LICENSE) for the full text. Each workspace package declares `AGPL-3.0-only` in its `package.json`.

Third-party dependencies are distributed under their own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
