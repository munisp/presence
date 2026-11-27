# WhatsApp channel — the member-facing contract

Batch 69 (AMD-WA-01..06) adds WhatsApp as the third notification channel
alongside realtime and push. It is an OPT-IN channel with proof of phone
ownership, designed for the markets where WhatsApp is the default
messaging surface and data is metered: a member who links their phone
gets the match notice, the pair-opened notice, announcements and safety
notices there — nothing else, by construction.

## The member journey

1. **Link.** Settings → WhatsApp → enter the phone in international
   format. The edge normalizes to strict E.164 (`+234…`); anything else
   is refused before a row exists. A phone already bound to another
   account answers 409 — phones are unique across the platform.
2. **Verify.** The member receives a 6-digit code via the
   `presence_verify_code` template and has 10 minutes and 5 attempts to
   redeem it. A re-send inside 60 seconds is refused (the cooldown is in
   the definer, not the UI). Until the code redeems, the row is
   `pending` and nothing is ever sent to it except codes.
3. **Active.** Notices now arrive on WhatsApp alongside realtime+push.
   The member's own FR-58 category switches still gate every notice —
   WhatsApp never widens what a member receives, it only changes where.
4. **Revoke — three ways, all honoured instantly.** DELETE the link in
   the app; or text STOP (also STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT)
   to the business number; both land the `stopped` state and NO notice
   is ever sent again. Texting START (or UNSTOP) resumes a stopped
   number; HELP is recorded for support follow-up. A re-link in the app
   always demands a fresh verification code.

## What the channel never carries

- **No free-form content.** Sends are template-only from a governed
  five-template catalogue; there is no session-message path at all.
- **No wallet or value movement.** There is deliberately no wallet
  template — money is never announced on a third-party channel.
- **No message text at rest.** Inbound messages are reduced to their
  keyword at the parser; the database stores keyword + phone +
  timestamp, never the text.
- **No unverified phone.** A `pending` row receives codes and nothing
  else; a `stopped` row receives nothing — not even safety notices
  (those still arrive via realtime+push; FR-58 exempts safety from the
  category switch, it does not resurrect a revoked channel).
- **No full phone in logs or projections.** The member's own GET
  projection masks the phone (`+234****5678`); the log scrubber redacts
  phone-shaped fields and E.164-shaped substrings anywhere.

## Rate and volume discipline

- **20 notices per member per rolling 24 hours** (the daily cap bites
  before the send; a capped notice is counted, not sent).
- **One template per ref per UTC day** — a re-driven notification
  (retried request, replayed event) collapses onto the same dedupe key.
- The link surface is rate-limited (10/min) and the webhook sits behind
  the standard 120/min webhook limit.

## Compose walkthrough (dev only)

Compose runs with `WHATSAPP_DEV_ECHO=1`: the sender echoes inside the
process and the link response carries `devCode`, so the whole journey —
link → verify → receive a nudge notice → STOP → START — is walkable end
to end without Meta credentials. The echo flag has NO k8s entry: it
cannot exist in a deployed environment.

## Failure honesty

- Unconfigured webhook secrets answer 503 (never a silent 200).
- An unconfigured sender makes the leg a documented no-op that records
  nothing — the realtime and push channels are unaffected.
- A failed send finalizes the delivery `failed` with the reason; the
  mutation that triggered the notice still succeeds (fire-and-forget,
  same discipline as push).
