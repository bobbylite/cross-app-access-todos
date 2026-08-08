import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry for the agent, started before the runtime loads.
 *
 * Spans go to the chat app's OTLP receiver, the same place the todos platform sends
 * its own — which is what puts the agent, PingFederate, the Resource AS and the MCP
 * server on one timeline instead of four.
 *
 * Deployed, this is the line to repoint at AgentCore Observability; nothing else about
 * the agent changes.
 */

/**
 * Where to send spans.
 *
 * `agentcore dev` sets OTEL_EXPORTER_OTLP_ENDPOINT to a local collector on :4318 that
 * isn't running, so spans silently vanish — the SDK starts fine and reports nothing.
 * Precedence here puts our own variable first, then the OTLP *traces* variable (a full
 * URL by spec), then the OTLP *base* variable with /v1/traces appended as the spec
 * requires. Only then the demo default.
 */
function tracesEndpoint(): string {
  const explicit = process.env.XAA_OTLP_TRACES_URL?.trim();
  if (explicit) return explicit;

  const tracesVar = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesVar) return tracesVar;

  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (base) return `${base.replace(/\/$/, '')}/v1/traces`;

  return 'http://localhost:8083/v1/traces';
}

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'todos-agent',
  }),
  traceExporter: new OTLPTraceExporter({ url: tracesEndpoint() }),
  instrumentations: [
    new HttpInstrumentation({
      // The runtime's own health probes would outnumber the interesting spans.
      ignoreIncomingRequestHook: (request) => {
        const url = request.url ?? '';
        return url === '/ping' || url === '/health' || url === '/favicon.ico';
      },
      ignoreOutgoingRequestHook: (options) =>
        ((options as { path?: string }).path ?? '').startsWith('/v1/traces'),
    }),
    // Global fetch: the PingFederate exchange, the Resource AS redemption, and the
    // MCP transport all go through it, so this is what produces the cross-domain hops.
    new UndiciInstrumentation(),
  ],
});

sdk.start();
// Worth one line at boot: a silently misdirected exporter is invisible otherwise.
console.log(`[otel] exporting spans to ${tracesEndpoint()}`);

process.once('SIGTERM', () => {
  void sdk.shutdown();
});
