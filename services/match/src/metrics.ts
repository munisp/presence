/**
 * NFR-33: minimal in-process Prometheus counters rendered in the text
 * exposition format. The match service exposes only the two series the
 * MatchRateCollapse alert reads — scan demand and served results — via
 * GET /metrics. Aggregates only; no user data.
 */

export class Counter {
  private value = 0;

  constructor(
    public readonly name: string,
    private readonly help: string,
  ) {}

  inc(by = 1): void {
    this.value += by;
  }

  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }
}

export const scanRequests = new Counter(
  "match_scan_requests_total",
  "Scan requests received by the match service",
);

export const matchesServed = new Counter(
  "match_served_total",
  "Match results served by the match service",
);

export function renderMetrics(): string {
  return scanRequests.render() + "\n" + matchesServed.render() + "\n";
}
