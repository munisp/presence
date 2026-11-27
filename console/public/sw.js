/* AMD-CON-06: the console service worker. Contract (pinned in src/pwa.ts
 * and tests/test_batch67.py):
 *  - navigations are NETWORK-FIRST, falling back to the cached shell — a
 *    republished console is never masked by a stale cached page;
 *  - code and config (compiled modules, styles, config.json) are also
 *    NETWORK-FIRST with a cache fallback: the tsc output carries no
 *    content hash, so cache-first would serve a stale bundle forever —
 *    a republished console must never be masked by stale cached code,
 *    while an offline revisit still boots from the cache;
 *  - icons are content-stable, so they alone are cache-first with a
 *    network fill;
 *  - /v1/* API traffic is NEVER cached (workforce data is not cacheable);
 *  - skipWaiting + clientsClaim: a new version activates immediately.
 * VERSION must match CONSOLE_SW_VERSION in src/pwa.ts — the bump is the
 * update signal. */

const VERSION = "presence-console-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL = ["./", "./index.html", "./styles.css", "./manifest.webmanifest", "./config.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/v1/")) return; // API traffic: network only

  // Content-stable icons: cache-first with a network fill.
  if (url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else — navigations, the compiled modules, styles, config —
  // is NETWORK-FIRST with a cache fallback. The bundle carries no content
  // hash, so cache-first would mask every republish; network-first keeps
  // the console fresh while an offline revisit still boots from cache.
  const fallbackKey = event.request.mode === "navigate" ? "./index.html" : event.request;
  const fallbackCache =
    event.request.mode === "navigate" ? SHELL_CACHE : ASSET_CACHE;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(fallbackCache).then((cache) => cache.put(fallbackKey, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(fallbackKey).then((cached) => cached || Response.error()),
      ),
  );
});
