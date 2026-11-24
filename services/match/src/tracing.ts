/**
 * TECH-12: OpenTelemetry traces by default, not by opt-in. Same contract as
 * the edge (services/edge/src/tracing.ts): the SDK starts before the module
 * graph loads so http/fastify/pg/ioredis are patched in time; spans go
 * OTLP/HTTP to the cluster collector (TECH-11).
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
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  return sdk;
}
