#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if command -v docker &>/dev/null && docker compose version &>/dev/null; then
	COMPOSE_CMD="docker compose"
elif command -v podman &>/dev/null && podman compose version &>/dev/null; then
	COMPOSE_CMD="podman compose"
elif command -v podman-compose &>/dev/null; then
	COMPOSE_CMD="podman-compose"
elif command -v docker-compose &>/dev/null; then
	COMPOSE_CMD="docker-compose"
else
	printf "Error: No compose command found.\n" >&2
	exit 1
fi

${COMPOSE_CMD} down
printf "Local dot.li gateway stopped.\n"
