# Edge DDoS & abuse posture (INF-13)

Layered mitigation; each layer sheds what the layer above cannot see.

| Layer | Mechanism | Where |
|---|---|---|
| L3/L4 volumetric | Cloud load balancer / provider shield in front of the single APISIX ingress (TECH-21). Provider-managed — production evidence. | infrastructure |
| L7 per-source flood | APISIX `limit-count` per `remote_addr`: 1200 req/60 s on `/v1/*`, 120 req/60 s on the Keycloak surface (token/registration endpoints are the credential-stuffing target). Rejections are 429 + counted via the prometheus plugin. | `deploy/k8s/apisix.yaml` |
| In-process velocity | SEC-20 velocity limits (422 with neutral body), 6 scans/min per user, nudge and budget counters in Valkey. | `services/edge` |
| Fail-safe shape | Default-deny NetworkPolicies (INF-12/14) keep every non-public workload unreachable, so a flood cannot fan out laterally. | `deploy/k8s/networkpolicy.yaml` |

## Pre-launch test

`loadtest/ratelimit-probe.js` drives the unauthenticated bootstrap endpoint
(`/v1/client/config`) from one source at 1500 req/min — above the gateway
window — and fails unless (a) 429s are observed and (b) allowed requests keep
p99 ≤ 400 ms (the limiter sheds rather than queues). Run it against every
environment before launch and after every APISIX config change.

## Standing duties

- 429 rate is a dashboard series (`limit-count` rejections via the prometheus
  plugin); a sustained rise is a trust-safety signal, not just noise.
- The windows are tuned to be invisible to real use: the app issues a handful
  of requests per minute per device; 20 rps per IP only trips on floods,
  loops or shared-NAT extremes (campus NAT is why the window is not lower).
- Load-test generators are exempted per environment — see
  `loadtest/README.md` ("Source IPs"); the exemption is never committed for
  production.
