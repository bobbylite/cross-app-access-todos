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

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'todos-agent',
  }),
  traceExporter: new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      'http://localhost:8083/v1/traces',
  }),
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

process.once('SIGTERM', () => {
  void sdk.shutdown();
});
