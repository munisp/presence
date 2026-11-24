# Interaction surfaces — presentation contracts

The second half of the SRS §4.13 surface catalogue — the surfaces the
user touches — is implemented as framework-free client contracts in
`client/src/presence/`, on the same discipline as the discovery
surfaces (`docs/ux/discovery-surfaces.md`): each module defines the
descriptor the native layer renders from, what a surface can do is
decided and audited before a pixel exists, and every descriptor passes
the shared prohibition registry in `surfaceIntegrity.ts`.

## Component map

| SRS component | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| ConstellationPicker | FR-81 | `constellationPicker.ts` | Interest selection offers the spatial constellation AND text search — `PICKER_MODES` is pinned to both. Every node carries the `selectable: true` literal, so an unselectable node cannot typecheck and three declarations always fit the four-interaction budget (`REQUIRED_DECLARATIONS` 3 against `MAX_PICKER_INTERACTIONS` 4, exactly one spare); `auditInteractionSequence` re-checks any real sequence with deselect netting. Local popularity renders only at or above the k-anonymity floor (`POPULARITY_K_FLOOR` 11, cross-pinned to the edge aggregate `K_MIN`) — a raw small count renders nothing. The descriptor's field set is fixed at `{mode, nodes}`. |
| HoldToWave | FR-82, FR-83 | `holdToWave.ts`, `haptics.ts` | The wave exists only at or beyond `WAVE_PRESS_MIN_MS` (400 ms) on the control: a clamped 0..1 progress ramp with quartered haptic stages, monotonic non-decreasing, garbage input failing closed to no press. Early release cancels; leaving the control cancels at any duration; `tapCannotWave` proves no sub-threshold tap can ever fire. The affordance name was pinned on the match surface in the discovery batch, so the gesture lands without a descriptor change. Every legal FR-29 transition — the five pinned in `CONSENT_TRANSITIONS`, cross-pinned to `services/consent-go` — carries a pairwise-distinct haptic signature (`hapticsAreDistinct`) plus a named audio cue and spoken announcement (`audibleWithoutHaptics`), so a state change survives haptics-off, pocket, and eyes-free use; unknown transitions fail closed to no feedback. |
| close offer | FR-84 | `closeOffer.ts` | After `COLOCATION_CLOSE_OFFER_MIN_MS` (15 minutes) of co-location in an open conversation, the client offers once to close the thread and stop notifications, carrying the pinned basis sentence ("if you've met…"). Accepting closes the thread and stops notifications; declining returns the conversation snapshot byte-identical (`declineLeavesIntact`) — the decline path cannot touch the conversation. The state machine moves due → shown → declined\|accepted and never returns, so the offer is asked at most once per conversation. Broken clocks fail closed to no offer. |
| ambient surfaces | FR-86, SEC-35 | `ambientSurfaces.ts` | The three named surfaces — lock-screen indicator, Live Activity, home-screen widget — are individually opt-in (`setAmbientPreference` flips exactly one), off by default, and disableable in one pinned action with no confirmation step (`planDisable`). The payload is contentless by construction: `AmbientPayload` has exactly `{kind, active}` — no field an identity, a reason, a count, or a location could occupy — and `ambientPayloadViolations` still audits every payload against the forbidden-field list before anything reaches the OS ambient layer. Preferences persist under the allowlisted `presence.ambient.prefs` key (the seventh TR-30 key, wiped on logout) and parse fails closed to all-off. |

## What is deliberately NOT here

The conversation surfaces — the chat thread itself and the client
rendering of RoomBoard (FR-45) and TableCard (FR-66/67) inside the
shared skeleton's result region. Their content contracts are already
server-side; when they land they inherit the same FR-87 registry, and
that is where the typing-indicator and read-receipt bans bind.

Also not here: the journey contracts (FR-03, FR-08, FR-41, FR-48) —
the ≤3-tap end-to-end journeys that wire the picker, the wave gesture,
and the conversation flows into complete paths. The interaction
contracts above are the building blocks those journeys compose.
