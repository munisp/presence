/**
 * TECH-12: OpenTelemetry traces by default, not by opt-in. The SDK starts
 * before the rest of the module graph loads (index.ts dynamic-imports the
 * real entrypoint after calling startTracing) so the auto-instrumentations
 * patch http, fastify, pg and ioredis before any of them is imported.
 *
 * TECH-11: spans go OTLP/HTTP to the cluster collector
 * (deploy/k8s/observability.yaml), which fans out to Tempo for Grafana.
 * OTEL_EXPORTER_OTLP_ENDPOINT overrides the in-cluster default; set
 * OTEL_SDK_DISABLED=true to opt out (local bare-metal runs).
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export function startTracing(serviceName: string): NodeSDK | null {
  if (process.env.OTEL_SDK_DISABLED === "true") return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      "deployment.environment.name": process.env.DEPLOY_ENV ?? "local",
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is pure noise on a JSON API surface.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  return sdk;
}
