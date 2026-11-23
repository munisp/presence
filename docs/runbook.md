# Presence P0 runbook (NFR-34)

One entry per alert in `deploy/k8s/prometheusrules.yaml`. Every alert names
an owner; this document is the owner's first-response contract. Escalation:
page owner → service lead → incident commander (per ops policy).

## PresenceSLOBurn

- **Owner:** edge-oncall
- **Symptom:** edge p95 above 120 ms for 15 minutes (INF-01/INF-10).
- **Impact:** scans feel slow; HPA should already be scaling (p95 metric).
- **First actions:**
  1. Check HPA state: `kubectl -n presence get hpa edge` — is it at max
     replicas? If yes, raise `maxReplicas` if node budget allows.
  2. Check Valkey latency (`valkey-cli --latency`) — scan and budget
     counters are Valkey-bound; a slow Valkey shows up as edge latency.
  3. Check match service p95 — the edge delegates scoring; a slow match
     service surfaces here first.
- **Escalate if:** p95 keeps rising after scale-out, or match service is the
  cause (hand to match-oncall).

## PresenceErrorSpike

- **Owner:** edge-oncall
- **Symptom:** 5xx share above 2% for 10 minutes.
- **Impact:** user-facing failures on any surface.
- **First actions:**
  1. `kubectl -n presence logs deploy/edge --tail=200` — logs are scrubbed
     (SEC-29), so request ids are safe to trace end to end (NFR-31).
  2. Check Postgres and Valkey health — most 5xx bursts are dependency
     failures, not code.
  3. If the spike started with a deploy, roll back via the Flagger canary
     (`kubectl -n presence get canary`).
- **Escalate if:** errors persist after dependency recovery.

## PresencePublishFailure

- **Owner:** edge-oncall
- **Symptom:** presence publishes failing (FR-12).
- **Impact:** affected users are invisible to discovery — silent product
  outage.
- **First actions:**
  1. Check Valkey: presence entries are Valkey writes with a 900 s TTL
     (FR-14); a full or evicting Valkey fails publishes first.
  2. Check the FR-99 floor-validation path — a Postgres outage on
     `venue_floors` reads fails publishes with 422s, not 5xx; confirm which.
  3. Confirm APISIX → edge route health (`/healthz`).
- **Escalate if:** Valkey is healthy and publishes still fail.

## MatchRateCollapse

- **Owner:** match-oncall
- **Symptom:** served matches collapse below 20% of the trailing-hour rate
  while scan requests continue.
- **Impact:** users scan and get the quiet state everywhere — discovery
  appears dead.
- **First actions:**
  1. Check corpus refresh: `rebuildCorpus` runs every 60 s (TR-05) and the
     prior refresh every 10 min (TR-36); a stuck refresh freezes document
     frequency and can zero scores — check service logs for
     "corpus refresh failed".
  2. Check taxonomy graph load — a failed `loadGraph` leaves the service
     scoring against a stale or empty graph.
  3. Check Postgres connectivity from the match service (profile reads).
- **Escalate if:** refresh loops are healthy and scores still collapse.

## ModerationQueueAge

- **Owner:** trust-safety-lead
- **Symptom:** oldest untriaged report older than one hour.
- **Impact:** moderation SLA breach; FR-98 auto-removal still protects
  announcements, but user reports wait.
- **First actions:**
  1. Page the on-duty moderator; check queue depth trend, not just the max.
  2. If depth is growing steadily, open a staffing ticket — this is an
   organisational alert, not a code alert.
- **Escalate if:** queue age passes the internal escalation threshold in the
  moderation ops policy.
