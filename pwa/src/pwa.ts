/**
 * AMD-PWA-05 (installability and update discipline): the contract behind
 * the member PWA shell. The service worker itself lives in public/sw.js
 * (a static asset, outside the TS build); this module pins the CONTRACT
 * it must honour: network-first for navigations (a republished client is
 * never masked by a stale cached shell), network-first with a cache
 * fallback for code and config (the unhashed tsc bundle must never be
 * served stale — the batch-67 lesson), cache-first only for the
 * content-stable icons, skipWaiting + clientsClaim so updates activate
 * immediately, and /v1/* is NEVER cached by the service worker — member
 * data caching is an explicit, bounded, APP-LAYER decision
 * (AMD-PWA-04's read cache), never an accidental side effect of the SW.
 *
 * PWA_SW_VERSION must match the VERSION constant in public/sw.js — the
 * version bump is the update signal; the test suite cross-pins them.
 */

export const PWA_SW_VERSION = "presence-member-pwa-v1";

export interface ManifestIconLike {
  sizes?: unknown;
  purpose?: unknown;
}

export interface ManifestLike {
  name?: unknown;
  short_name?: unknown;
  display?: unknown;
  start_url?: unknown;
  theme_color?: unknown;
  background_color?: unknown;
  icons?: unknown;
}

/**
 * What stands between this manifest and an installable app. An empty
 * list means installable; every problem is named so the fix is obvious.
 */
export function manifestProblems(manifest: unknown): string[] {
  const m = manifest as ManifestLike | null;
  const problems: string[] = [];
  if (typeof m?.name !== "string" || m.name.length === 0) problems.push("name");
  if (typeof m?.short_name !== "string" || m.short_name.length === 0) problems.push("short_name");
  if (m?.display !== "standalone") problems.push("display must be standalone");
  if (typeof m?.start_url !== "string" || m.start_url.length === 0) problems.push("start_url");
  if (typeof m?.theme_color !== "string") problems.push("theme_color");
  if (typeof m?.background_color !== "string") problems.push("background_color");
  const icons = Array.isArray(m?.icons) ? (m.icons as ManifestIconLike[]) : [];
  const has = (size: string, purpose?: string) =>
    icons.some(
      (icon) =>
        typeof icon.sizes === "string" &&
        icon.sizes.split(/\s+/).includes(size) &&
        (purpose === undefined || icon.purpose === purpose),
    );
  if (!has("192x192")) problems.push("a 192x192 icon");
  if (!has("512x512")) problems.push("a 512x512 icon");
  if (!has("512x512", "maskable")) problems.push("a maskable 512x512 icon");
  return problems;
}

export function swSupported(navigatorLike: { serviceWorker?: unknown }): boolean {
  return typeof navigatorLike.serviceWorker !== "undefined";
}

export type SwUpdateState = "idle" | "update-waiting" | "reloading";

/**
 * The once-guard against reload loops: a controllerchange after an
 * update triggers exactly one reload; a second change in the same page
 * life is ignored (something else is wrong and reloading will not fix
 * it).
 */
export function shouldReloadOnControllerChange(alreadyReloaded: boolean): boolean {
  return !alreadyReloaded;
}

/**
 * App-badge contract (AMD-PWA-03): the badge shows pairs awaiting the
 * member and nothing else; zero clears. Unsupported platforms silently
 * no-op — badging is a nicety, never a gate.
 */
export interface BadgeCapable {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

export async function applyBadge(navigatorLike: BadgeCapable, count: number): Promise<void> {
  try {
    if (count > 0 && typeof navigatorLike.setAppBadge === "function") {
      await navigatorLike.setAppBadge(count);
    } else if (count === 0 && typeof navigatorLike.clearAppBadge === "function") {
      await navigatorLike.clearAppBadge();
    }
  } catch {
    // Badge failure must never break the home render.
  }
}
