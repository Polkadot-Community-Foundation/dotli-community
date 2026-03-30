REMOTE_DOTLI = ubuntu@51.158.111.82
REMOTE_PASEOLI = ubuntu@51.159.177.252

.PHONY: build deploy deploy-dotli deploy-paseoli deploy-nginx-dotli deploy-nginx-paseoli

build:
	bun run build

deploy: deploy-dotli

deploy-dotli: build
	rsync -avz --delete apps/host/dist/ $(REMOTE_DOTLI):/var/www/dotli/host/
	rsync -avz --delete apps/sandbox/dist/ $(REMOTE_DOTLI):/var/www/dotli/app/
	rsync -avz --delete apps/protocol/dist/ $(REMOTE_DOTLI):/var/www/dotli/protocol/

deploy-paseoli: build
	rsync -avz --delete apps/host/dist/ $(REMOTE_PASEOLI):/var/www/paseoli/host/
	rsync -avz --delete apps/sandbox/dist/ $(REMOTE_PASEOLI):/var/www/paseoli/app/
	rsync -avz --delete apps/protocol/dist/ $(REMOTE_PASEOLI):/var/www/paseoli/protocol/

deploy-nginx-dotli:
	scp nginx/nginx.conf $(REMOTE_DOTLI):/tmp/dotli.nginx
	ssh $(REMOTE_DOTLI) 'sudo cp /tmp/dotli.nginx /etc/nginx/sites-available/dot.li && sudo nginx -t && sudo systemctl reload nginx'

deploy-nginx-paseoli:
	scp nginx/nginx.paseoli $(REMOTE_PASEOLI):/tmp/paseoli.nginx
	ssh $(REMOTE_PASEOLI) 'sudo cp /tmp/paseoli.nginx /etc/nginx/sites-available/paseo.li && sudo nginx -t && sudo systemctl reload nginx'
