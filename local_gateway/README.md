# Local dot.li gateway

A Caddy HTTPS front-end for local dot.li development. Serves the built
`apps/*/dist` folders directly (mirroring production nginx) behind
production-shaped hostnames (`https://*.dot.li.localhost`) with a
locally-trusted certificate, so the app sees the same subdomain layout it
does in production.

## What it does

Caddy terminates TLS and routes by Host header to the pre-built bundles:

| URL                                  | Static root          | Build    |
| ------------------------------------ | -------------------- | -------- |
| `https://dot.li.localhost`           | `apps/host/dist`     | host     |
| `https://<name>.dot.li.localhost`    | `apps/host/dist`     | host     |
| `https://<cid>.app.dot.li.localhost` | `apps/sandbox/dist`  | app      |
| `https://host.dot.li.localhost`      | `apps/protocol/dist` | protocol |

Each origin has an SPA fallback to `index.html`, matching the `try_files`
behaviour of the production nginx config.

## Requirements

- `docker` + `docker compose` (or `podman` / `podman-compose`)
- `sudo` (to add the Caddy local CA to your trust store)
- Ports `80` and `443` free on the host

## Setup

First, build the apps from the monorepo root (Caddy serves `apps/*/dist`,
so they must exist):

```bash
# bun install
bun run build
```

Then bring up the gateway:

```bash
cd local_gateway
./setup.sh
```

This starts Caddy, waits for it to generate a local CA, and installs that
CA into your system trust store.

Visit `https://dot.li.localhost`.

> **Firefox on Linux:** Firefox uses its own NSS trust store. Open
> `about:config`, set `security.enterprise_roots.enabled` to `true`, and
> restart — this makes Firefox trust the system CA store.

## Lifecycle

```bash
./start.sh   # docker compose up -d
./stop.sh    # docker compose down
```

The CA lives in `./data/` (bind-mounted, gitignored). If you delete `./data/`,
re-run `./setup.sh` to regenerate and re-trust the CA.

After rebuilding the apps (`bun run build`), the new files are picked up
on the next request — no gateway restart needed, since `apps/*/dist` is
bind-mounted into the container.

## Configuration

Override ports if 80/443 are taken:

```bash
HTTP_PORT=8080 HTTPS_PORT=8443 ./start.sh
```
