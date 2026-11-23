#!/usr/bin/env bash
# SEC-06: generate the self-signed DEV-ONLY certificate the compose APISIX
# terminates TLS 1.3 with. Run once from the repo root:
#
#   bash deploy/apisix/dev-tls.sh
#
# The certificate is for localhost development only — it carries no trust,
# is gitignored, and must never be deployed. K8s uses cert-manager (SEC-07).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p tls
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout tls/dev-key.pem -out tls/dev-cert.pem \
  -days 365 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "dev TLS certificate written to deploy/apisix/tls/ (gitignored)"
