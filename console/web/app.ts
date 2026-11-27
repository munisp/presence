/**
 * AMD-CON-01: the console's thin DOM render half. All decisions live in
 * the contract modules under ../src/ — this file only binds them to the
 * document. Hash routing (every screen reachable without server rewrites);
 * the OIDC callback is the single PATH exception (Keycloak redirects to
 * /auth/callback, nginx falls back to index.html).
 */

import {
  beginAuthorization,
  endSessionUrl,
  exchangeCode,
  parseCallback,
  refreshTokens,
  rolesOf,
  sessionState,
  type OidcConfig,
  type TokenSet,
} from "../src/oidc.js";
import {
  ConsoleAuthError,
  createConsoleApi,
  type ConsoleApi,
} from "../src/consoleApi.js";
import {
  CONSOLE_SECTIONS,
  SECTION_TITLES,
  defaultSection,
  hasConsoleAccess,
  visibleSections,
  type ConsoleSection,
} from "../src/surfaces.js";
import { attentionOrder, freshness, loadOverview, type Overview } from "../src/dashboard.js";
import {
  APPEAL_DECISIONS,
  REASON_CODES,
  REPORT_OUTCOMES,
  approveElevation,
  approveOnboarding,
  mergeWorklist,
  normalizeAppeals,
  normalizeElevation,
  normalizeKycReviews,
  normalizeKycSessions,
  normalizeOnboarding,
  normalizeReports,
  rejectElevation,
  rejectOnboarding,
  resolveAppeal,
  resolveReport,
  revokeElevation,
  type WorklistItem,
} from "../src/queues.js";
import {
  addVertex,
  bounds,
  closePolygon,
  deleteVertex,
  emptyPolygon,
  hitTestEdge,
  hitTestVertex,
  insertVertexAfter,
  moveVertex,
  projector,
  reopenPolygon,
  shoelaceAreaM2,
  toGeoJSON,
  validateForSubmit,
  type EditorPolygon,
} from "../src/geofenceEditor.js";

interface ConsoleConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  apiBase: string;
}

interface ConsoleState {
  config: ConsoleConfig | null;
  tokens: TokenSet | null;
  roles: string[];
  section: ConsoleSection | "sign-in";
  notice: string | null;
}

const state: ConsoleState = { config: null, tokens: null, roles: [], section: "sign-in", notice: null };

const TX_KEY = "presence-console-pkce";
const root = (): HTMLElement => document.getElementById("app") as HTMLElement;

function oidcConfig(config: ConsoleConfig): OidcConfig {
  return { issuer: config.issuer, clientId: config.clientId, redirectUri: config.redirectUri, scope: config.scope };
}

const oidcEffects = {
  randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
  nowMs: () => Date.now(),
};

function api(): ConsoleApi {
  const config = state.config as ConsoleConfig;
  return createConsoleApi(config.apiBase, () => state.tokens?.accessToken ?? null, {
    fetch: (url, init) => fetch(url, init),
    uuid: () => crypto.randomUUID(),
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, onClick: () => void, kind = "secondary"): HTMLButtonElement {
  const b = el("button", { class: `btn btn-${kind}`, type: "button" }, [label]);
  b.addEventListener("click", onClickGuard(onClick));
  return b;
}

/** Every action surfaces its outcome — a failed click is never silent. */
function onClickGuard(fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      state.notice = err instanceof Error ? err.message : String(err);
      render();
    }
  };
}

async function guard(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ConsoleAuthError) {
      state.tokens = null;
      state.notice = "Session expired — sign in again.";
      state.section = "sign-in";
    } else {
      state.notice = err instanceof Error ? err.message : String(err);
    }
    render();
  }
}

function fmtAge(createdAtMs: number | null): string {
  if (createdAtMs === null) return "—";
  const mins = Math.max(0, Math.round((Date.now() - createdAtMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------- views ---

function renderSignIn(): void {
  const connect = button("Sign in with workforce SSO", () => {
    void guard(
      (async () => {
        const config = state.config as ConsoleConfig;
        const { url, transaction } = await beginAuthorization(oidcConfig(config), oidcEffects);
        sessionStorage.setItem(TX_KEY, JSON.stringify(transaction));
        window.location.assign(url);
      })(),
    );
  }, "primary");
  root().replaceChildren(
    el("main", { class: "signin" }, [
      el("div", { class: "signin-mark", "aria-hidden": "true" }),
      el("h1", {}, ["Presence Ops Console"]),
      el("p", { class: "lede" }, [
        "Workforce operations: moderation, KYC review, onboarding, elevation and the geofence estate. Sign-in uses the workforce realm — every action is re-authorized by the edge.",
      ]),
      state.notice ? el("p", { class: "notice", role: "alert" }, [state.notice]) : "",
      connect,
    ]),
  );
}

function nav(current: ConsoleSection): HTMLElement {
  const list = el("ul", { class: "nav-list", role: "list" });
  for (const section of visibleSections(state.roles)) {
    const link = el("a", {
      href: `#/${section}`,
      class: section === current ? "nav-link nav-active" : "nav-link",
      "aria-current": section === current ? "page" : "false",
    }, [SECTION_TITLES[section]]);
    list.append(el("li", {}, [link]));
  }
  return el("nav", { class: "nav", "aria-label": "Console sections" }, [list]);
}

function shell(content: HTMLElement): void {
  const signOut = button("Sign out", () => {
    const config = state.config as ConsoleConfig;
    state.tokens = null;
    state.roles = [];
    window.location.assign(endSessionUrl(oidcConfig(config), window.location.origin + "/"));
  });
  const header = el("header", { class: "topbar" }, [
    el("span", { class: "brand" }, ["Presence Ops"]),
    nav(state.section as ConsoleSection),
    signOut,
  ]);
  root().replaceChildren(
    el("div", { class: "shell" }, [
      header,
      state.notice
        ? el("p", { class: "notice", role: "alert" }, [
            state.notice,
            button("Dismiss", () => {
              state.notice = null;
              render();
            }),
          ])
        : "",
      content,
    ]),
  );
}

function errorPanel(message: string, retry: () => void): HTMLElement {
  return el("section", { class: "panel" }, [
    el("p", { class: "notice", role: "alert" }, [message]),
    button("Retry", retry),
  ]);
}

function emptyPanel(text: string): HTMLElement {
  return el("section", { class: "panel panel-empty" }, [el("p", {}, [text])]);
}

function worklistTable(
  items: WorklistItem[],
  actions: (item: WorklistItem) => HTMLElement[],
): HTMLElement {
  if (items.length === 0) return emptyPanel("Queue clear — nothing pending.");
  const table = el("table", { class: "queue" });
  table.append(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, ["Kind"]),
        el("th", {}, ["Subject"]),
        el("th", {}, ["Summary"]),
        el("th", {}, ["Age"]),
        el("th", {}, ["Actions"]),
      ]),
    ]),
  );
  const body = el("tbody");
  for (const item of items) {
    body.append(
      el("tr", {}, [
        el("td", {}, [item.kind]),
        el("td", { class: "mono" }, [item.subject.slice(0, 18)]),
        el("td", {}, [item.summary || "—"]),
        el("td", {}, [fmtAge(item.createdAtMs)]),
        el("td", { class: "row-actions" }, actions(item)),
      ]),
    );
  }
  table.append(body);
  return el("section", { class: "panel" }, [table]);
}

/** Reason-code picker + confirm, shared by every governed action. */
function actionDialog(
  title: string,
  options: { outcomes?: readonly string[]; placeholder: string },
  onConfirm: (outcome: string, reasonCode: string) => Promise<void>,
): HTMLElement {
  const wrap = el("div", { class: "dialog", role: "group", "aria-label": title });
  let outcome = options.outcomes?.[0] ?? "";
  const controls: (Node | string)[] = [el("strong", {}, [title])];
  if (options.outcomes) {
    const select = el("select", { "aria-label": "Outcome" });
    for (const o of options.outcomes) select.append(el("option", { value: o }, [o]));
    select.addEventListener("change", () => {
      outcome = select.value;
    });
    controls.push(select);
  }
  const reason = el("select", { "aria-label": "Reason code" });
  for (const code of REASON_CODES) reason.append(el("option", { value: code }, [code]));
  controls.push(reason);
  controls.push(
    button("Confirm", () => {
      void guard(onConfirm(outcome, reason.value));
    }, "primary"),
  );
  wrap.append(...controls);
  return wrap;
}

// ------------------------------------------------------------- sections ---

async function viewDashboard(panel: HTMLElement): Promise<void> {
  const overview = await loadOverview(api(), { nowMs: () => Date.now() }, visibleSections(state.roles));
  panel.replaceChildren(renderOverview(overview));
}

function renderOverview(overview: Overview): HTMLElement {
  const fresh = freshness(overview, Date.now());
  const cards = el("div", { class: "cards" });
  const cardDefs: [string, number][] = [
    ["Open reports", overview.counts.reports],
    ["Appeals waiting", overview.counts.appeals],
    ["KYC sessions", overview.counts.kycSessions],
    ["KYC review requests", overview.counts.kycReviews],
    ["Onboarding applications", overview.counts.onboarding],
    ["Elevation requests", overview.counts.elevation],
    ["Geofence conflicts", overview.counts.geofenceConflicts],
  ];
  for (const [label, value] of cardDefs) {
    cards.append(
      el("div", { class: value > 0 ? "card card-hot" : "card" }, [
        el("span", { class: "card-value" }, [String(value)]),
        el("span", { class: "card-label" }, [label]),
      ]),
    );
  }
  const attention = attentionOrder(overview.counts);
  const attentionList = el("ul", { class: "attention", role: "list" });
  for (const row of attention) {
    const link = el("a", { href: `#/${row.section}`, class: "attention-link" }, [
      `${SECTION_TITLES[row.section]} — ${row.pending} pending`,
    ]);
    attentionList.append(el("li", {}, [link]));
  }
  return el("section", { class: "panel" }, [
    el("div", { class: "panel-head" }, [
      el("h2", {}, ["Overview"]),
      el("span", { class: fresh.stale ? "fresh fresh-stale" : "fresh" }, [
        fresh.stale ? `stale (${Math.round(fresh.ageMs / 1000)}s old)` : "live",
      ]),
      button("Refresh", () => {
        void guard(viewDashboard(contentEl()));
      }),
    ]),
    cards,
    attention.length > 0
      ? el("div", {}, [el("h3", {}, ["Needs attention"]), attentionList])
      : el("p", {}, ["All queues clear."]),
  ]);
}

async function viewModeration(panel: HTMLElement): Promise<void> {
  const json = await api().get("/v1/moderation/queue");
  const items = mergeWorklist({ report: normalizeReports(json) });
  panel.replaceChildren(
    worklistTable(items, (item) => [
      (() => {
        const toggle = button("Resolve", () => {
          const holder = document.getElementById(`dlg-${item.id}`);
          holder?.replaceChildren(
            actionDialog("Resolve report", { outcomes: REPORT_OUTCOMES, placeholder: "reason" }, (outcome, reasonCode) =>
              resolveReport(api(), item.id, {
                outcome: outcome as (typeof REPORT_OUTCOMES)[number],
                reasonCode,
              }).then(() => {
                state.notice = "Report resolved.";
                return viewModeration(panel);
              }),
            ),
          );
        });
        return el("span", {}, [toggle, el("span", { id: `dlg-${item.id}` })]);
      })(),
    ]),
  );
}

async function viewAppeals(panel: HTMLElement): Promise<void> {
  const json = await api().get("/v1/moderation/appeals");
  const items = mergeWorklist({ appeal: normalizeAppeals(json) });
  panel.replaceChildren(
    worklistTable(items, (item) => [
      (() => {
        const toggle = button("Resolve", () => {
          const holder = document.getElementById(`dlg-${item.id}`);
          holder?.replaceChildren(
            actionDialog("Resolve appeal", { outcomes: APPEAL_DECISIONS, placeholder: "reason" }, (decision, reasonCode) =>
              resolveAppeal(api(), item.id, decision as (typeof APPEAL_DECISIONS)[number], reasonCode).then(() => {
                state.notice = "Appeal resolved.";
                return viewAppeals(panel);
              }),
            ),
          );
        });
        return el("span", {}, [toggle, el("span", { id: `dlg-${item.id}` })]);
      })(),
    ]),
  );
}

async function viewKyc(panel: HTMLElement): Promise<void> {
  const [sessions, reviews] = await Promise.all([
    api().get("/v1/moderation/kyc-sessions"),
    api().get("/v1/moderation/kyc-queue"),
  ]);
  const items = mergeWorklist({
    "kyc-session": normalizeKycSessions(sessions),
    "kyc-review": normalizeKycReviews(reviews),
  });
  // Decisions arrive via the signed OpenKYC verdict webhook (AMD-KYC-09);
  // the console surfaces the queue — it does not decide identity.
  panel.replaceChildren(
    el("div", {}, [
      el("p", { class: "lede" }, [
        "Verification decisions arrive over the signed verdict webhook; this queue is the review surface (read-only).",
      ]),
      worklistTable(items, () => []),
    ]),
  );
}

async function viewOnboarding(panel: HTMLElement): Promise<void> {
  const json = await api().get("/v1/moderation/onboarding");
  const items = mergeWorklist({ onboarding: normalizeOnboarding(json) });
  panel.replaceChildren(
    worklistTable(items, (item) => [
      button("Approve", () => {
        void guard(
          approveOnboarding(api(), item.id).then(() => {
            state.notice = "Application approved.";
            return viewOnboarding(panel);
          }),
        );
      }, "primary"),
      (() => {
        const toggle = button("Reject", () => {
          const holder = document.getElementById(`dlg-${item.id}`);
          const input = el("input", { type: "text", placeholder: "rejection reason (required)", "aria-label": "Rejection reason" });
          holder?.replaceChildren(
            el("span", { class: "dialog", role: "group" }, [
              input,
              button("Confirm rejection", () => {
                void guard(
                  rejectOnboarding(api(), item.id, input.value).then(() => {
                    state.notice = "Application rejected.";
                    return viewOnboarding(panel);
                  }),
                );
              }),
            ]),
          );
        });
        return el("span", {}, [toggle, el("span", { id: `dlg-${item.id}` })]);
      })(),
    ]),
  );
}

async function viewElevation(panel: HTMLElement): Promise<void> {
  const json = await api().get("/v1/moderation/elevation");
  const items = mergeWorklist({ elevation: normalizeElevation(json) });
  panel.replaceChildren(
    worklistTable(items, (item) => [
      button("Approve", () => {
        void guard(
          approveElevation(api(), item.id).then(() => {
            state.notice = "Elevation approved.";
            return viewElevation(panel);
          }),
        );
      }, "primary"),
      button("Reject", () => {
        void guard(
          rejectElevation(api(), item.id).then(() => {
            state.notice = "Elevation rejected.";
            return viewElevation(panel);
          }),
        );
      }),
      button("Revoke", () => {
        void guard(
          revokeElevation(api(), item.id).then(() => {
            state.notice = "Elevation revoked.";
            return viewElevation(panel);
          }),
        );
      }, "danger"),
    ]),
  );
}

async function viewSecurityEvents(panel: HTMLElement): Promise<void> {
  const select = el("select", { "aria-label": "Event kind" }, [el("option", { value: "" }, ["all kinds"])]);
  const kinds = ["mock_location", "attestation_failure", "velocity", "device_revoked"];
  for (const k of kinds) select.append(el("option", { value: k }, [k]));
  const holder = el("div");
  const load = async () => {
    const query = select.value ? `?kind=${encodeURIComponent(select.value)}` : "";
    const json = (await api().get(`/v1/moderation/security-events${query}`)) as {
      events?: { eventId: string; kind: string; actor: string; occurredAt: string }[];
    };
    const events = Array.isArray(json.events) ? json.events : [];
    if (events.length === 0) {
      holder.replaceChildren(emptyPanel("No security events in the window."));
      return;
    }
    const table = el("table", { class: "queue" });
    table.append(
      el("thead", {}, [el("tr", {}, [el("th", {}, ["Kind"]), el("th", {}, ["Actor"]), el("th", {}, ["When"])])]),
    );
    const body = el("tbody");
    for (const e of events) {
      body.append(
        el("tr", {}, [
          el("td", {}, [e.kind]),
          el("td", { class: "mono" }, [e.actor.slice(0, 18)]),
          el("td", {}, [fmtAge(Date.parse(e.occurredAt))]),
        ]),
      );
    }
    table.append(body);
    holder.replaceChildren(el("section", { class: "panel" }, [table]));
  };
  select.addEventListener("change", () => {
    void guard(load());
  });
  await load();
  panel.replaceChildren(
    el("div", {}, [
      el("div", { class: "panel-head" }, [el("h2", {}, ["Security events"]), select]),
      holder,
    ]),
  );
}

// ------------------------------------------------------- geofence editor ---

const editor = {
  polygon: emptyPolygon() as EditorPolygon,
  venueId: "",
  dragging: -1,
};

function svgPoint(svg: SVGSVGElement, event: MouseEvent): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

async function viewGeofences(panel: HTMLElement): Promise<void> {
  const qa = (await api().get("/v1/ops/geofences/qa")) as {
    venues?: {
      venueId: string;
      hasGeofence: boolean;
      densityError: string | null;
      overlapConflicts: number;
      geofenceVersion: number;
      openDrafts: number;
    }[];
  };
  const venues = Array.isArray(qa.venues) ? qa.venues : [];

  const qaTable = el("table", { class: "queue" });
  qaTable.append(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, ["Venue"]),
        el("th", {}, ["Geofence"]),
        el("th", {}, ["Density"]),
        el("th", {}, ["Overlaps"]),
        el("th", {}, ["Version"]),
        el("th", {}, ["Drafts"]),
        el("th", {}, [""]),
      ]),
    ]),
  );
  const qaBody = el("tbody");
  for (const v of venues) {
    qaBody.append(
      el("tr", {}, [
        el("td", { class: "mono" }, [v.venueId.slice(0, 18)]),
        el("td", {}, [v.hasGeofence ? "published" : "none"]),
        el("td", {}, [v.densityError ?? "ok"]),
        el("td", {}, [String(v.overlapConflicts)]),
        el("td", {}, [String(v.geofenceVersion)]),
        el("td", {}, [String(v.openDrafts)]),
        el("td", {}, [
          button("Edit", () => {
            editor.venueId = v.venueId;
            editor.polygon = emptyPolygon();
            venueInput.value = v.venueId;
            drawEditor();
          }),
        ]),
      ]),
    );
  }
  qaTable.append(qaBody);

  const venueInput = el("input", {
    type: "text",
    placeholder: "venue id (uuid)",
    "aria-label": "Venue id",
    class: "mono",
  }) as HTMLInputElement;
  venueInput.value = editor.venueId;
  venueInput.addEventListener("input", () => {
    editor.venueId = venueInput.value.trim();
  });

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "editor-canvas");
  svg.setAttribute("viewBox", "0 0 640 420");
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "Geofence polygon editor — click to add vertices");

  const readout = el("p", { class: "lede", id: "editor-readout" }, ["Click the canvas to start a polygon."]);
  const status = el("p", { class: "notice", id: "editor-status", role: "status" }, []);

  function currentProjector() {
    const b = bounds(editor.polygon.vertices) ?? { minLng: 3.35, minLat: 6.44, maxLng: 3.42, maxLat: 6.5 };
    return projector(b, { width: 640, height: 420, padding: 24 });
  }

  function drawEditor(): void {
    const proj = currentProjector();
    const pts = editor.polygon.vertices.map((v) => proj.toScreen(v));
    svg.replaceChildren();
    if (pts.length > 1) {
      const shape = document.createElementNS(
        "http://www.w3.org/2000/svg",
        editor.polygon.closed ? "polygon" : "polyline",
      );
      shape.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
      shape.setAttribute("class", "editor-shape");
      svg.append(shape);
    }
    pts.forEach((p, i) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(p.x));
      c.setAttribute("cy", String(p.y));
      c.setAttribute("r", "6");
      c.setAttribute("class", "editor-vertex");
      c.dataset.index = String(i);
      svg.append(c);
    });
    const area = shoelaceAreaM2(editor.polygon.vertices);
    const validation = validateForSubmit(editor.polygon);
    readout.replaceChildren(
      `${editor.polygon.vertices.length} vertices · ${editor.polygon.closed ? "closed" : "open"} · area ≈ ${Math.round(area).toLocaleString()} m² · ${validation.ok ? "ready to submit" : validation.reason}`,
    );
  }

  svg.addEventListener("click", (event) => {
    const target = event.target as SVGElement;
    if (target.tagName === "circle") return; // vertex drag/delete handled separately
    const p = svgPoint(svg, event);
    const proj = currentProjector();
    // Midpoint insert on an edge of a closed polygon; append otherwise.
    if (editor.polygon.closed && editor.polygon.vertices.length >= 3) {
      const pts = editor.polygon.vertices.map((v) => proj.toScreen(v));
      const edge = hitTestEdge(pts, p, 8);
      if (edge !== null) {
        editor.polygon = insertVertexAfter(editor.polygon, edge, proj.toGeo(p));
        drawEditor();
        return;
      }
    }
    editor.polygon = addVertex(editor.polygon, proj.toGeo(p));
    drawEditor();
  });
  svg.addEventListener("pointerdown", (event) => {
    const target = event.target as SVGElement;
    if (target.tagName === "circle") editor.dragging = Number(target.dataset.index);
  });
  svg.addEventListener("pointermove", (event) => {
    if (editor.dragging < 0) return;
    const proj = currentProjector();
    editor.polygon = moveVertex(editor.polygon, editor.dragging, proj.toGeo(svgPoint(svg, event)));
    drawEditor();
  });
  svg.addEventListener("pointerup", () => {
    editor.dragging = -1;
  });
  svg.addEventListener("dblclick", (event) => {
    const proj = currentProjector();
    const pts = editor.polygon.vertices.map((v) => proj.toScreen(v));
    const hit = hitTestVertex(pts, svgPoint(svg, event), 10);
    if (hit !== null) {
      editor.polygon = deleteVertex(editor.polygon, hit);
      drawEditor();
    }
  });

  const controls = el("div", { class: "editor-controls" }, [
    button("Close polygon", () => {
      editor.polygon = closePolygon(editor.polygon);
      drawEditor();
    }),
    button("Reopen", () => {
      editor.polygon = reopenPolygon(editor.polygon);
      drawEditor();
    }),
    button("Clear", () => {
      editor.polygon = emptyPolygon();
      status.replaceChildren();
      drawEditor();
    }),
    button("Overlap check", () => {
      void guard(
        (async () => {
          const geojson = toGeoJSON(editor.polygon);
          if (!geojson) throw new Error(validateForSubmit(editor.polygon).ok ? "" : (validateForSubmit(editor.polygon) as { reason: string }).reason);
          const result = (await api().post("/v1/ops/geofences/overlap-check", {
            polygon: geojson,
            venueId: editor.venueId,
          })) as { ok: boolean; conflicts: { venueId: string; intersectionM2: number }[] };
          status.replaceChildren(
            result.ok
              ? "No overlap conflicts."
              : `Conflicts: ${result.conflicts.map((c) => `${c.venueId.slice(0, 8)} (${c.intersectionM2} m²)`).join(", ")}`,
          );
        })(),
      );
    }),
    button("Save draft", () => {
      void guard(
        (async () => {
          const geojson = toGeoJSON(editor.polygon);
          if (!geojson) throw new Error((validateForSubmit(editor.polygon) as { reason: string }).reason);
          if (!editor.venueId) throw new Error("a venue id is required");
          const result = (await api().post("/v1/ops/geofences", {
            targetType: "venue",
            venueId: editor.venueId,
            polygon: geojson,
          })) as { draftId: string; status: string };
          status.replaceChildren(`Draft ${result.draftId.slice(0, 8)} saved (${result.status}) — submit/approve/publish continue server-side.`);
          editor.polygon = emptyPolygon();
          drawEditor();
          return viewGeofences(panel);
        })(),
      );
    }, "primary"),
  ]);

  panel.replaceChildren(
    el("div", {}, [
      el("section", { class: "panel" }, [
        el("div", { class: "panel-head" }, [
          el("h2", {}, ["Estate QA"]),
          button("Refresh", () => {
            void guard(viewGeofences(panel));
          }),
        ]),
        venues.length === 0 ? emptyPanel("No venues in the QA report.") : qaTable,
      ]),
      el("section", { class: "panel" }, [
        el("h2", {}, ["GeoLibre editor"]),
        el("p", { class: "lede" }, [
          "Geometry-only editing (the basemap arrives with the map surface). Click to add vertices, drag to move, double-click to delete, click an edge to insert. Density and overlap are re-verified server-side at draft and publish.",
        ]),
        venueInput,
        svg,
        readout,
        status,
        controls,
      ]),
    ]),
  );
  drawEditor();
}

// -------------------------------------------------------------- routing ---

const SECTION_VIEWS: Partial<Record<ConsoleSection, (panel: HTMLElement) => Promise<void>>> = {
  dashboard: viewDashboard,
  moderation: viewModeration,
  appeals: viewAppeals,
  kyc: viewKyc,
  onboarding: viewOnboarding,
  elevation: viewElevation,
  geofences: viewGeofences,
  "security-events": viewSecurityEvents,
};

function contentEl(): HTMLElement {
  return document.getElementById("content") as HTMLElement;
}

function render(): void {
  if (!state.tokens) {
    renderSignIn();
    return;
  }
  const content = el("main", { class: "content", id: "content" });
  shell(content);
  const view = SECTION_VIEWS[state.section as ConsoleSection];
  if (!view) {
    content.replaceChildren(emptyPanel("Unknown section."));
    return;
  }
  content.replaceChildren(el("p", { class: "lede" }, ["Loading…"]));
  void guard(
    view(content).catch((err: unknown) => {
      if (err instanceof ConsoleAuthError) throw err;
      content.replaceChildren(
        errorPanel(err instanceof Error ? err.message : String(err), () => {
          void guard(view(content));
        }),
      );
    }),
  );
}

function route(): void {
  if (!state.tokens) {
    state.section = "sign-in";
    render();
    return;
  }
  const hash = window.location.hash.replace(/^#\//, "");
  const wanted = (CONSOLE_SECTIONS as readonly string[]).includes(hash)
    ? (hash as ConsoleSection)
    : defaultSection(state.roles);
  state.section = wanted ?? "sign-in";
  render();
}

async function handleCallback(config: ConsoleConfig): Promise<void> {
  const raw = sessionStorage.getItem(TX_KEY);
  sessionStorage.removeItem(TX_KEY);
  const main = root();
  if (!raw) {
    state.notice = "No sign-in in progress — start again.";
    renderSignIn();
    return;
  }
  const transaction = JSON.parse(raw) as { state: string; verifier: string };
  const result = parseCallback(window.location.href, transaction.state);
  if (result.kind === "error") {
    state.notice = `Sign-in failed (${result.error}).`;
    history.replaceState(null, "", "/");
    renderSignIn();
    return;
  }
  try {
    const tokens = await exchangeCode(
      oidcConfig(config),
      result.code,
      transaction.verifier,
      oidcEffects,
      (url, init) => fetch(url, init),
    );
    state.tokens = tokens;
    state.roles = rolesOf(tokens.accessToken);
    if (!hasConsoleAccess(state.roles)) {
      state.tokens = null;
      state.notice = "This account holds no workforce console role.";
      renderSignIn();
      return;
    }
    history.replaceState(null, "", `/#/${defaultSection(state.roles) ?? "dashboard"}`);
    route();
  } catch (err) {
    state.notice = err instanceof Error ? err.message : String(err);
    renderSignIn();
  }
}

/** Proactive refresh inside the 30 s margin — same discipline as AMD-CRT-02. */
function startRefreshLoop(): void {
  window.setInterval(() => {
    if (!state.tokens || !state.config) return;
    if (sessionState(state.tokens, Date.now()) !== "refresh-due") return;
    const current = state.tokens;
    void guard(
      refreshTokens(oidcConfig(state.config), current.refreshToken, oidcEffects, (url, init) =>
        fetch(url, init),
      ).then((tokens) => {
        state.tokens = tokens;
      }),
    );
  }, 15_000);
}

async function boot(): Promise<void> {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* SW failure never blocks the console */
    });
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return; // once-guard: no reload loops
      reloaded = true;
      window.location.reload();
    });
  }
  const config = (await (await fetch("/config.json")).json()) as ConsoleConfig;
  state.config = config;
  if (window.location.pathname.endsWith("/auth/callback")) {
    await handleCallback(config);
    return;
  }
  window.addEventListener("hashchange", route);
  startRefreshLoop();
  route();
}

void boot();
