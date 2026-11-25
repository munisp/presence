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

## RealtimeDeliverySlow

- **Owner:** realtime-oncall
- **Symptom:** realtime publish p95 above 500 ms for 15 minutes
  (`presence_realtime_publish_duration_seconds`).
- **Impact:** NFR-07 breach — sender-to-recipient-device delivery can no
  longer meet its 500 ms p95 budget while the server-side leg alone is this
  slow; messages, match notifications and nudges all arrive late.
- **First actions:**
  1. Check Centrifugo health and its Valkey engine (TECH-06) — publish
   latency is usually broker or broker-redis latency, not edge CPU.
  2. Check the channel-class breakdown on the histogram: a single hot
   channel class points at a fan-out hotspot, all classes slow points at
   Centrifugo/Valkey.
  3. Check `presence_realtime_publish_failures_total` alongside — slowness
   with failures rising is a broker under distress, not just load.
- **Escalate if:** p95 keeps rising after a Centrifugo restart, or failures
  exceed publishes succeeding — treat as realtime outage and follow the
  platform incident process.

## ScanAvailabilityBurn

- **Owner:** edge-oncall
- **Symptom:** scan-path 5xx share burning the NFR-13 99.9% availability
  budget — 1 h window above 14.4x burn AND 6 h window above 6x burn on
  `presence_http_requests_total{route=~"/v1/(scan|presence)"}`.
- **Impact:** the discovery surface is erroring for real users; at this burn
  rate the 30-day 99.9% budget exhausts within hours. Both windows firing
  means this is sustained, not a blip.
- **First actions:**
  1. Identify the failing leg from the `route` label breakdown — `/v1/scan`
   points at the match path (match service, Valkey, taxonomy cache),
   `/v1/presence` at the publish path (Valkey writes, event attribution).
  2. Check dependency health in order: match service 5xx and p95, Valkey
   latency, Postgres connections. Most availability burns are dependency
   failures, not edge code.
  3. If the burn started with a deploy, roll back immediately — the ACC-06
   path (`.github/workflows/rollback.yml`, `docs/ops/rollback.md`) is the
   10-minute revert.
- **Escalate if:** the burn survives a rollback, or dependencies are healthy
  while 5xx continue — treat as platform incident and freeze deploys.
