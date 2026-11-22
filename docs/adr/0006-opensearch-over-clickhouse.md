# ADR 0006: OpenSearch over ClickHouse

Status: accepted (lands P2)

## Context

Analytics needs both aggregations (band curves, venue health) and log/text
search (moderation, support). ClickHouse is the faster column store;
OpenSearch covers both workloads adequately.

## Decision

OpenSearch for analytics and search in P2. ClickHouse is reconsidered only if
aggregation latency on the eval/venue dashboards becomes the bottleneck.

## Consequences

One analytics cluster to operate; eval band/venue curves land there unchanged
from `eval_score.py`'s output shape.
