/** FR-79: expiry renders as a closing perimeter, numeric only by opt-in. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_EXPIRY_PREFERENCE,
  DEFAULT_EXPIRY_PRESENTATION,
  OFFER_WINDOW_MS,
  buildOfferWindow,
  expiryPresentation,
  perimeterFractionRemaining,
} from "../src/presence/offerWindow.js";

test("the window mirrors the server's FR-33 offer TTL", () => {
  assert.equal(OFFER_WINDOW_MS, 30 * 60 * 1000);
});

test("the default presentation is the perimeter (FR-79)", () => {
  assert.equal(DEFAULT_EXPIRY_PRESENTATION, "perimeter");
  assert.deepEqual(DEFAULT_EXPIRY_PREFERENCE, { numericCountdown: false });
  assert.equal(expiryPresentation(undefined), "perimeter");
  assert.equal(expiryPresentation(null), "perimeter");
  assert.equal(expiryPresentation({ numericCountdown: false }), "perimeter");
  assert.equal(
    expiryPresentation({} as never),
    "perimeter",
    "a malformed preference still resolves to the perimeter",
  );
});

test("numeric appears only behind an explicit preference", () => {
  assert.equal(
    expiryPresentation({ numericCountdown: true }),
    "numeric",
    "explicit opt-in only",
  );
});

test("the perimeter fraction closes from 1 to 0 over the window", () => {
  const window = OFFER_WINDOW_MS;
  assert.equal(perimeterFractionRemaining(0, window, window), 1);
  assert.equal(perimeterFractionRemaining(window / 2, window, window), 0.5);
  assert.equal(perimeterFractionRemaining(window, window, window), 0);
  assert.equal(
    perimeterFractionRemaining(window * 2, window, window),
    0,
    "clamped at closed",
  );
  assert.equal(
    perimeterFractionRemaining(-window, window, window),
    1,
    "clamped at full",
  );
});

test("the fraction is monotonic non-increasing in time", () => {
  const window = OFFER_WINDOW_MS;
  let previous = Number.POSITIVE_INFINITY;
  for (let now = -window; now <= window * 2; now += window / 20) {
    const fraction = perimeterFractionRemaining(now, window, window);
    assert.ok(fraction <= previous, `monotonic at ${now}`);
    previous = fraction;
  }
});

test("an invalid window fails closed to already-closed", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(perimeterFractionRemaining(0, 1000, bad), 0);
  }
  assert.equal(
    perimeterFractionRemaining(Number.NaN, 1000, OFFER_WINDOW_MS),
    0,
    "invalid timestamps fail closed",
  );
});

test("the default window carries no number — secondsRemaining is null", () => {
  const offer = buildOfferWindow(0, OFFER_WINDOW_MS, OFFER_WINDOW_MS, undefined);
  assert.equal(offer.kind, "offer-window");
  assert.equal(offer.presentation, "perimeter");
  assert.equal(offer.fractionRemaining, 1);
  assert.equal(offer.secondsRemaining, null);
});

test("the numeric form reports whole seconds only when opted in", () => {
  const optedIn = { numericCountdown: true };
  const offer = buildOfferWindow(0, OFFER_WINDOW_MS, OFFER_WINDOW_MS, optedIn);
  assert.equal(offer.presentation, "numeric");
  assert.equal(offer.secondsRemaining, 1800);
  const half = buildOfferWindow(
    OFFER_WINDOW_MS / 2,
    OFFER_WINDOW_MS,
    OFFER_WINDOW_MS,
    optedIn,
  );
  assert.equal(half.secondsRemaining, 900);
  const closed = buildOfferWindow(
    OFFER_WINDOW_MS * 2,
    OFFER_WINDOW_MS,
    OFFER_WINDOW_MS,
    optedIn,
  );
  assert.equal(closed.secondsRemaining, 0, "never negative");
});
