# dot.li — container image for the Kubernetes/Summit deployment.
#
# Two stages:
#   1. builder  — reproduces the on-box `bun run build:prod` (VITE_NETWORKS=summit),
#                 producing the three SPA dists (host / sandbox / protocol).
#   2. runtime  — Ubuntu nginx + the brotli modules, mirroring the VM exactly
#                 (same APT_PACKAGES as the Makefile) so `brotli_static` in
#                 nginx/snippets/dotli-precompressed.conf loads and the
#                 pre-compressed .br/.gz assets are served. TLS is terminated
#                 upstream by traefik; this image serves plaintext on :80.
#
# Build context = repo root. Image is host-routed (apex/*/host/*.app) by
# deploy/nginx.k8s.conf, which mirrors nginx/nginx.conf.template.

# ──────────────────────────────── builder ────────────────────────────────
FROM oven/bun:1.3.6-debian AS builder

# Native module toolchain (node-gyp fallbacks) — cheap insurance for the
# monorepo install; smoldot ships prebuilt wasm so this is rarely exercised.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lockfile-first for layer caching. bun.lock + every workspace manifest.
COPY package.json bun.lock turbo.json ./
COPY apps ./apps
COPY packages ./packages
# Root build helpers — apps' build:prod runs `bun ../../scripts/compress-dist.ts`
# to emit the .br/.gz assets that nginx's brotli_static/gzip_static serve.
COPY scripts ./scripts

# Frozen install, then the production build. VITE_NETWORKS is required by
# packages/config/src/network.ts (getEnabledNetworks throws without it) and
# pins the bundle to Summit — same value the Makefile injects for ENV=summit.
ENV VITE_NETWORKS=summit
RUN bun install --frozen-lockfile \
 && bun run build:prod

# ──────────────────────────────── runtime ────────────────────────────────
FROM ubuntu:24.04 AS runtime

# Same nginx + brotli packages the VM provisions (Makefile APT_PACKAGES).
# The brotli modules drop a loader into /etc/nginx/modules-enabled/ and
# auto-load, so `brotli_static on;` works.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      nginx \
      libnginx-mod-http-brotli-filter \
      libnginx-mod-http-brotli-static \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf

# Shared header/CSP/precompressed/service-worker snippets, copied verbatim so
# the include paths match the VM (/etc/nginx/snippets/dotli-*.conf).
COPY nginx/snippets/ /etc/nginx/snippets/

# The Summit vhost (server_name routing + the three webroots).
COPY deploy/nginx.k8s.conf /etc/nginx/conf.d/dotli.conf

# The three SPA builds → the roots referenced by deploy/nginx.k8s.conf.
COPY --from=builder /app/apps/host/dist/     /usr/share/nginx/html/host/
COPY --from=builder /app/apps/sandbox/dist/  /usr/share/nginx/html/app/
COPY --from=builder /app/apps/protocol/dist/ /usr/share/nginx/html/protocol/

# Fail the build early if the vhost or modules are misconfigured.
RUN nginx -t

EXPOSE 80
STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
