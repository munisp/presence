# Rendered UI — screens, navigation and theme

The client batches 34–46 built the enforceable contracts; batch 47
renders them. Every screen is a framework-free descriptor tree built in
`client/src/presence/ui/screens.ts`, navigated by the pure state machine
in `navigation.ts`, styled by the derived theme in `theme.ts`, and
mapped onto React Native by the thin renderer in `client/src/ui/render.tsx`.
The split keeps everything the SRS can pin testable under plain
`node --test`; the RN half is typechecked, never executed under node —
the split the pinned build config encodes.

## Component map

| Piece | Governing | Module | What it guarantees |
| --- | --- | --- | --- |
| theme | NFR-25/26 | `ui/theme.ts` | No colour literal exists in the theme — every colour resolves from `CLIENT_PALETTE`, so the WCAG audit covers the theme by construction. Type sizes come from the palette entries and scale through the pinned dynamic-type clamp ([1, 2], garbage → 1). Motion resolves through the pinned reduced-motion plan: reduce (or an unreadable preference) zeroes every duration. Spacing is the 4 pt grid; off-grid multiples fail closed to null. |
| navigation | BR-07 | `ui/navigation.ts` | The stack covers the four pinned app screens plus the match overlay (hosted on discovery). Unknown destinations, duplicate pushes and back-from-root all fail closed to the unchanged state. `safetyReachable` proves every screen × safety action plans within the two-tap budget through the host screen. |
| screens | FR-76/77/80/87/89, BR-07 | `ui/screens.ts` | One builder per screen: discovery renders exactly the pinned skeleton regions (FR-80); the match screen interacts only via hold-to-wave and the tray (FR-76/82); the conversation affordances are the pinned thread list — typing indicators and read receipts are absent from the source type (FR-87); check-in presents the FR-89 primary first with the pinned fallback notice; settings carries privacy controls and account deletion. `auditUiScreen` enforces the control contract, the prohibition registry and the tray entry on every tree. |
| tray contents | BR-07 | `ui/screens.ts` | `buildSafetyTrayActions` plans each of the five actions through the BR-07 contract and refuses to build when the plan's endpoint drifts from the pinned wire. |
| copy | NFR-27 | `copyRegistry.ts` | Every screen label resolves through the registry: English baseline at build time, locale override at render time. A missing baseline key fails the builder closed to null — a screen never renders blank copy. |
| renderer | — | `src/ui/render.tsx` | A pure walk: kind → component, tone → theme style, action → pressable with the a11y label and 44 pt target. No product logic exists here to test. |

## What is deliberately NOT here

- **Pixel-perfect visual design**: layout, illustration and motion
  choreography beyond the pinned durations are design work on top of
  these contracts, not part of them. The descriptor pins what the SRS
  can pin — content, order, affordances, discipline — and leaves the
  canvas open.
- **Live data wiring**: the shell demo in App.tsx wires mode-switch,
  the safety tray and back; match, conversation and check-in screens
  render from contract fixtures in the unit tests and bind to live
  services with the app backend integration.
- **On-device validation**: a real VoiceOver/TalkBack pass and a
  physical one-handed reach study stay ahead — everything the code can
  guarantee before that pass is pinned here.
