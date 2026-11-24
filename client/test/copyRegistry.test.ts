/**
 * NFR-27: the localisation contract — registry shape, fallback floor,
 * fail-closed edges, and the data-only locale proof.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ADDITIONAL_LOCALES_COMMITTED,
  ADDITIONAL_LOCALES_WINDOW_MONTHS,
  ENGLISH_COPY,
  LAUNCH_LOCALE,
  copyHonoursNfr27,
  isValidLocaleTag,
  localeCoverage,
  localeIsLaunchReady,
  resolveCopy,
  type LocaleBundle,
} from "../src/presence/copyRegistry.js";

test("NFR-27: launch locale is English and the commitment is pinned", () => {
  assert.equal(LAUNCH_LOCALE, "en");
  assert.equal(ADDITIONAL_LOCALES_COMMITTED, 2);
  assert.equal(ADDITIONAL_LOCALES_WINDOW_MONTHS, 3);
});

test("NFR-27: the English baseline has no empty strings", () => {
  const keys = Object.keys(ENGLISH_COPY);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.ok(ENGLISH_COPY[key].trim() !== "", `empty baseline string: ${key}`);
  }
});

test("NFR-27: a full bundle overrides English on every key", () => {
  const bundle: LocaleBundle = {
    tag: "yo",
    copy: Object.fromEntries(
      Object.keys(ENGLISH_COPY).map((key) => [key, `yo:${key}`]),
    ),
  };
  for (const key of Object.keys(ENGLISH_COPY)) {
    assert.equal(resolveCopy(bundle, key), `yo:${key}`);
  }
});

test("NFR-27: a partial bundle falls back to English per missing key", () => {
  const bundle: LocaleBundle = { tag: "fr", copy: { "app.title": "Présence" } };
  assert.equal(resolveCopy(bundle, "app.title"), "Présence");
  assert.equal(resolveCopy(bundle, "app.subtitle"), ENGLISH_COPY["app.subtitle"]);
});

test("NFR-27: an unknown key resolves to null, never a raw key", () => {
  assert.equal(resolveCopy(null, "no.such.key"), null);
  const bundle: LocaleBundle = { tag: "fr", copy: { "no.such.key": "forgé" } };
  // A bundle cannot mint keys the baseline does not own.
  assert.equal(resolveCopy(bundle, "no.such.key"), null);
});

test("NFR-27: garbage bundles and tags resolve as English", () => {
  assert.equal(resolveCopy(null, "app.title"), ENGLISH_COPY["app.title"]);
  assert.equal(resolveCopy(undefined, "app.title"), ENGLISH_COPY["app.title"]);
  assert.equal(
    resolveCopy({ tag: "EN!!", copy: { "app.title": "Forged" } }, "app.title"),
    ENGLISH_COPY["app.title"],
  );
  assert.equal(
    resolveCopy({ tag: "fr", copy: null as never }, "app.title"),
    ENGLISH_COPY["app.title"],
  );
});

test("NFR-27: empty or blank translations are not accepted", () => {
  const bundle: LocaleBundle = { tag: "fr", copy: { "app.title": "   " } };
  assert.equal(resolveCopy(bundle, "app.title"), ENGLISH_COPY["app.title"]);
});

test("NFR-27: locale tag validation is BCP-47-lite", () => {
  assert.ok(isValidLocaleTag("en"));
  assert.ok(isValidLocaleTag("yo"));
  assert.ok(isValidLocaleTag("en-GB"));
  assert.ok(isValidLocaleTag("zh-Hant-TW"));
  assert.ok(isValidLocaleTag("es-419"));
  assert.ok(!isValidLocaleTag("EN"));
  assert.ok(!isValidLocaleTag("en_GB"));
  assert.ok(!isValidLocaleTag("e"));
  assert.ok(!isValidLocaleTag(""));
  assert.ok(!isValidLocaleTag(42));
  assert.ok(!isValidLocaleTag(null));
});

test("NFR-27: coverage reports exactly the missing keys", () => {
  const bundle: LocaleBundle = {
    tag: "fr",
    copy: { "app.title": "Présence", "app.subtitle": "Là où sont tes gens." },
  };
  const coverage = localeCoverage(bundle);
  assert.equal(coverage.total, Object.keys(ENGLISH_COPY).length);
  assert.equal(coverage.translated, 2);
  assert.deepEqual(
    [...coverage.missing].sort(),
    Object.keys(ENGLISH_COPY)
      .filter((key) => key !== "app.title" && key !== "app.subtitle")
      .sort(),
  );
});

test("NFR-27: launch readiness requires full coverage AND a valid tag", () => {
  const full: LocaleBundle = {
    tag: "fr",
    copy: Object.fromEntries(
      Object.entries(ENGLISH_COPY).map(([key, value]) => [key, `fr:${value}`]),
    ),
  };
  assert.ok(localeIsLaunchReady(full));
  assert.ok(!localeIsLaunchReady({ tag: "fr", copy: {} }));
  assert.ok(!localeIsLaunchReady({ tag: "FR!!", copy: full.copy }));
});

test("NFR-27: adding a locale is data-only — the executable proof", () => {
  // Construct a locale at runtime and resolve through it: no code path
  // changed, which is the "localisable without code changes" guarantee.
  const runtime: LocaleBundle = { tag: "ha", copy: { "app.title": "Hulɗa" } };
  assert.equal(resolveCopy(runtime, "app.title"), "Hulɗa");
  assert.ok(copyHonoursNfr27());
});
