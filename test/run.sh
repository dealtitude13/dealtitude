#!/usr/bin/env bash
# Runs the end-to-end test against a real Postgres.
#
# The stand-in push service has to speak HTTPS, because web-push refuses a
# plain-http endpoint. So we mint a throwaway cert for 127.0.0.1 and hand it to
# Node as an extra CA rather than switching TLS verification off — a test that
# disables verification stops testing the thing it is there to test.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.test ] && { set -a; . ./.env.test; set +a; }
: "${DATABASE_URL:?set DATABASE_URL (see .env.example)}"
: "${ADMIN_KEY:?set ADMIN_KEY}"

mkdir -p test/tmp
if [ ! -f test/tmp/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout test/tmp/key.pem -out test/tmp/cert.pem -days 3650 \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
fi

NODE_EXTRA_CA_CERTS="$PWD/test/tmp/cert.pem" \
NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
exec node test/api.test.js
