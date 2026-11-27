/**
 * NFR-07/NFR-33: minimal in-process Prometheus registry — counters, gauges
 * and fixed-bucket histograms rendered in the text exposition format. No
 * dependency; the scrape endpoint (GET /metrics, outside the authed scope)
 * serves aggregates only, never per-user data (SEC-05/SEC-29 discipline).
 *
 * The series defined here are the ones deploy/k8s/prometheusrules.yaml
 * alerts on (NFR-33) plus the realtime-delivery SLO (NFR-07).
 */

export type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelKey(labels: Labels | undefined, names: string[]): string {
  if (!labels || names.length === 0) return "";
  return names.map((n) => `${n}="${escapeLabel(String(labels[n] ?? ""))}"`).join(",");
}

export class Counter {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    private readonly help: string,
    private readonly labelNames: string[] = [],
  ) {}

  inc(labels?: Labels, by = 1): void {
    const key = labelKey(labels, this.labelNames);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    private readonly help: string,
    private readonly labelNames: string[] = [],
  ) {}

  set(value: number, labels?: Labels): void {
    this.values.set(labelKey(labels, this.labelNames), value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines.join("\n");
  }
}

interface HistogramSeries {
  counts: number[]; // one per bucket; the +Inf count is the total
  sum: number;
  count: number;
}

export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    public readonly name: string,
    private readonly help: string,
    private readonly buckets: number[],
    private readonly labelNames: string[] = [],
  ) {}

  observe(value: number, labels?: Labels): void {
    const key = labelKey(labels, this.labelNames);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    // First matching bucket only — the render pass accumulates into the
    // cumulative form Prometheus expects.
    for (const [i, b] of this.buckets.entries()) {
      if (value <= b) {
        s.counts[i] += 1;
        break;
      }
    }
    s.sum += value;
    s.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      // Prometheus buckets are cumulative.
      let cumulative = 0;
      for (const [i, b] of this.buckets.entries()) {
        cumulative += s.counts[i];
        const le = key ? `${key},le="${b}"` : `le="${b}"`;
        lines.push(`${this.name}_bucket{${le}} ${cumulative}`);
      }
      const inf = key ? `${key},le="+Inf"` : `le="+Inf"`;
      lines.push(`${this.name}_bucket{${inf}} ${s.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${s.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export class Registry {
  private readonly collectors = new Map<string, Counter | Gauge | Histogram>();

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const existing = this.collectors.get(name);
    if (existing) return existing as Counter;
    const c = new Counter(name, help, labelNames);
    this.collectors.set(name, c);
    return c;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const existing = this.collectors.get(name);
    if (existing) return existing as Gauge;
    const g = new Gauge(name, help, labelNames);
    this.collectors.set(name, g);
    return g;
  }

  histogram(name: string, help: string, buckets: number[], labelNames: string[] = []): Histogram {
    const existing = this.collectors.get(name);
    if (existing) return existing as Histogram;
    const h = new Histogram(name, help, buckets, labelNames);
    this.collectors.set(name, h);
    return h;
  }

  render(): string {
    return [...this.collectors.values()].map((c) => c.render()).join("\n") + "\n";
  }
}

/** Process-wide registry; the scrape endpoint renders it. */
export const metrics = new Registry();

// NFR-33 alert inputs (deploy/k8s/prometheusrules.yaml).
export const httpDuration = () =>
  metrics.histogram(
    "presence_http_request_duration_seconds",
    "Edge HTTP request duration in seconds",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.12, 0.25, 0.5, 1, 2.5],
    ["route", "method"],
  );

export const httpRequests = () =>
  metrics.counter(
    "presence_http_requests_total",
    "Edge HTTP requests by route, method and status",
    ["route", "method", "status"],
  );

export const publishFailures = () =>
  metrics.counter(
    "presence_publish_failures_total",
    "Presence publishes that failed (5xx on POST /v1/presence)",
  );

// NFR-07: sender-to-device delivery p95 ≤ 500 ms — the server-side leg we
// control is the realtime publish; the alert fires when its p95 exceeds the
// budget the client leg is measured against.
export const realtimePublishDuration = () =>
  metrics.histogram(
    "presence_realtime_publish_duration_seconds",
    "Realtime publish call duration in seconds",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    ["channel_class"],
  );

export const realtimePublishFailures = () =>
  metrics.counter(
    "presence_realtime_publish_failures_total",
    "Realtime publish calls that failed",
    ["channel_class"],
  );

export const moderationQueueAge = () =>
  metrics.gauge(
    "moderation_oldest_open_report_seconds",
    "Age in seconds of the oldest open moderation report",
  );

// AMD-ESC-02: dispute liveness — funds stay held while an escrow sits in
// the disputed state, so an ageing queue means stuck user money. Refreshed
// on scrape (aggregate seconds only, never row data).
export const escrowDisputeAge = () =>
  metrics.gauge(
    "presence_escrow_oldest_dispute_seconds",
    "Age in seconds of the oldest disputed escrow",
  );

// AMD-PAY-22/AMD-OPS-01: webhook acceptance vs rejection feeds the rail
// alerts — a rejection spike is either an attack or a broken provider
// credential, both page-worthy.
export const walletWebhookResults = () =>
  metrics.counter(
    "presence_wallet_webhook_results_total",
    "Wallet rail webhook results by route and result",
    ["route", "result"],
  );

// AMD-KYC-09: the OpenKYC verdict webhook is unauthed machine traffic —
// every verdict is counted so a grinding spike (rejected) or a
// misconfigured deployment (unconfigured) is visible.
export const kycWebhookResults = () =>
  metrics.counter(
    "presence_kyc_webhook_results_total",
    "OpenKYC verdict webhook results",
    ["result"],
  );

// AMD-WA-02/04: the WhatsApp webhook is unauthed machine traffic and the
// notification leg is env-gated — webhook verdicts (rejected spikes =
// attack or broken app secret) and leg outcomes (unconfigured/capped
// drift) are both counted.
export const whatsappWebhookResults = () =>
  metrics.counter(
    "presence_whatsapp_webhook_results_total",
    "WhatsApp Cloud API webhook results",
    ["result"],
  );

export const whatsappLegResults = () =>
  metrics.counter(
    "presence_whatsapp_leg_results_total",
    "WhatsApp notification leg outcomes",
    ["result"],
  );

// AMD-INN-09: attestation verification is an unauthed oracle — every verdict
// is counted so a grinding spike (invalid) or a misconfigured deployment
// (unconfigured) is visible.
export const attestationVerifyResults = () =>
  metrics.counter(
    "presence_attestation_verify_results_total",
    "Attestation verification verdicts",
    ["result"],
  );
