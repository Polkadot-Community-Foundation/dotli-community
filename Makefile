# macOS Terminal exports LC_CTYPE=UTF-8, which Linux does not recognize, and SSH forwards it to the remote.
export LC_ALL := C.UTF-8

# Deploy targets are not committed. Copy deploy.env.example or pass REMOTE=user@host. CI uses ci-deploy instead.
-include deploy.env

REMOTE_PRD ?=
REMOTE_STG ?=
REMOTE_SUMMIT ?=

# Scratch dir on the remote where the repo is rsynced and built (on-box build).
REMOTE_BUILD_PATH := /tmp/dotli-build

# Per-env build config injected into the on-box `build:prod`. VITE_NETWORKS is
# required by the app (packages/config/src/network.ts throws without it). CI
# passes the equivalent via the GitHub Environment `NETWORKS` var.
# dot.li (the summit slot) serves the products devnet since 2026-07-30; the summit
# chains are retired. Revert to `summit` only if that network comes back.
VITE_NETWORKS_summit := devnet
# devnet = the public products testnet (gateway dev-dot.li). The `devnet`
# network entry must exist in packages/config/src/network.ts before build:prod.
VITE_NETWORKS_devnet := devnet

# Brand variant for the host shell's favicon and install icons, from
# polkadot-app-brand-assets (apps/host/public/brand/<variant>). Unset = the
# stock Polkadot icons; dev-dot.li flies the DEV tile so a devnet tab is
# recognisable next to a production one.
VITE_BRAND_VARIANT_devnet := devnet

# Download target for the "Get Polkadot Desktop" banner (same for every gateway).
# Overrides the app's hardcoded fallback; keep in sync with .env.example.
VITE_DESKTOP_DOWNLOAD_URL := https://github.com/Polkadot-Community-Foundation/polkadot-desktop-community/releases/latest

# NOTE: summit serves dot.li — the same domain as the legacy `polkadot` env.
# This is deliberate (dot.li is being cut over to Summit): the two envs target
# different boxes (REMOTE_PRD vs REMOTE_SUMMIT), so their cert/nginx file
# names never collide on one machine. The `polkadot` rows describe the
# pre-cutover box and remain for reference/rollback.

# Site filename in /etc/nginx/sites-available/
SITE_polkadot      := dot.li
SITE_paseo         := paseo.li
SITE_dev-paseo     := paseoli.dev
SITE_fyi-paseo     := paseo.fyi
SITE_dev-test      := testnet.li
SITE_summit        := dot.li
SITE_devnet        := dev-dot.li

# Only polkadot is prod. The rest share the staging box, except summit and devnet, which share their own box.
REMOTE_FOR_polkadot      := $(REMOTE_PRD)
REMOTE_FOR_paseo         := $(REMOTE_STG)
REMOTE_FOR_dev-paseo     := $(REMOTE_STG)
REMOTE_FOR_fyi-paseo     := $(REMOTE_STG)
REMOTE_FOR_dev-test      := $(REMOTE_STG)
REMOTE_FOR_summit        := $(REMOTE_SUMMIT)
REMOTE_FOR_devnet        := $(REMOTE_SUMMIT)

DEPLOY_PATH_polkadot      := /var/www/dotli
DEPLOY_PATH_paseo         := /var/www/paseoli
DEPLOY_PATH_dev-paseo     := /var/www/paseolidev
DEPLOY_PATH_fyi-paseo     := /var/www/paseofyi
DEPLOY_PATH_dev-test      := /var/www/testnetli
DEPLOY_PATH_summit        := /var/www/summitli
DEPLOY_PATH_devnet        := /var/www/devdotli

# One cert per env at /etc/letsencrypt/live/<base>/, matching the ssl_certificate paths. *.<base> covers host.<base>.
CERT_DOMAINS_polkadot     := dot.li *.dot.li *.app.dot.li
CERT_DOMAINS_paseo        := paseo.li *.paseo.li *.app.paseo.li
CERT_DOMAINS_dev-paseo    := paseoli.dev *.paseoli.dev *.app.paseoli.dev
CERT_DOMAINS_fyi-paseo  := paseo.fyi *.paseo.fyi *.app.paseo.fyi
CERT_DOMAINS_dev-test     := testnet.li *.testnet.li *.app.testnet.li
CERT_DOMAINS_summit       := dot.li *.dot.li *.app.dot.li
CERT_DOMAINS_devnet       := dev-dot.li *.dev-dot.li *.app.dev-dot.li

VALID_ENVS := polkadot paseo dev-paseo fyi-paseo dev-test summit devnet

RATE_LIMITED_ENVS := polkadot paseo dev-test

# Cut from SENTRY_DSN, shaped https://<key>@<ingest-host>/<project-id>.
SENTRY_DSN ?=
_sentry_hostpath := $(lastword $(subst @, ,$(SENTRY_DSN)))
SENTRY_INGEST    := $(firstword $(subst /, ,$(_sentry_hostpath)))
SENTRY_PROJECT   := $(lastword  $(subst /, ,$(_sentry_hostpath)))

ENV ?= paseo

# Checked out as truapi/hosts/dotli, local builds use the checked-out TrUAPI packages.
TRUAPI_REPO ?= $(abspath ../..)
TRUAPI_LOCAL_PACKAGE := $(TRUAPI_REPO)/js/packages/truapi/package.json
TRUAPI_HOST_LOCAL_PACKAGE := $(TRUAPI_REPO)/js/packages/truapi-host/package.json

# The brotli module is split across two packages on noble, both auto-loaded. curl and ca-certificates back certbot.
APT_PACKAGES := nginx libnginx-mod-http-brotli-filter libnginx-mod-http-brotli-static certbot python3-certbot-dns-cloudflare rsync ufw curl ca-certificates

.PHONY: build build-prod link-truapi-local provision-bun provision provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal renew-cert deploy ci-deploy deploy-nginx render-nginx _require-env _require-env-name

build: link-truapi-local
	npm run build

# Deploys ship the .br and .gz siblings that nginx's brotli_static and gzip_static serve. They build against the
# pinned @parity/truapi: `npm ci` reinstalls from the lockfile, which also drops a link left by `make build` or
# `npm run link:truapi`. --force, because Turbo does not hash node_modules, so a dist cached from a linked build
# would otherwise be reused.
build-prod:
	npm ci
	npm run build:prod -- --force

link-truapi-local:
	@if [ -f "$(TRUAPI_LOCAL_PACKAGE)" ] && [ -f "$(TRUAPI_HOST_LOCAL_PACKAGE)" ]; then \
		TRUAPI_REPO="$(TRUAPI_REPO)" npm run link:truapi; \
	else \
		echo "No local TrUAPI checkout found at $(TRUAPI_REPO); using package manager dependencies."; \
	fi

# Idempotent fresh-server provisioning:
#   make provision ENV=<env> ADMIN_EMAIL=<email> CLOUDFLARE_API_TOKEN=<token> [REMOTE=ubuntu@1.2.3.4]
# The Cloudflare token needs DNS edit permission on the zone.
provision: provision-prereqs provision-firewall provision-cloudflare-creds provision-cert provision-renewal deploy deploy-nginx
	@echo
	@echo "Provisioning complete for ENV=$(ENV)."

provision-prereqs: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'set -euo pipefail; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get update -y; \
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $(APT_PACKAGES); \
		sudo rm -f /etc/nginx/sites-enabled/default'

# OpenSSH first, so enabling ufw never locks us out.
provision-firewall: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo ufw allow OpenSSH && sudo ufw allow "Nginx Full" && sudo ufw --force enable'

# The token is piped over SSH and never written locally.
provision-cloudflare-creds: _require-env
	@test -n "$(CLOUDFLARE_API_TOKEN)" || (echo "CLOUDFLARE_API_TOKEN not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	@printf 'dns_cloudflare_api_token = %s\n' '$(CLOUDFLARE_API_TOKEN)' | ssh $(REMOTE_TARGET) 'sudo install -d -m 0700 /etc/letsencrypt && sudo tee /etc/letsencrypt/cloudflare.ini > /dev/null && sudo chmod 600 /etc/letsencrypt/cloudflare.ini && sudo chown root:root /etc/letsencrypt/cloudflare.ini'

# --keep-until-expiring and --expand make re-runs safe. --cert-name pins live/<name>/ to the ssl_certificate paths.
provision-cert: _require-env
	@test -n "$(ADMIN_EMAIL)" || (echo "ADMIN_EMAIL not set"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval CERT_FLAGS := $(foreach d,$(CERT_DOMAINS_$(ENV)), -d '$(d)'))
	ssh $(REMOTE_TARGET) "sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --dns-cloudflare-propagation-seconds 30 --non-interactive --agree-tos -m '$(ADMIN_EMAIL)' --keep-until-expiring --expand --cert-name $(SITE_$(ENV)) $(CERT_FLAGS)"

provision-renewal: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'sudo systemctl enable --now certbot.timer'

# Ensure bun is present on the remote (the on-box build needs it).
provision-bun: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh $(REMOTE_TARGET) 'set -euo pipefail; \
		if ! command -v bun >/dev/null 2>&1; then \
			curl -fsSL https://bun.sh/install | bash; \
			sudo ln -sf "$$HOME/.bun/bin/bun" /usr/local/bin/bun; \
			sudo ln -sf "$$HOME/.bun/bin/bunx" /usr/local/bin/bunx; \
		fi; \
		bun --version'

# certbot renews only when the cert is due. nginx reloads either way, since the timer's renewals never reload it.
# Without a terminal certbot first waits a random delay of up to 8 minutes, which a run on demand has no use for.
# The keepalive holds the connection while certbot is silent, which the runner's idle timeout otherwise cuts.
renew-cert: _require-env
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	ssh -o ServerAliveInterval=30 $(REMOTE_TARGET) 'sudo certbot renew -v --non-interactive --no-random-sleep-on-renew --cert-name $(SITE_$(ENV)) && sudo nginx -t && sudo systemctl reload nginx && sudo certbot certificates --cert-name $(SITE_$(ENV))'

# ====================================================================
# On-box build deploy. The repo is rsynced to $(REMOTE_BUILD_PATH) on the
# remote, `bun run build:prod` runs there (the box is sized for it), then
# only the resulting dist directories are rsynced into the nginx-served
# paths. Keeps the heavy build off this machine; VITE_NETWORKS is injected
# per-env (see VITE_NETWORKS_<env>).
# ====================================================================
deploy: _require-env provision-bun
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval REMOTE_PATH   := $(DEPLOY_PATH_$(ENV)))
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 -o $$(whoami) -g $$(id -gn) $(REMOTE_BUILD_PATH) $(REMOTE_PATH) $(REMOTE_PATH)/host $(REMOTE_PATH)/app $(REMOTE_PATH)/protocol'
	rsync -avz --delete \
		--exclude='.git/' \
		--exclude='node_modules/' \
		--exclude='.turbo/' \
		--exclude='apps/*/dist/' \
		--exclude='packages/*/dist/' \
		--exclude='test-results/' \
		--exclude='.vite/' \
		--exclude='.cache/' \
		--exclude='coverage/' \
		--exclude='.env' \
		--exclude='.env.*' \
		--exclude='.DS_Store' \
		--exclude='*.log' \
		./ $(REMOTE_TARGET):$(REMOTE_BUILD_PATH)/
	ssh $(REMOTE_TARGET) 'set -euo pipefail; cd $(REMOTE_BUILD_PATH) && bun install --frozen-lockfile && VITE_NETWORKS=$(VITE_NETWORKS_$(ENV)) VITE_BRAND_VARIANT=$(VITE_BRAND_VARIANT_$(ENV)) VITE_DESKTOP_DOWNLOAD_URL=$(VITE_DESKTOP_DOWNLOAD_URL) bun run build:prod'
	ssh $(REMOTE_TARGET) "set -euo pipefail; \
		rsync -av --delete --filter='P /assets/' $(REMOTE_BUILD_PATH)/apps/host/dist/     $(REMOTE_PATH)/host/; \
		rsync -av --delete --filter='P /assets/' $(REMOTE_BUILD_PATH)/apps/sandbox/dist/  $(REMOTE_PATH)/app/; \
		rsync -av --delete --filter='P /assets/' $(REMOTE_BUILD_PATH)/apps/protocol/dist/ $(REMOTE_PATH)/protocol/"

# A literal "#" goes through _hash because make >= 4.3 keeps the backslash of a "\#" inside a function call.
_hash := \#
_nginx_render = DOMAIN='$(SITE_$(ENV))' WEBROOT='$(DEPLOY_PATH_$(ENV))' \
	ZONE='rl_$(subst .,_,$(SITE_$(ENV)))' \
	RL='$(if $(filter $(ENV),$(RATE_LIMITED_ENVS)),,$(_hash))' \
	SENTRY='$(if $(SENTRY_DSN),,$(_hash))' \
	SENTRY_INGEST='$(SENTRY_INGEST)' SENTRY_PROJECT='$(SENTRY_PROJECT)' \
	envsubst '$$DOMAIN $$WEBROOT $$ZONE $$RL $$SENTRY $$SENTRY_INGEST $$SENTRY_PROJECT' < nginx/nginx.conf.template

# Warns on stderr, since render-nginx pipes stdout. Envs without Sentry are legitimate, a silently dead tunnel is not.
_sentry_warn = @test -n "$(SENTRY_DSN)" || \
	echo "WARNING: SENTRY_DSN not set. Rendering with the Sentry tunnel (/t) disabled." >&2

# Prints the rendered nginx config for ENV, with no remote changes.
render-nginx: _require-env-name
	@command -v envsubst >/dev/null || { echo "render-nginx needs 'envsubst' (gettext). Install: brew install gettext / apt-get install gettext-base"; exit 1; }
	$(_sentry_warn)
	@$(_nginx_render)

deploy-nginx: _require-env
	@command -v envsubst >/dev/null || { echo "deploy-nginx needs 'envsubst' (gettext). Install: brew install gettext / apt-get install gettext-base"; exit 1; }
	$(_sentry_warn)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval SITE := $(SITE_$(ENV)))
	$(_nginx_render) > /tmp/$(SITE).nginx
	rsync -avz --delete $(if $(SENTRY_DSN),,--exclude=dotli-sentry-tunnel.conf --delete-excluded) nginx/snippets/ $(REMOTE_TARGET):/tmp/dotli-nginx-snippets/
	scp /tmp/$(SITE).nginx $(REMOTE_TARGET):/tmp/$(SITE).nginx
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 /etc/nginx/snippets && sudo rsync -av /tmp/dotli-nginx-snippets/ /etc/nginx/snippets/ && sudo cp /tmp/$(SITE).nginx /etc/nginx/sites-available/$(SITE) && sudo ln -sf /etc/nginx/sites-available/$(SITE) /etc/nginx/sites-enabled/$(SITE) && sudo nginx -t && sudo systemctl reload nginx'

# Protocol first: a new shell waits for the iframe's `listening` signal, which an older iframe never sends.
define _rsync_dist
rsync -avz --delete --filter='P /assets/' apps/protocol/dist/ $(1):$(2)/protocol/
rsync -avz --delete --filter='P /assets/' apps/sandbox/dist/  $(1):$(2)/app/
rsync -avz --delete --filter='P /assets/' apps/host/dist/     $(1):$(2)/host/
endef

ci-deploy:
	@test -n "$(DEPLOY_USER)" || (echo "ci-deploy: DEPLOY_USER not set"; exit 1)
	@test -n "$(DEPLOY_HOST)" || (echo "ci-deploy: DEPLOY_HOST not set"; exit 1)
	@test -n "$(DEPLOY_PATH)" || (echo "ci-deploy: DEPLOY_PATH not set"; exit 1)
	$(call _rsync_dist,$(DEPLOY_USER)@$(DEPLOY_HOST),$(DEPLOY_PATH))
	ssh $(DEPLOY_USER)@$(DEPLOY_HOST) 'find $(DEPLOY_PATH)/*/assets/ -type f -mtime +7 -delete 2>/dev/null || true'

# No remote required, so render-nginx can use it.
_require-env-name:
	@test -n "$(ENV)" || (echo "ENV not set. Use ENV=<$(subst $() ,|,$(VALID_ENVS))>"; exit 1)
	@test -n "$(DEPLOY_PATH_$(ENV))" || (echo "Unknown ENV: $(ENV). Valid: $(VALID_ENVS)"; exit 1)

_require-env: _require-env-name
	@test -n "$(or $(REMOTE),$(REMOTE_FOR_$(ENV)))" || (echo "No deploy target for ENV=$(ENV). Set REMOTE_PRD/REMOTE_STG in deploy.env (copy deploy.env.example) or pass REMOTE=user@host."; exit 1)
