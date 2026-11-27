/**
 * AMD-PWA-01/03/06 render half: the thin DOM layer over the contract
 * modules. No framework, no bundler — tsc emits this straight to browser
 * ESM. Tabs are hash routes (#/home, #/wallet, #/privacy) so no server
 * routing exists beyond the nginx SPA fallback; the OIDC callback path
 * (/auth/callback) is the only deep path and the shell serves it.
 *
 * Tokens live in MEMORY ONLY (AMD-PWA-02) — a reload signs the member
 * out by construction. Mutations go direct when the link is healthy and
 * through the AMD-PWA-04 outbox when it is not; reads fall back to the
 * bounded read cache, always marked stale.
 */

import {
  beginAuthorization,
  endSessionUrl,
  exchangeCode,
  parseCallback,
  refreshTokens,
  sessionState,
  PKCE_STORAGE_KEY,
  type OidcConfig,
  type PkceTransaction,
  type TokenSet,
} from "../src/oidc.js";
import {
  createMemberApi,
  MemberAuthError,
  type MemberApi,
} from "../src/memberApi.js";
import {
  featureGateForLink,
  initialClassifierState,
  observe,
  withBrowserSignal,
  type ClassifierState,
} from "../src/connectivity.js";
import {
  readDocument,
  wipeReadCache,
  writeDocument,
  type ReadCacheKey,
} from "../src/readCache.js";
import {
  drainOnce,
  enqueue,
  pendingEntries,
  poisonedEntries,
  wipeOutbox,
  type OutboxEntry,
} from "../src/outbox.js";
import {
  attentionItems,
  badgeCountFor,
  fetchHome,
  formatMinor,
  type HomeDocument,
  type PairSummary,
  type SectionRead,
  type WalletSummary,
} from "../src/home.js";
import {
  DELETE_CONFIRMATION_PHRASE,
  deleteConfirmed,
  parseDevices,
  wipeAll,
  type DeviceSummary,
} from "../src/account.js";
import {
  applyBadge,
  manifestProblems,
  shouldReloadOnControllerChange,
  swSupported,
} from "../src/pwa.js";

interface PwaConfig extends OidcConfig {
  apiBase: string;
}

type Tab = "home" | "wallet" | "privacy";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "wallet", label: "Wallet" },
  { id: "privacy", label: "Privacy" },
];

const oidcEffects = {
  randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: async (data: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
  nowMs: () => Date.now(),
};

const state: {
  config: PwaConfig | null;
  api: MemberApi | null;
  tokens: TokenSet | null;
  home: HomeDocument | null;
  devices: DeviceSummary[] | null;
  link: ClassifierState;
  tab: Tab;
  signInNotice: string | null;
  reloaded: boolean;
  installPrompt: { prompt(): Promise<void> } | null;
  busy: boolean;
} = {
  config: null,
  api: null,
  tokens: null,
  home: null,
  devices: null,
  link: initialClassifierState(),
  tab: "home",
  signInNotice: null,
  reloaded: false,
  installPrompt: null,
  busy: false,
};

const root = document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

function wireApi(): void {
  if (!state.config) return;
  state.api = createMemberApi(state.config.apiBase, () => state.tokens?.accessToken ?? null, {
    fetch: (url, init) => fetch(url, init),
    uuid: () => crypto.randomUUID(),
    nowMs: () => Date.now(),
    observe: (obs) => {
      state.link = withBrowserSignal(observe(state.link, obs), navigator.onLine);
      renderLinkBanner();
    },
  });
}

async function signIn(): Promise<void> {
  if (!state.config) return;
  const { url, transaction } = await beginAuthorization(state.config, oidcEffects);
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(transaction));
  window.location.assign(url);
}

async function handleCallback(): Promise<boolean> {
  if (!state.config) return false;
  const raw = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!raw) {
    state.signInNotice = "No sign-in in progress — start again.";
    history.replaceState(null, "", "/");
    return false;
  }
  const transaction = JSON.parse(raw) as PkceTransaction;
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
  const result = parseCallback(window.location.href, transaction.state);
  if (result.kind === "error") {
    state.signInNotice = `Sign-in failed (${result.error}).`;
    history.replaceState(null, "", "/");
    return false;
  }
  try {
    state.tokens = await exchangeCode(
      state.config,
      result.code,
      transaction.verifier,
      oidcEffects,
      (url, init) => fetch(url, init),
    );
  } catch {
    state.signInNotice = "Sign-in could not complete — try again.";
    history.replaceState(null, "", "/");
    return false;
  }
  history.replaceState(null, "", "/");
  return true;
}

function signOut(): void {
  if (!state.config) return;
  const logout = endSessionUrl(state.config, window.location.origin + "/");
  wipeAll([localStorage, sessionStorage]);
  state.tokens = null;
  state.home = null;
  window.location.assign(logout);
}

async function maintainSession(): Promise<void> {
  if (!state.config || !state.tokens) return;
  if (sessionState(state.tokens, Date.now()) === "refresh-due") {
    try {
      state.tokens = await refreshTokens(
        state.config,
        state.tokens.refreshToken,
        oidcEffects,
        (url, init) => fetch(url, init),
      );
    } catch {
      endSessionLocally("Your session expired — sign in again.");
    }
  } else if (sessionState(state.tokens, Date.now()) === "expired") {
    endSessionLocally("Your session expired — sign in again.");
  }
}

function endSessionLocally(notice: string): void {
  wipeAll([localStorage, sessionStorage]);
  state.tokens = null;
  state.home = null;
  state.signInNotice = notice;
  render();
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const CACHE_KEY_BY_SECTION: Record<string, ReadCacheKey> = {
  identity: "identity:self",
  kycStatus: "identity:kyc",
  pairs: "consent:pairs",
  wallets: "wallets:list",
};

async function refreshHome(): Promise<void> {
  if (!state.api) return;
  try {
    const home = await fetchHome(state.api);
    state.home = home;
    for (const [sectionName, cacheKey] of Object.entries(CACHE_KEY_BY_SECTION)) {
      const read = home[sectionName as keyof HomeDocument];
      if (read.kind === "ok") writeDocument(localStorage, cacheKey, read.document, Date.now());
    }
    await applyBadge(navigator, badgeCountFor(home));
  } catch (error) {
    if (error instanceof MemberAuthError) {
      endSessionLocally("Your session expired — sign in again.");
      return;
    }
    // Whole-home failure: fall back to the cache, every section stale.
    state.home = cachedHome();
  }
}

function cachedHome(): HomeDocument {
  const read = <T>(key: ReadCacheKey): SectionRead<T> => {
    const hit = readDocument(localStorage, key, Date.now());
    return hit.kind === "absent"
      ? { kind: "unavailable" }
      : { kind: "ok", document: hit.document as T };
  };
  return {
    identity: read("identity:self"),
    kycStatus: read("identity:kyc"),
    pairs: read("consent:pairs"),
    wallets: read("wallets:list"),
  };
}

function cacheAgeLabel(key: ReadCacheKey): string | null {
  const hit = readDocument(localStorage, key, Date.now());
  if (hit.kind === "absent") return null;
  const minutes = Math.max(0, Math.round((Date.now() - hit.cachedAtMs) / 60_000));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
}

async function refreshDevices(): Promise<void> {
  if (!state.api) return;
  try {
    state.devices = parseDevices(await state.api.get("/v1/devices"));
  } catch (error) {
    if (error instanceof MemberAuthError) endSessionLocally("Your session expired — sign in again.");
  }
}

/* ------------------------------------------------------------------ */
/* Mutations — direct when healthy, outbox when not (AMD-PWA-04)       */
/* ------------------------------------------------------------------ */

async function mutate(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
): Promise<void> {
  if (!state.api) return;
  const features = featureGateForLink(state.link.state);
  const queueIt = () => {
    enqueue(
      localStorage,
      { method, path, body },
      { nowMs: () => Date.now(), uuid: () => crypto.randomUUID(), random: () => Math.random() },
    );
  };
  if (features === "none") {
    queueIt();
    return;
  }
  try {
    if (method === "POST") await state.api.post(path, body);
    else if (method === "PUT") await state.api.put(path, body);
    else await state.api.delete(path);
  } catch (error) {
    if (error instanceof MemberAuthError) {
      endSessionLocally("Your session expired — sign in again.");
      return;
    }
    if (error instanceof Error && error.message.includes("unreachable")) {
      queueIt(); // the tap is not dropped — it rides the outbox
      return;
    }
    throw error;
  }
}

async function pumpOutbox(): Promise<void> {
  if (!state.api || state.busy) return;
  state.busy = true;
  try {
    await drainOnce(
      localStorage,
      async (entry: OutboxEntry) => {
        try {
          if (entry.method === "POST") await state.api!.post(entry.path, JSON.parse(entry.body), entry.idempotencyKey);
          else if (entry.method === "PUT") await state.api!.put(entry.path, JSON.parse(entry.body), entry.idempotencyKey);
          else await state.api!.delete(entry.path, entry.idempotencyKey);
          return { kind: "ack" } as const;
        } catch (error) {
          if (error instanceof MemberAuthError) return { kind: "pause" } as const;
          const status = (error as { status?: number }).status ?? 0;
          if (status >= 400 && status < 500) return { kind: "poison" } as const;
          return { kind: "retry" } as const;
        }
      },
      { nowMs: () => Date.now(), uuid: () => crypto.randomUUID(), random: () => Math.random() },
    );
  } finally {
    state.busy = false;
  }
  await refreshHome();
  render();
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render(): void {
  root.replaceChildren();
  root.dataset.tab = state.tab;
  if (!state.tokens) {
    renderSignIn();
    return;
  }
  renderShell();
}

function renderSignIn(): void {
  const screen = el("section", "signin");
  const mark = el("p", "signin-mark", "●");
  mark.setAttribute("aria-hidden", "true");
  screen.append(mark);
  screen.append(el("h1", "signin-title", "Presence"));
  screen.append(
    el(
      "p",
      "signin-copy",
      "The people around you, on your terms. Sign in with your passkey — no passwords, nothing to phish.",
    ),
  );
  if (state.signInNotice) {
    const notice = el("p", "signin-notice", state.signInNotice);
    notice.setAttribute("role", "status");
    screen.append(notice);
  }
  screen.append(button("Sign in with your passkey", "cta", () => void signIn()));
  if (state.installPrompt) {
    screen.append(
      button("Install the app", "ghost", () => void state.installPrompt?.prompt()),
    );
  }
  screen.append(
    el(
      "p",
      "signin-foot",
      "The lite client: installable, offline-honest, and easy on a 2G link.",
    ),
  );
  root.append(screen);
}

function renderShell(): void {
  const shell = el("div", "shell");
  const banner = el("div", "link-banner");
  banner.id = "link-banner";
  shell.append(banner);

  const main = el("main", "surface");
  main.id = "surface";
  if (state.tab === "home") renderHome(main);
  else if (state.tab === "wallet") renderWallet(main);
  else renderPrivacy(main);
  shell.append(main);

  const nav = el("nav", "tabs");
  nav.setAttribute("aria-label", "Sections");
  for (const tab of TABS) {
    const item = button(tab.label, "tab", () => {
      state.tab = tab.id;
      window.location.hash = `#/${tab.id}`;
      if (tab.id === "privacy") void refreshDevices().then(render);
      render();
    });
    item.setAttribute("aria-current", state.tab === tab.id ? "page" : "false");
    if (state.tab === tab.id) {
      item.classList.add("tab-active");
      const dot = el("span", "tab-bullet", "●");
      dot.setAttribute("aria-hidden", "true");
      item.append(dot);
    }
    nav.append(item);
  }
  shell.append(nav);
  root.append(shell);
  renderLinkBanner();
}

function renderLinkBanner(): void {
  const banner = document.getElementById("link-banner");
  if (!banner) return;
  banner.replaceChildren();
  const features = featureGateForLink(state.link.state);
  const pending = pendingEntries(localStorage).length;
  const poisoned = poisonedEntries(localStorage).length;
  if (features === "none") {
    banner.append(
      el(
        "p",
        "banner-line",
        `You're offline — showing last known state.${pending > 0 ? ` ${pending} action${pending === 1 ? "" : "s"} queued.` : ""}`,
      ),
    );
    banner.classList.add("banner-visible");
  } else if (features === "reduced") {
    banner.append(el("p", "banner-line", "Slow link — background refresh is off."));
    banner.classList.add("banner-visible");
  } else if (poisoned > 0) {
    banner.append(
      el(
        "p",
        "banner-line",
        `${poisoned} queued action${poisoned === 1 ? "" : "s"} could not be sent — sign in again or retry later.`,
      ),
    );
    banner.classList.add("banner-visible");
  } else {
    banner.classList.remove("banner-visible");
  }
}

function staleNote(key: ReadCacheKey): HTMLElement | null {
  const label = cacheAgeLabel(key);
  if (label === null || featureGateForLink(state.link.state) === "full") return null;
  return el("p", "stale-note", `Last updated ${label}`);
}

function renderHome(main: HTMLElement): void {
  const home = state.home;
  const head = el("header", "surface-head");
  head.append(el("h1", "surface-title", "Home"));
  const identity = home?.identity;
  if (identity?.kind === "ok") {
    head.append(el("p", "surface-sub", identity.document.displayName));
  } else if (identity?.kind === "absent") {
    head.append(el("p", "surface-sub", "Set up your identity from the mobile app to be discoverable."));
  }
  main.append(head);
  const identityStale = staleNote("identity:self");
  if (identityStale) main.append(identityStale);

  if (!home) {
    main.append(el("p", "empty", "Loading your home…"));
    return;
  }

  const items = attentionItems(home);
  if (items.length > 0) {
    const attention = el("section", "block");
    attention.append(el("h2", "block-title", "Needs you"));
    for (const item of items) attention.append(el("p", "attention-line", item.label));
    main.append(attention);
  }

  const pairsSection = el("section", "block");
  pairsSection.append(el("h2", "block-title", "Pairs"));
  if (home.pairs.kind === "ok" && home.pairs.document.length > 0) {
    for (const pair of home.pairs.document) pairsSection.append(pairRow(pair));
  } else if (home.pairs.kind === "ok") {
    pairsSection.append(el("p", "empty", "No pairs yet — be present somewhere and the room does the rest."));
  } else {
    pairsSection.append(el("p", "empty", "Pairs are unavailable right now."));
  }
  main.append(pairsSection);

  const actions = el("section", "block");
  actions.append(el("h2", "block-title", "Session"));
  actions.append(button("Refresh", "ghost", () => void refreshHome().then(render)));
  actions.append(button("Sign out", "ghost", signOut));
  main.append(actions);
}

function pairRow(pair: PairSummary): HTMLElement {
  const row = el("div", "pair-row");
  const title =
    pair.state === "OPEN" && pair.counterpart
      ? `Open conversation`
      : pair.state === "MUTUAL"
        ? "Mutual interest"
        : pair.state === "NUDGED"
          ? "A wave is waiting"
          : pair.state === "EXPRESSED"
            ? "You waved — waiting on them"
            : "Nearby presence detected";
  row.append(el("p", "pair-title", title));
  if (pair.offerExpiresAt) {
    row.append(el("p", "pair-meta", `Answer before ${new Date(pair.offerExpiresAt).toLocaleString()}`));
  }
  const actions = el("div", "pair-actions");
  if (pair.state === "NUDGED") {
    actions.append(
      button("Wave back", "cta-small", () =>
        void mutate("POST", `/v1/consent/${pair.pairId}/express`, {}).then(refreshHome).then(render),
      ),
    );
    actions.append(
      button("Not now", "ghost", () =>
        void mutate("POST", `/v1/consent/${pair.pairId}/decline`, {}).then(refreshHome).then(render),
      ),
    );
  } else if (pair.state === "MUTUAL") {
    actions.append(
      button("Open conversation", "cta-small", () =>
        void mutate("POST", `/v1/consent/${pair.pairId}/open`, {}).then(refreshHome).then(render),
      ),
    );
  }
  row.append(actions);
  return row;
}

function renderWallet(main: HTMLElement): void {
  const head = el("header", "surface-head");
  head.append(el("h1", "surface-title", "Wallet"));
  main.append(head);
  const stale = staleNote("wallets:list");
  if (stale) main.append(stale);
  const wallets = state.home?.wallets;
  const section = el("section", "block");
  if (wallets?.kind === "ok" && wallets.document.length > 0) {
    for (const wallet of wallets.document) section.append(walletRow(wallet));
  } else if (wallets?.kind === "ok") {
    section.append(el("p", "empty", "No wallet yet — one appears with your first transfer or escrow."));
  } else {
    section.append(el("p", "empty", "Wallets are unavailable right now."));
  }
  main.append(section);
  main.append(button("Refresh", "ghost", () => void refreshHome().then(render)));
}

function walletRow(wallet: WalletSummary): HTMLElement {
  const row = el("div", "wallet-row");
  row.append(el("p", "wallet-amount", formatMinor(wallet.availableMinor, wallet.currency)));
  const meta =
    wallet.heldMinor > 0
      ? `${wallet.currency} · ${formatMinor(wallet.heldMinor, wallet.currency)} on hold · ${wallet.status}`
      : `${wallet.currency} · ${wallet.status}`;
  row.append(el("p", "wallet-meta", meta));
  return row;
}

function renderPrivacy(main: HTMLElement): void {
  const head = el("header", "surface-head");
  head.append(el("h1", "surface-title", "Privacy"));
  head.append(el("p", "surface-sub", "Your data, your devices, your exit."));
  main.append(head);

  const exportSection = el("section", "block");
  exportSection.append(el("h2", "block-title", "Your data"));
  exportSection.append(
    el("p", "block-copy", "Everything the platform holds on you, as one export."),
  );
  exportSection.append(
    button("Download my data", "ghost", () => {
      if (!state.api) return;
      void state.api
        .get("/v1/account/export")
        .then((data) => {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const link = el("a");
          link.href = URL.createObjectURL(blob);
          link.download = "presence-export.json";
          link.click();
          URL.revokeObjectURL(link.href);
        })
        .catch((error: unknown) => {
          if (error instanceof MemberAuthError) endSessionLocally("Your session expired — sign in again.");
        });
    }),
  );
  main.append(exportSection);

  const devicesSection = el("section", "block");
  devicesSection.append(el("h2", "block-title", "Devices"));
  if (state.devices && state.devices.length > 0) {
    for (const device of state.devices) {
      const row = el("div", "device-row");
      row.append(
        el(
          "p",
          "device-title",
          `${device.platform}${device.lastSeenAt ? ` · last seen ${new Date(device.lastSeenAt).toLocaleDateString()}` : ""}`,
        ),
      );
      row.append(
        button("Revoke", "ghost", () =>
          void mutate("DELETE", `/v1/devices/${device.deviceId}`, {}).then(refreshDevices).then(render),
        ),
      );
      devicesSection.append(row);
    }
  } else {
    devicesSection.append(el("p", "empty", "No registered devices found."));
  }
  main.append(devicesSection);

  const danger = el("section", "block block-danger");
  danger.append(el("h2", "block-title", "Delete your account"));
  danger.append(
    el(
      "p",
      "block-copy",
      `Permanent. Type ${DELETE_CONFIRMATION_PHRASE} to arm the button.`,
    ),
  );
  const input = el("input", "delete-input");
  input.type = "text";
  input.placeholder = DELETE_CONFIRMATION_PHRASE;
  input.setAttribute("aria-label", `Type ${DELETE_CONFIRMATION_PHRASE} to confirm deletion`);
  const confirm = button("Delete my account", "danger", () => {
    if (!state.api || !deleteConfirmed(input.value)) return;
    void state.api
      .delete("/v1/account")
      .then(() => {
        wipeAll([localStorage, sessionStorage]);
        state.tokens = null;
        state.signInNotice = "Your account has been deleted.";
        render();
      })
      .catch((error: unknown) => {
        if (error instanceof MemberAuthError) endSessionLocally("Your session expired — sign in again.");
      });
  });
  confirm.disabled = true;
  input.addEventListener("input", () => {
    confirm.disabled = !deleteConfirmed(input.value);
  });
  danger.append(input, confirm);
  main.append(danger);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  const config = (await (await fetch("/config.json")).json()) as PwaConfig;
  state.config = config;
  wireApi();

  const manifest = await (await fetch("/manifest.webmanifest")).json();
  const problems = manifestProblems(manifest);
  if (problems.length > 0) console.warn("manifest problems:", problems);

  if (swSupported(navigator)) {
    await navigator.serviceWorker.register("/sw.js");
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (shouldReloadOnControllerChange(state.reloaded)) {
        state.reloaded = true;
        window.location.reload();
      }
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event as unknown as { prompt(): Promise<void> };
    if (!state.tokens) render();
  });

  window.addEventListener("online", () => {
    state.link = withBrowserSignal(state.link, true);
    void pumpOutbox();
  });
  window.addEventListener("offline", () => {
    state.link = withBrowserSignal(state.link, false);
    renderLinkBanner();
  });

  const hash = window.location.hash;
  if (hash === "#/wallet" || hash === "#/privacy") state.tab = hash.slice(2) as Tab;

  if (window.location.pathname === "/auth/callback") {
    const ok = await handleCallback();
    if (!ok) {
      render();
      return;
    }
  }

  if (state.tokens) {
    await refreshHome();
    render();
    void pumpOutbox();
    window.setInterval(() => void maintainSession(), 15_000);
    window.setInterval(() => {
      if (featureGateForLink(state.link.state) === "full") void refreshHome().then(render);
    }, 60_000);
  } else {
    render();
  }
}

void boot();
