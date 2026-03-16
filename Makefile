REMOTE = ubuntu@51.158.111.82
DEPLOY_PATH = /var/www/dotli
NGINX_CONF = /etc/nginx/sites-available/dot.li

.PHONY: build deploy deploy-nginx

build:
	bun run build

deploy: build
	rsync -avz --delete apps/host/dist/ $(REMOTE):$(DEPLOY_PATH)/host/
	rsync -avz --delete apps/sandbox/dist/ $(REMOTE):$(DEPLOY_PATH)/app/

deploy-nginx:
	scp nginx/nginx.conf $(REMOTE):/tmp/dotli.nginx
	ssh $(REMOTE) 'sudo cp /tmp/dotli.nginx $(NGINX_CONF) && sudo nginx -t && sudo systemctl reload nginx'
