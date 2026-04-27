REMOTE_PRD = ubuntu@51.158.111.82
REMOTE_STG = ubuntu@51.159.177.252

# env tag → site filename in /etc/nginx/sites-available/
SITE_polkadot      := dot.li
SITE_dev-polkadot  := dotli.dev
SITE_paseo         := paseo.li
SITE_dev-paseo     := paseoli.dev
SITE_dev-testnet   := testnet.li
SITE_westend       := westend.li

# env tag → remote (only polkadot is prod; the rest share the staging box)
REMOTE_FOR_polkadot      := $(REMOTE_PRD)
REMOTE_FOR_dev-polkadot  := $(REMOTE_STG)
REMOTE_FOR_paseo         := $(REMOTE_STG)
REMOTE_FOR_dev-paseo     := $(REMOTE_STG)
REMOTE_FOR_dev-testnet   := $(REMOTE_STG)
REMOTE_FOR_westend       := $(REMOTE_STG)

# env tag → web root on the remote (matches the `root` directive in nginx.<env>)
DEPLOY_PATH_polkadot      := /var/www/dotli
DEPLOY_PATH_dev-polkadot  := /var/www/dotlidev
DEPLOY_PATH_paseo         := /var/www/paseoli
DEPLOY_PATH_dev-paseo     := /var/www/paseolidev
DEPLOY_PATH_dev-testnet   := /var/www/testnetli
DEPLOY_PATH_westend       := /var/www/westendli

VALID_ENVS := polkadot dev-polkadot paseo dev-paseo dev-testnet westend

.PHONY: build deploy ci-deploy deploy-nginx

build:
	bun run build

# Usage: make deploy ENV=<polkadot|dev-polkadot|paseo|dev-paseo|dev-testnet|westend>
deploy: build
	@test -n "$(ENV)" || (echo "Usage: make deploy ENV=<$(subst $() ,|,$(VALID_ENVS))> [REMOTE=user@host]"; exit 1)
	@test -n "$(DEPLOY_PATH_$(ENV))" || (echo "Unknown ENV: $(ENV). Valid: $(VALID_ENVS)"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval REMOTE_PATH   := $(DEPLOY_PATH_$(ENV)))
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 -o $$(whoami) -g $$(id -gn) $(REMOTE_PATH) $(REMOTE_PATH)/host $(REMOTE_PATH)/app $(REMOTE_PATH)/protocol'
	$(call _rsync_dist,$(REMOTE_TARGET),$(REMOTE_PATH))

# Usage: make deploy-nginx ENV=<polkadot|dev-polkadot|paseo|dev-paseo|dev-testnet|westend>
deploy-nginx:
	@test -n "$(ENV)" || (echo "Usage: make deploy-nginx ENV=<$(subst $() ,|,$(VALID_ENVS))> [REMOTE=user@host]"; exit 1)
	@test -n "$(SITE_$(ENV))" || (echo "Unknown ENV: $(ENV). Valid: $(VALID_ENVS)"; exit 1)
	$(eval REMOTE_TARGET := $(or $(REMOTE),$(REMOTE_FOR_$(ENV))))
	$(eval SITE := $(SITE_$(ENV)))
	rsync -avz --delete nginx/snippets/ $(REMOTE_TARGET):/tmp/dotli-nginx-snippets/
	scp nginx/nginx.$(ENV) $(REMOTE_TARGET):/tmp/$(SITE).nginx
	ssh $(REMOTE_TARGET) 'sudo install -d -m 0755 /etc/nginx/snippets && sudo rsync -av /tmp/dotli-nginx-snippets/ /etc/nginx/snippets/ && sudo cp /tmp/$(SITE).nginx /etc/nginx/sites-available/$(SITE) && sudo nginx -t && sudo systemctl reload nginx'

# Usage by GitHub Actions workflow
define _rsync_dist
rsync -avz --delete --filter='P /assets/' apps/host/dist/     $(1):$(2)/host/
rsync -avz --delete --filter='P /assets/' apps/sandbox/dist/  $(1):$(2)/app/
rsync -avz --delete --filter='P /assets/' apps/protocol/dist/ $(1):$(2)/protocol/
endef

# CI deploy: reads DEPLOY_USER/DEPLOY_HOST/DEPLOY_PATH from env
ci-deploy:
	@test -n "$(DEPLOY_USER)" || (echo "ci-deploy: DEPLOY_USER not set"; exit 1)
	@test -n "$(DEPLOY_HOST)" || (echo "ci-deploy: DEPLOY_HOST not set"; exit 1)
	@test -n "$(DEPLOY_PATH)" || (echo "ci-deploy: DEPLOY_PATH not set"; exit 1)
	$(call _rsync_dist,$(DEPLOY_USER)@$(DEPLOY_HOST),$(DEPLOY_PATH))
	ssh $(DEPLOY_USER)@$(DEPLOY_HOST) 'find $(DEPLOY_PATH)/*/assets/ -type f -mtime +7 -delete 2>/dev/null || true'
