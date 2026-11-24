# Discovery surfaces — presentation contracts

The SRS §4.13 surface catalogue is implemented as framework-free client
contracts in `client/src/presence/`. Each module defines the descriptor
the native layer renders from — what a surface can show is decided and
audited before a pixel exists, and every descriptor passes the shared
prohibition registry in `surfaceIntegrity.ts`.

The §4.13.10 acceptance target anchors the whole design: after one
session, a first-time user describes the product as
*"it shows you what you have in common with someone nearby before you know who they are."*

## Component map

| SRS component | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| MatchDiagram | FR-76, TR-35, NFR-35 | `matchSurface.ts` (over `matchDiagram.ts`) | The match is presented as the convergence of the two interest paths on their shared nodes — one `ConvergingPath` per shared node and a headline that names the commonality. The descriptor's field set is fixed at `{headline, paths}`; no photo, name, or handle can occupy it, and the `matchSurfaceViolations` guard scans for identity-shaped keys and registry hits. Rendered entirely from the reason payload via the TR-35 diagram — no other data source reaches the surface. |
| PresenceHalo | FR-77, FR-78 | `presenceHalo.ts` | Density is a field, never a map: a 0..1 intensity rising monotonically with the k-anonymised aggregate count, plus a qualitative level (`calm`/`stirring`/`lively`/`buzzing`) that is forbidden from carrying digits so the raw count cannot leak. The type has no positional or directional component — that absence IS the FR-77 compliance — and invalid counts fail closed to the calmest field. |
| OfferWindow | FR-79, FR-33 | `offerWindow.ts` | Expiry is a closing perimeter: a 0..1 fraction, monotonic non-increasing over the 30-minute offer window (`OFFER_WINDOW_MS` mirrors the edge's `OFFER_TTL_MS`, pinned equal). The default render physically never computes seconds — `secondsRemaining` is null unless the user explicitly opted into the numeric form. |
| discovery skeleton | FR-80 | `discoverySkeleton.ts` | Pairs, rooms, and tables share one pinned region list (`header`, `modeSelector`, `resultRegion`, `statusTray`); only the result content differs. Each mode carries a pinned one-sentence explanation shown once per user (seen-set under the allowlisted `presence.ui.seenExplanations` key, wiped on logout per TR-30; a corrupt seen-set fails toward explaining again). A mode change while a conversation is open is deferred, never interrupting. The affordance list has no load-more — the result region renders one bounded payload. |
| (all surfaces) | FR-87, FR-77 | `surfaceIntegrity.ts` | One prohibition registry: engagement mechanics (infinite/auto-loading scroll, typing indicators, read receipts, streaks, daily-login rewards, like/view counts, photo-at-match) and proximity elements (map, direction indicator, distance value, radius, heat-map, proximity arrangement). `descriptorViolations` scans affordances and field keys; every surface above passes by construction, and the conversation surfaces (later batch) inherit the same registry. |

## What is deliberately NOT here

RoomBoard (FR-45) and TableCard (FR-66/67) render inside the shared
skeleton's result region — their content contracts are server-side
already; their client rendering follows with the conversation batch.
The ConstellationPicker (FR-81), HoldToWave (FR-82/83), the co-location
close offer (FR-84), and the ambient surfaces (FR-86, content governed
by SEC-35) are the interaction batch — HoldToWave's affordance name is
already pinned on the match surface so the gesture lands without a
descriptor change.
