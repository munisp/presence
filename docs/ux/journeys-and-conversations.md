# Journeys and conversation surfaces — presentation contracts

The final layer of the SRS §4.13 surface catalogue: the end-to-end
journey contracts (FR-03, FR-08, FR-41, FR-48) and the conversation
surfaces the interaction batch deliberately deferred — the chat thread
and the client rendering of RoomBoard (FR-45) and TableCard (FR-66/67)
inside the shared skeleton's result region. Same discipline as the
discovery (`docs/ux/discovery-surfaces.md`) and interaction
(`docs/ux/interaction-surfaces.md`) batches: framework-free contracts
in `client/src/presence/`, descriptors audited against the shared
prohibition registry before a pixel exists.

## Component map

| SRS component | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| journey contracts | FR-03, FR-08, FR-41, FR-48 | `journeyContracts.ts` | Four journeys, each pinned to its server side. Account deletion is the pinned three-step journey (settings → account → confirm) inside the three-tap budget, ending at DELETE /v1/account, with a structural proof that no step is a support contact. Interest editing mirrors the server 3..20 bounds (cross-pinned to `profile.ts`) and the ≤3-level first interaction, and makes the FR-08/FR-11 acceptance executable: below three declarations `presenceReadiness` blocks the publish with the pinned explanation and offers the picker — which reaches three declarations inside its own interaction budget. Message revocation mirrors the messages.ts 24-hour window and its pinned 410 sentence, offered only for the user's own messages, failing closed on garbage or future timestamps; local conversation delete carries the pinned honesty note ("this device only"). Venue check-in pins the higher-than-cell confidence ordering (FR-89: indoors the cell is the fallback, never the default), a fail-closed code journey posting to POST /v1/presence/checkin, and the tie to the FR-88 refusal's pinned alternative. |
| conversation thread | FR-41, FR-84, FR-87 (+FR-38/SEC-21) | `conversationThread.ts` | The chat surface where the engagement bans bind: `THREAD_AFFORDANCES` is the complete pinned list — send, revoke own, answer the close offer, delete local copy, leave — and typing indicators and read receipts are absent by construction (`typingAndReceiptsBanned`), with the descriptor still audited against the registry (`threadHonoursFr87`). Revocation is planned per message: inside the window the pinned pair-scoped endpoint, past it the server's 410 sentence instead of a dead affordance, and never for someone else's message. The sender's first message is marked for screening (FR-38/SEC-21). The close offer is delegated to `closeOffer.ts` — the threshold and the decline-safety proof have exactly one home. |
| RoomBoard | FR-45, FR-46 (+FR-80, BR-13, SEC-21) | `roomBoard.ts` | Opt-in notes above the crowd threshold, authors hidden. The board mounts in the shared skeleton's result region (`BOARD_REGION` pinned against `SKELETON_REGIONS`). The crowd count is k-suppressed (`ROOM_CROWD_K` 11, cross-pinned to the edge aggregate `K_MIN`): suppressed renders null, and a sub-k count fails closed even if mislabelled. Notes render only above the threshold and are bounded at the mirrored 50-note ring; the note type has no author field and `roomBoardNoteHasNoAuthor` proves absence per note. The one-note-per-five-minutes cadence is mirrored so the compose affordance greys out instead of being refused, garbage clocks fail closed, and the member's first note is marked for screening. |
| TableCard | FR-66, FR-67 (+FR-75, SEC-33) | `tableCard.ts` | Scheduled gathering: exactly time, place, head count, and ONE generated prompt — the field set is pinned, and the prompt is singular in the type. The prompt mirrors the server's buildCards contract (`TABLE_CARD_MIN_SHARED` 2 and `TABLE_CARD_LIMIT` 5 cross-pinned to `groups.ts`): the `generated: true` literal, at least the shared-minimum members, and a member list the client asserts is sorted rather than re-sorting. Joining is self-serve while open and refreshes the shared snapshot on (re-)join (FR-67); the seventh seat is refused (`TABLE_SEAT_MAX` 6, cross-pinned to the SEC-33 route), closed tables refuse, garbage fails closed. The pre-join probe reveals only venue and headcount (FR-75) — the pinned key pair, proven. |

## What is deliberately NOT here

The journey and conversation contracts above close every surface-level
requirement expressible and testable without the React Native runtime.
The client budget contracts (NFR-04/05/29/30/35/36, TECH-16) landed in
their own doc — `docs/ux/client-budgets.md` — leaving seven
client-gated requirements in the traceability matrix (FR-70, NFR-25/26/
27/28/37, TECH-08), which need the runtime itself or land next as
framework-free contracts.
