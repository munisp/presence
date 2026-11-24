# ADR 0010: East-west mutual authentication via Linkerd

Status: accepted

## Context

TR-03 requires all inter-service communication to run over private network
transport with mutual authentication. The NetworkPolicies (INF-12/INF-14)
already isolate the private transport — only declared flows exist — but they
authenticate nothing: any pod that satisfied a selector could speak to a
workload. The east-west surface is edge↔match, edge↔centrifugo API,
edge↔keycloak (JWKS), workloads→postgres/valkey, and the monitoring scrape
and OTLP flows.

Options:

1. **Application-level mTLS** — each service presents and requires client
   certificates. Full control, but every runtime (TS, Go, Rust) needs its own
   TLS stack, certificate issuance and rotation plumbing, and the
   certificate-lifecycle burden lands on application teams.
2. **Istio** — the incumbent mesh. Enovy sidecars, rich traffic policy, and a
   control plane heavy enough to need its own operator and upgrade runway at
   P0 team size.
3. **Linkerd** — Rust micro-proxy, mTLS on by default between meshed pods,
   no application code changes, smallest operational footprint of the three.
4. **Cilium (kernel-level)** — no sidecars, but mutual authentication depends
   on the newer SPIFFE-based path and couples the decision to the CNI.

## Decision

Linkerd. The presence namespace carries `linkerd.io/inject: enabled`
(deploy/k8s/namespace.yaml), so every P0 workload is meshed at admission and
all pod-to-pod traffic is mutually authenticated and encrypted transparently.
NetworkPolicies stay — they remain the flow allowlist; Linkerd adds the
identity and encryption layer on top. The restricted Pod Security profile is
kept: the cluster must run the Linkerd CNI plugin (or grant the init
container its one capability) as documented in deploy/k8s/README.md.

## Consequences

No application code changes; the OTel exporter, Centrifugo client and pg/
ioredis drivers are untouched. Service identity becomes SPIFFE-based, which
ServerAuthorization resources can later consume for per-flow authorization
beyond what NetworkPolicies express. Linkerd becomes a required install step
before `kustomize build | kubectl apply` — without it the injection
annotation is inert and traffic falls back to plaintext inside the (still
default-deny) NetworkPolicy envelope; the README's post-install check
(`linkerd viz edges`) is the verification step in staging.
