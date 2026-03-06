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

## How to access apps

dot.li supports two URL formats:

| Format | Example |
|--------|---------|
| **Subdomain** | `https://myapp.dot.li` |
| **Path** | `https://dot.li/myapp.dot` |

### Landing page

When visiting the root (`dot.li`, or `paritytech.github.io/dotli/`), a landing page is shown with:

- A **search bar** where users type an app name (`.dot` suffix is pre-filled) and navigate
- **Recently visited** apps shown as pill-shaped shortcuts (persisted in localStorage)
- A **Polkadot App login** button in the top-right corner

The topbar is hidden on the landing page and only appears when viewing an app.

## What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/nickelc/smoldot) light client connected to Asset Hub Paseo, querying dotNS contracts through the Revive EVM pallet.
2. **Fetches** content from the [Bulletin Chain](https://github.com/nickelc/polkadot-bulletin-chain) via [Helia](https://github.com/ipfs/helia) P2P (bitswap), with IPFS gateway fallback.
3. **Renders** the content in a sandboxed iframe with a full host-container bridge, so loaded SPAs can request accounts, sign transactions, connect to chains, and use scoped storage — all through postMessage.

```
myapp.dot.li  (or  dot.li/myapp.dot)
    → smoldot resolves dotNS → IPFS CID
    → Helia fetches content (P2P or gateway)
    → iframe renders with host-container bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served through a Service Worker that acts as a virtual file system.

## How resolution works

1. Parse label from URL — subdomain (`mytestapp.dot.li` → `mytestapp`) or path (`/mytestapp.dot` → `mytestapp`)
2. Compute ENS-style namehash of `mytestapp.dot`
3. Call `recordExists(node)` on the dotNS Registry contract via Revive dry-run
4. Call `contenthash(node)` on the dotNS ContentResolver contract
5. Decode the contenthash bytes to an IPFS CID (using `@ensdomains/content-hash`)
6. Fetch the CID content and render it

All contract calls are read-only dry-runs executed through the smoldot light client — no RPC server needed.

## How multi-file SPAs work

When a CID points to an IPFS directory (not a single file):

1. The gateway returns a CAR (Content Addressable aRchive) containing all files
2. `archive.ts` parses the CAR using `@ipld/car` + `@ipld/dag-pb` + `ipfs-unixfs` to extract a file map
3. The file map is sent to the Service Worker via `postMessage`
4. The iframe loads from `/dotli-app/index.html` — the SW intercepts all requests and serves files from the in-memory archive
5. Relative imports (`<script src="main.js">`, `<link href="styles.css">`) just work

## Caching and verification

dot.li uses a two-layer cache for fast repeat visits:

1. **CID cache** (IndexedDB) — maps `.dot` labels to their last-known CID
2. **Archive cache** (Service Worker) — stores fetched file maps keyed by domain + CID

On repeat visits, content renders instantly from cache while smoldot validates the CID in the background. The topbar shield indicates the verification state:

| Shield | Meaning |
|--------|---------|
| Yellow | Validating — rendering from cache, checking on-chain |
| Green | Verified — on-chain CID matches cached version |
| Orange | Gateway — resolved via gateway, awaiting chain confirmation |
| Red | Outdated — on-chain CID differs; an update banner appears |

## Host-container bridge

Loaded SPAs communicate with dot.li through `@novasamatech/host-container`, a postMessage-based protocol. The bridge exposes:

| Handler | What it does |
|---------|-------------|
| `accountGet` | Derives a per-app public key via HDKD soft derivation |
| `signPayload` / `signRaw` | Shows signing modals, delegates to host-papp session |
| `chainConnection` | Returns a smoldot-backed JsonRpcProvider for supported chains |
| `localStorageRead/Write/Clear` | Scoped `localStorage` per `.dot` domain |
| `navigateTo` | Opens URLs in new tabs |
| `featureSupported` | Reports supported chain genesis hashes |
| `connectionStatus` | Streams auth state changes to the SPA |

## Development

```bash
npm install
npm run dev
```

Local dev uses wildcard subdomains: `mytestapp.localhost:5173` resolves `mytestapp.dot`.

## Network configuration

The app currently targets **Paseo testnet**:

- **dotNS Registry**: `0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f`
- **dotNS ContentResolver**: `0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7`
- **Bulletin Chain peers**: 4 Parity-hosted collator/RPC nodes (WebSocket)
- **IPFS gateway**: `https://paseo-ipfs.polkadot.io`

All addresses and endpoints are in `src/config.ts`.
