# dot.li

A decentralized web browser that runs in your browser. Type `name.dot.li` and get a fully trustless, client-side resolved Polkadot application — no servers in the loop.

## What it does

1. **Resolves** `.dot` names via an in-browser [smoldot](https://github.com/nickelc/smoldot) light client connected to Asset Hub Paseo, querying dotNS contracts through the Revive EVM pallet.
2. **Fetches** content from the [Bulletin Chain](https://github.com/nickelc/polkadot-bulletin-chain) via [Helia](https://github.com/ipfs/helia) P2P (bitswap), with IPFS gateway fallback.
3. **Renders** the content in a sandboxed iframe with a full host-container bridge, so loaded SPAs can request accounts, sign transactions, connect to chains, and use scoped storage — all through postMessage.

```
name.dot.li
    → smoldot resolves dotNS → IPFS CID
    → Helia fetches content (P2P or gateway)
    → iframe renders with host-container bridge
```

Single-file apps are served as blob URLs. Multi-file SPAs (directories) are fetched as CAR archives, parsed, and served through a Service Worker that acts as a virtual file system.

## Architecture

```
src/
├── main.ts          Entry point — URL parsing, orchestration
├── resolve.ts       dotNS name resolution via smoldot light client
├── fetch.ts         Content fetching (Helia P2P → gateway CAR → raw fallback)
├── render.ts        Iframe rendering (blob URL or Service Worker)
├── archive.ts       CAR file parsing (@ipld/car + dag-pb + unixfs)
├── container.ts     Host-container bridge (accounts, signing, storage, chains)
├── chains.ts        Chain provider factory (smoldot → JsonRpcProvider)
├── account.ts       HDKD product key derivation (@scure/sr25519)
├── auth.ts          QR-code auth via @novasamatech/host-papp
├── signing.ts       Signing approval modals (signPayload, signRaw)
├── topbar.ts        Top bar UI (brand, URL pill, auth button)
├── config.ts        Contracts, ABIs, peer addresses, gateway URL
public/
├── sw.js            Service Worker for multi-file SPA serving
```

## How resolution works

1. Parse subdomain from URL (`myapp.dot.li` → `myapp`)
2. Compute ENS-style namehash of `myapp.dot`
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

Currently supported chains: Paseo relay, Asset Hub Paseo.

## Development

```bash
npm install
npm run dev
```

Local dev uses wildcard subdomains: `myapp.localhost:5173` resolves `myapp.dot`.

### Build

```bash
npm run build
```

Output goes to `dist/`. The Service Worker (`sw.js`) is copied from `public/` as-is (not bundled by Vite).

## Key dependencies

| Package | Purpose |
|---------|---------|
| `polkadot-api` + smoldot | Light client for dotNS resolution + chain connections |
| `helia` + `@helia/unixfs` | P2P content fetching from Bulletin Chain |
| `@ipld/car` | CAR archive parsing for multi-file SPAs |
| `@novasamatech/host-container` | postMessage bridge protocol |
| `@novasamatech/host-papp` | QR-code auth with Polkadot mobile app |
| `@scure/sr25519` | HDKD key derivation for per-app accounts |
| `viem` | ABI encoding for Revive contract calls |
| `@ensdomains/content-hash` | Contenthash decoding (IPFS CID extraction) |

## Network configuration

The app currently targets **Paseo testnet**:

- **dotNS Registry**: `0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f`
- **dotNS ContentResolver**: `0x7756DF72CBc7f062e7403cD59e45fBc78bed1cD7`
- **Bulletin Chain peers**: 4 Parity-hosted collator/RPC nodes (WebSocket)
- **IPFS gateway**: `https://paseo-ipfs.polkadot.io`

All addresses and endpoints are in `src/config.ts`.
