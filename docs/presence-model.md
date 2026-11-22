# Valkey presence model

Live presence is ephemeral and lives only in Valkey 8 (ARC: Valkey over Redis
for licence posture; RESP-compatible client). Nothing here touches Postgres.

| Key | Type | TTL | Writer | Reader |
|---|---|---|---|---|
| `presence:user:{userId}` | STRING JSON `{cell, venueId}` | 900 s (FR-14) | edge | edge, match |
| `presence:cell:{cellId}` | SET userIds | — | edge | match |
| `presence:venue:{venueId}` | SET userIds | — | edge | edge (density, TR-14) |
| `suppress:{lo}:{hi}` | STRING `1` | 600 s (FR-23) | edge | edge |

Rules:

- **TTL is the source of truth.** `presence:user:{id}` carries the fifteen-
  minute TTL (FR-14); the cell set is only an index. Readers filter set
  members whose user key has expired (`EXISTS` pipeline), so a crashed client
  disappears from scans within fifteen minutes without any sweeper process.
- **Cells, never coordinates.** Clients compute their H3 res-11 cell
  on-device; the server coarsens it to the venue's active resolution
  (TR-12/14) and rejects any coordinate-shaped field (TR-15).
- **Suppression is canonical.** Pair keys are ordered (`lo < hi`) so either
  side's scan sees the same key. Ten minutes (FR-23).
- **Corpus refresh.** The match service rebuilds the document-frequency table
  from the link-free closures of the live population every 60 s (TR-05) by
  scanning `presence:user:*`.
