#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

CERT_PATH="./data/caddy/pki/authorities/local/root.crt"

if ! sudo test -f "${CERT_PATH}"; then
	printf "CA certificate not found at %s\n" "${CERT_PATH}" >&2
	printf "Start the gateway first: ./start.sh\n" >&2
	exit 1
fi

case "$(uname -s)" in
	Linux*)
		printf "Detected Linux — using trust anchor\n"
		sudo trust anchor "${CERT_PATH}"
		;;
	Darwin*)
		printf "Detected macOS — using security add-trusted-cert\n"
		sudo security add-trusted-cert -d -r trustRoot \
			-k /Library/Keychains/System.keychain "${CERT_PATH}"
		;;
	*)
		printf "Unsupported OS: %s\n" "$(uname -s)" >&2
		exit 1
		;;
esac

printf "CA certificate imported successfully.\n"
