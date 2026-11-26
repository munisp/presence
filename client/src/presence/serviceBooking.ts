/**
 * Service bookings (SRS Addendum 001 — AMD-SVC-01..05): client contract.
 *
 * A service booking is a marketplace service listing purchased as
 * milestone escrow: the agreed total is committed up-front and released
 * milestone by milestone as the customer confirms work. There is no
 * description, no scheduling free text, no address field — the wire shape
 * has no field that could carry one (FR-87/FR-96/SEC-37 unchanged).
 *
 * The constants and transition tables mirror services/edge/src/services.ts,
 * which mirrors db/migrations/0036_service_bookings.sql; the client test
 * cross-pins all three. The client never decides a transition or an
 * eligibility outcome — it mirrors them so a card can explain its own
 * state; the definer is the only authority.
 *
 * Framework-free by design: pure TypeScript, no imports, so the unit
 * tests run under plain node --test.
 */

/** AMD-SVC-02: the agreed total rides the AMD-PAY-05 ceiling. */
export const SERVICE_MAX_AMOUNT_MINOR = 5_000_000;
/** AMD-SVC-02: 1..12 milestones per booking (the escrow array bound). */
export const SERVICE_MAX_MILESTONES = 12;
/** AMD-SVC-04: an unstarted booking auto-refunds after 168 h. */
export const SERVICE_START_TTL_SECONDS = 604_800;
/** AMD-SVC-04: an in-progress booking escalates to disputed after 30 d. */
export const SERVICE_STALE_SECONDS = 2_592_000;
/** AMD-SVC-02: NGN is the launch currency (AMD-PAY-10). */
export const SERVICE_CURRENCY = "NGN";

/** AMD-SVC-01: the booking state machine. */
export const SERVICE_BOOKING_STATES = [
  "accepted", "in_progress", "completed", "cancelled", "disputed",
] as const;
export type ServiceBookingState = (typeof SERVICE_BOOKING_STATES)[number];

/**
 * AMD-SVC-01: every legal booking transition — byte-identical to the
 * service_bookings_guard transition table in the migration.
 */
export const SERVICE_BOOKING_TRANSITIONS: ReadonlyArray<
  readonly [ServiceBookingState, ServiceBookingState]
> = [
  ["accepted", "in_progress"],
  ["accepted", "cancelled"],
  ["accepted", "disputed"],
  ["in_progress", "completed"],
  ["in_progress", "disputed"],
  ["disputed", "completed"],
  ["disputed", "cancelled"],
];

// ---------------------------------------------------------------------------
// Wire shapes (fail closed)
// ---------------------------------------------------------------------------

/** The wire shape of a booking row (GET /v1/services/bookings[/mine]). */
export interface ServiceBookingWire {
  bookingId: string;
  listingId: string;
  customer: string;
  provider: string;
  agreedMinor: number;
  currency: string;
  milestones: number;
  escrowId: string;
  state: ServiceBookingState;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  disputedAt: string | null;
}

/**
 * The wire shape of one booking event. `eventId` is a bigserial — it
 * crosses the wire as a string (node-pg int8). `toState` is a booking
 * state or "milestone_confirmed" (the event stream records milestone
 * releases inside in_progress).
 */
export interface ServiceEventWire {
  eventId: string;
  actor: string | null;
  fromState: string | null;
  toState: string;
  at: string;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * A wire booking the client cannot read is dropped, never repaired: an
 * unknown state or a shape with a free-text field is tampering, not data.
 */
export function parseServiceBookingWire(body: unknown): ServiceBookingWire | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 14) return null;
  const {
    bookingId, listingId, customer, provider, agreedMinor, currency,
    milestones, escrowId, state, createdAt, startedAt, completedAt,
    cancelledAt, disputedAt,
  } = body;
  if (!isUuid(bookingId) || !isUuid(listingId) || !isUuid(escrowId)) return null;
  if (!isUuid(customer) || !isUuid(provider)) return null;
  if (customer === provider) return null;
  if (!isMinor(agreedMinor) || agreedMinor === 0
      || (agreedMinor as number) > SERVICE_MAX_AMOUNT_MINOR) return null;
  if (currency !== SERVICE_CURRENCY) return null;
  if (typeof milestones !== "number" || !Number.isSafeInteger(milestones)
      || milestones < 1 || milestones > SERVICE_MAX_MILESTONES) return null;
  if (typeof state !== "string"
      || !(SERVICE_BOOKING_STATES as readonly string[]).includes(state)) {
    return null;
  }
  if (typeof createdAt !== "string") return null;
  if (!isIsoOrNull(startedAt) || !isIsoOrNull(completedAt)
      || !isIsoOrNull(cancelledAt) || !isIsoOrNull(disputedAt)) return null;
  return {
    bookingId, listingId, customer, provider,
    agreedMinor: agreedMinor as number, currency, milestones, escrowId,
    state: state as ServiceBookingState,
    createdAt, startedAt, completedAt, cancelledAt, disputedAt,
  };
}

/** An event wire the client cannot read is dropped, never repaired. */
export function parseServiceEventWire(body: unknown): ServiceEventWire | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 5) return null;
  const { eventId, actor, fromState, toState, at } = body;
  if (typeof eventId !== "string" || !/^[0-9]+$/.test(eventId)) return null;
  if (actor !== null && !isUuid(actor)) return null;
  if (fromState !== null && (typeof fromState !== "string"
      || !(SERVICE_BOOKING_STATES as readonly string[]).includes(fromState))) {
    return null;
  }
  if (typeof toState !== "string" || toState.length < 1 || toState.length > 32) {
    return null;
  }
  if (typeof at !== "string") return null;
  return { eventId, actor, fromState, toState: toState as string, at };
}

// ---------------------------------------------------------------------------
// Booking drafting (AMD-SVC-02) — the client-known refusals
// ---------------------------------------------------------------------------

export interface ServiceBookingDraft {
  listingId: string;
  agreedMinor: number;
  milestones: number;
}

export type ServiceBookingRefusal =
  | "not_a_service"
  | "listing_not_listed"
  | "invalid_amount"
  | "invalid_milestones";

/**
 * The refusals the client can know before the wire: the listing must be a
 * listed service kind, the amount rides the AMD-PAY-05 ceiling, the
 * milestone count fits the escrow array bound. Self-booking, KYC, blocks
 * and the provider's standing are server-side — the browse projection
 * carries no seller (FR-30), so the client cannot know them.
 */
export function buildServiceBookingDraft(
  listing: { listingId: string; kind: string; state: string },
  agreedMinor: number,
  milestones: number,
): { ok: true; draft: ServiceBookingDraft } | { ok: false; refusal: ServiceBookingRefusal } {
  if (listing.kind !== "service") return { ok: false, refusal: "not_a_service" };
  if (listing.state !== "listed") return { ok: false, refusal: "listing_not_listed" };
  if (!Number.isSafeInteger(agreedMinor) || agreedMinor <= 0
      || agreedMinor > SERVICE_MAX_AMOUNT_MINOR) {
    return { ok: false, refusal: "invalid_amount" };
  }
  if (!Number.isSafeInteger(milestones) || milestones < 1
      || milestones > SERVICE_MAX_MILESTONES) {
    return { ok: false, refusal: "invalid_milestones" };
  }
  return { ok: true, draft: { listingId: listing.listingId, agreedMinor, milestones } };
}

/**
 * The milestone schedule the definer builds: an even split, the last
 * milestone absorbing the remainder, so the parts always sum to the
 * agreed total. Byte-identical to the book_service loop.
 */
export function milestoneAmounts(agreedMinor: number, milestones: number): number[] {
  if (!Number.isSafeInteger(agreedMinor) || agreedMinor <= 0
      || agreedMinor > SERVICE_MAX_AMOUNT_MINOR
      || !Number.isSafeInteger(milestones)
      || milestones < 1 || milestones > SERVICE_MAX_MILESTONES) {
    return [];
  }
  const base = Math.floor(agreedMinor / milestones);
  const out: number[] = [];
  for (let i = 1; i <= milestones; i += 1) {
    out.push(i === milestones ? agreedMinor - base * (milestones - 1) : base);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting, badges, action rules
// ---------------------------------------------------------------------------

/** Deterministic NGN formatting: ₦50,000.00 — no locale APIs. */
export function formatServiceAmount(
  amountMinor: number,
  currency: string = SERVICE_CURRENCY,
): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const naira = Math.floor(abs / 100);
  const kobo = String(abs % 100).padStart(2, "0");
  const grouped = String(naira).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${grouped}.${kobo}`;
}

/** Short state badge for a booking card. */
export function serviceBookingBadge(state: ServiceBookingState): string {
  switch (state) {
    case "accepted": return "Booked — waiting for the provider";
    case "in_progress": return "Work in progress";
    case "completed": return "Completed";
    case "cancelled": return "Cancelled";
    case "disputed": return "In dispute";
  }
}

/** The viewer's role on a booking, or null when they are not a party. */
export function serviceRole(
  booking: Pick<ServiceBookingWire, "customer" | "provider">,
  viewerId: string,
): "customer" | "provider" | null {
  if (booking.customer === viewerId) return "customer";
  if (booking.provider === viewerId) return "provider";
  return null;
}

/**
 * The next milestone awaiting confirmation, derived from the event
 * stream: the count of milestone_confirmed events plus one, or null when
 * every milestone is released. The booking row alone does not carry
 * per-milestone state (it lives in the escrow). A completed booking's
 * final release arrived as the "completed" event, not a
 * milestone_confirmed — the state check covers that.
 */
export function nextMilestone(
  booking: Pick<ServiceBookingWire, "milestones" | "state">,
  events: ReadonlyArray<Pick<ServiceEventWire, "toState">>,
): number | null {
  if (booking.state === "completed" || booking.state === "cancelled") {
    return null;
  }
  const confirmed = events.filter((e) => e.toState === "milestone_confirmed").length;
  if (confirmed >= booking.milestones) return null;
  return confirmed + 1;
}

/** The start action exists only on an accepted booking the viewer provides. */
export function canStartService(
  state: ServiceBookingState,
  viewerIsProvider: boolean,
): boolean {
  return state === "accepted" && viewerIsProvider;
}

/** The confirm action exists only on an in-progress booking the viewer
 * booked, while a milestone remains. */
export function canConfirmMilestone(
  state: ServiceBookingState,
  viewerIsCustomer: boolean,
  next: number | null,
): boolean {
  return state === "in_progress" && viewerIsCustomer && next !== null;
}

/** Either party may dispute a live booking; nobody may dispute a closed one. */
export function canDisputeService(
  state: ServiceBookingState,
  viewerIsParty: boolean,
): boolean {
  return (state === "accepted" || state === "in_progress") && viewerIsParty;
}

/**
 * The render model for a booking card: the structured rows a surface
 * shows, in order. No free text exists to render (FR-96/SEC-37).
 */
export function serviceBookingItems(
  booking: Pick<ServiceBookingWire, "state" | "agreedMinor" | "milestones">,
  role: "customer" | "provider",
  events: ReadonlyArray<Pick<ServiceEventWire, "toState">>,
): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [
    { label: "State", value: serviceBookingBadge(booking.state) },
    { label: role === "customer" ? "You pay" : "You earn",
      value: formatServiceAmount(booking.agreedMinor) },
  ];
  const confirmed = events.filter((e) => e.toState === "milestone_confirmed").length;
  const done = booking.state === "completed" ? booking.milestones : confirmed;
  items.push({ label: "Milestones", value: `${done} of ${booking.milestones} released` });
  return items;
}
