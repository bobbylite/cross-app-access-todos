import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * OpenTelemetry, started before anything else in the process.
 *
 * This must be imported first — instrumentation patches `http`, `express` and `fetch`
 * as they load, so anything required earlier is invisible to it. `src/index.ts` imports
 * it on line one for exactly that reason.
 *
 * Spans go to the chat app, which runs its own OTLP receiver. That is unusual and
 * deliberate: the demo's point is that the trace is *the story*, so the storyteller
 * should own it rather than send people to a second tool. It is still real OTLP over
 * HTTP, so pointing OTEL_EXPORTER_OTLP_ENDPOINT at Jaeger or CloudWatch instead is a
 * one-variable change.
 */

const serviceName = process.env.OTEL_SERVICE_NAME ?? "todos-platform";
const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:8083/v1/traces";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  instrumentations: [
    // Health checks, the SSE streams, and static assets would bury the interesting
    // spans. The demo's signal is token endpoints and tool calls.
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => {
        const url = request.url ?? "";
        // Housekeeping the UI does on its own behalf — session polling, the trace
        // stream, static assets. Left in, these produce one-span traces that scroll
        // the interesting one off the screen mid-sentence.
        return (
          url === "/" ||
          url === "/favicon.ico" ||
          url.startsWith("/api/traces") ||
          url.startsWith("/api/obo") ||
          url.startsWith("/api/audit") ||
          url.startsWith("/api/session") ||
          url.startsWith("/api/logout") ||
          url.startsWith("/api/config") ||
          url.startsWith("/api/users") ||
          url.startsWith("/v1/traces") ||
          url.startsWith("/api/events") ||
          url.startsWith("/console") ||
          url.startsWith("/app") ||
          url.endsWith(".css") ||
          url.endsWith(".js")
        );
      },
      ignoreOutgoingRequestHook: (options) => {
        const path = (options as { path?: string }).path ?? "";
        // /api/audit: chat polls the resource service for this every 1500ms now that
        // it's a real cross-container hop instead of an in-process EventEmitter — left
        // in, that's a one-span orphan trace every tick, scrolling the real one off
        // screen exactly the way /v1/traces itself already had to be excluded for.
        return path.startsWith("/v1/traces") || path.startsWith("/api/audit");
      },
    }),
    new ExpressInstrumentation({
      // Express emits a span per middleware layer, which triples the tree depth for no
      // storytelling value. The route span from HttpInstrumentation is enough.
      ignoreLayersType: [
        "middleware" as never,
        "request_handler" as never,
      ],
    }),
    // Covers global fetch, which is how every outbound call in this repo is made.
    new UndiciInstrumentation(),
  ],
});

sdk.start();

process.once("SIGTERM", () => {
  void sdk.shutdown();
});
