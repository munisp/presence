# Identity reveal and accessibility — trust and inclusion contracts

FR-70 and the accessibility triplet (NFR-25, NFR-26, NFR-37) close the
same way the surface batches did: the enforceable client half lands as
framework-free contracts in `client/src/presence/`, audited fail-closed
in CI. FR-70 is a rendering guarantee — the verification badge exists
wherever identity is revealed; the accessibility triplet is a set of
measurable properties — contrast ratios, target sizes, reach geometry —
that are pinned as constants and pure functions every descriptor and
the shell palette are audited against.

## Component map

| SRS item | Governing | Contract module | What it guarantees |
| --- | --- | --- | --- |
| verification at reveal | FR-70 | `verificationBadge.ts` | The identity-reveal registry is exactly the three surfaces the SRS names — the offer, the table roster and the booked slot — and account settings is deliberately not among them: the status appears at the moment of reveal, not only behind settings. A reveal descriptor is built from the FR-51 attestation STATE alone; the badge label is pinned in the module ("Verified" / "Not verified"), so a surface can never forge a friendlier status. Unregistered surfaces, blank display names and garbage states fail closed to null, and the audit flags a label that does not match its state. The FR-52 trust score stays server-side behind it, feeding the moderation queue rather than the badge. |
| WCAG 2.2 AA | NFR-25 | `accessibility.ts` | Contrast is the WCAG relative-luminance formula over #RRGGBB, with the shell palette pinned per role and audited against the AA floors (4.5:1 normal text, 3:1 large text and non-text; large = ≥18 pt or ≥14 pt bold). The contract caught a real violation at introduction: the note colour #5C6B77 measured 3.50:1 against the shell background at 12 pt — below the floor — and moved to #74879B (5.2:1). Dynamic type is pinned to the 200 % WCAG resize floor with the OS preference clamped into [1, 2] (garbage fails closed to 1). Reduced motion is a pinned instant fallback: an unreadable preference is treated as "reduce", never as "animate". Screen-reader labelling and focus order are audited per control: non-empty label, registered role, unique non-negative focus position. Unparseable colours fail closed to null, which the audits treat as a violation. |
| touch targets | NFR-26 | `accessibility.ts` | Every interactive control declares a touch TARGET, and the declared target — not the visual glyph — must be at least 44 × 44 pt in both dimensions. Smaller glyphs are legal only behind a target that meets the floor; non-finite or undersized targets are audit violations. |
| one-handed reach | NFR-37 | `accessibility.ts` | The primary action is reachable when its top edge sits at or below the lower-40 % line of the display (fraction 0.6 pinned, reference device 6.1-inch / 844 pt logical height). Exactly on the line counts; above it refuses. Garbage geometry — NaN, non-positive height, negative or off-screen positions — fails closed: an unmeasurable action is out of reach by definition. |

## What is deliberately NOT here

Five requirements remain client-gated in the traceability matrix:
NFR-27 (localisation — English at launch, localisable without code
changes), NFR-28 (OS floors with graceful BLE-floor degradation) and
TECH-08 (OpenMLS/vodozemac E2E crypto with libsignal prohibited).
These are the next batch's scope. On-device assistive-technology
validation (a real VoiceOver/TalkBack pass, a physical one-handed
reach study) is not expressible as a contract and stays out of scope
here — what this module pins is everything the code can guarantee
before that pass.
