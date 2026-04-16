#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

CERT_PATH="./data/caddy/pki/authorities/local/root.crt"

if command -v docker &>/dev/null && docker compose version &>/dev/null; then
	COMPOSE_CMD="docker compose"
elif command -v podman &>/dev/null && podman compose version &>/dev/null; then
	COMPOSE_CMD="podman compose"
elif command -v podman-compose &>/dev/null; then
	COMPOSE_CMD="podman-compose"
elif command -v docker-compose &>/dev/null; then
	COMPOSE_CMD="docker-compose"
else
	printf "Error: No compose command found. Install docker compose or podman-compose.\n" >&2
	exit 1
fi

printf "Starting local dot.li gateway (using %s)...\n\n" "${COMPOSE_CMD}"
${COMPOSE_CMD} up -d

printf "Waiting for CA certificate to be generated (requires sudo — Caddy writes as root)...\n"
timeout=30
while ! sudo test -f "${CERT_PATH}" && [ ${timeout} -gt 0 ]; do
	sleep 1
	timeout=$((timeout - 1))
done

if ! sudo test -f "${CERT_PATH}"; then
	printf "Timeout waiting for CA certificate\n" >&2
	exit 1
fi

printf "Importing local CA certificate...\n"
./certificates/trust_ca.sh

printf "\nSetup complete.\n"
printf "Make sure you've run 'bun run build' from the monorepo root, then visit:\n"
printf "  https://dot.li.localhost\n"
printf "  https://<name>.dot.li.localhost\n\n"
printf "To stop: ./stop.sh\n"
