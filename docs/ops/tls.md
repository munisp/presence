# TLS posture and OCSP stapling (INF-11, TR-26)

The APISIX gateway is the sole public ingress (TECH-21) and terminates TLS
1.3 only — the listener cannot negotiate anything older (TR-26). HSTS and
CSP are set on every API response. This runbook covers the revocation side
of the posture: OCSP stapling at the gateway, and how to collect the
production evidence that it works.

## Design

- The certificate is issued by cert-manager (Let's Encrypt chain) into the
  `apisix-tls` secret; `tls.crt` carries the leaf plus intermediates.
- The gateway staples the CA's OCSP attestation: `ssl_stapling on` +
  `ssl_stapling_verify on` in the APISIX `nginx_config`, with
  `ssl_trusted_certificate` pointing at the mounted chain and the OCSP
  responder lookup resolved through cluster DNS (`resolver
  kube-dns.kube-system.svc.cluster.local`). Clients therefore receive
  revocation status inside the handshake and never query the CA directly —
  a privacy and latency property, and it removes the hard-fail question
  for clients that do check revocation.
- Short-lived certificates are the second line: even if a staple is
  missed, exposure is bounded by the issuance lifetime.

## Verifying in production (the INF-11 evidence)

Run the collector after every certificate renewal (the issuance chain
rotates roughly every 60–90 days) and record the output in the ops log:

```
python3 scripts/check_tls_posture.py --host api.presence.example
```

Expected tail:

```
TLS posture holds; OCSP stapling verified against api.presence.example
```

The collector requires `OCSP Response Status: successful` and a TLS 1.3
handshake from `openssl s_client -status`, and is budget-capped at 30 s so
a hanging network path fails the check instead of stalling the runbook.
The equivalent raw command, if the collector is unavailable:

```
openssl s_client -connect api.presence.example:443 \
  -servername api.presence.example -status </dev/null | grep -A2 "OCSP Response"
```

Owner: platform. Escalate a failed staple to the cert-manager issuance
chain first (expired or unreachable responder), then to the gateway
configuration.
