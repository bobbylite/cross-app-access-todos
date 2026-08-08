import { EventEmitter } from "node:events";

/**
 * An OTLP/HTTP receiver, living inside the chat app.
 *
 * Normally spans go to a collector and you look at them in Jaeger. Here the storyteller
 * owns the viewer, because the whole argument of the demo is that the trace *is* the
 * explanation — sending an audience to a second tool loses the moment.
 *
 * It is still real OpenTelemetry: real SDKs, real W3C propagation, real OTLP over HTTP
 * with the standard JSON encoding. Repointing OTEL_EXPORTER_OTLP_ENDPOINT at Jaeger or
 * CloudWatch is a one-variable change and nothing else moves.
 */

export type TrustDomain = "identity" | "agent" | "resource" | "unknown";

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  domain: TrustDomain;
  startMs: number;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export interface CollectedTrace {
  traceId: string;
  startMs: number;
  endMs: number;
  spans: CollectedSpan[];
}

const bus = new EventEmitter();
bus.setMaxListeners(50);

const traces = new Map<string, CollectedTrace>();
const TRACE_LIMIT = 40;

/**
 * Which side of the boundary a span is on.
 *
 * This is the single most important thing the screen conveys, so it is decided here
 * rather than guessed in the browser. `identity` is the IdP, `agent` is the caller,
 * `resource` is the app being reached into — the crossing between the last two is the
 * thing the demo exists to show.
 */
function classify(service: string, spanName: string): TrustDomain {
  const name = `${service} ${spanName}`.toLowerCase();

  if (name.includes("ping-devops") || name.includes("pingfederate")) {
    return "identity";
  }
  if (service === "todos-agent" || name.includes("invocations")) return "agent";
  if (service === "todos-platform" || service === "chat-client") return "resource";
  return "unknown";
}

/** OTLP encodes attribute values as a tagged union; flatten to something renderable. */
function readAttrValue(value: Record<string, unknown>): string | number | boolean {
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  return JSON.stringify(value);
}

function readAttributes(
  list: { key?: string; value?: Record<string, unknown> }[] | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const entry of list ?? []) {
    if (entry.key && entry.value) out[entry.key] = readAttrValue(entry.value);
  }
  return out;
}

/** OTLP timestamps are nanoseconds as strings, because JSON has no int64. */
function nanosToMs(value: unknown): number {
  if (typeof value === "string") return Number(BigInt(value) / 1000n) / 1000;
  if (typeof value === "number") return value / 1_000_000;
  return 0;
}

interface OtlpBody {
  resourceSpans?: {
    resource?: { attributes?: { key?: string; value?: Record<string, unknown> }[] };
    scopeSpans?: {
      spans?: Record<string, unknown>[];
    }[];
  }[];
}

/** Ingests one OTLP export. Returns the traces it touched, already updated. */
export function ingest(body: OtlpBody): CollectedTrace[] {
  const touched = new Set<string>();

  for (const resourceSpan of body.resourceSpans ?? []) {
    const resourceAttrs = readAttributes(resourceSpan.resource?.attributes);
    const service = String(resourceAttrs["service.name"] ?? "unknown");

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const raw of scopeSpan.spans ?? []) {
        const traceId = String(raw.traceId ?? "");
        const spanId = String(raw.spanId ?? "");
        if (!traceId || !spanId) continue;

        const attributes = readAttributes(
          raw.attributes as { key?: string; value?: Record<string, unknown> }[],
        );
        const name = String(raw.name ?? "span");
        const startMs = nanosToMs(raw.startTimeUnixNano);
        const endMs = nanosToMs(raw.endTimeUnixNano);
        const statusCode = (raw.status as { code?: number } | undefined)?.code;

        const span: CollectedSpan = {
          traceId,
          spanId,
          parentSpanId: raw.parentSpanId ? String(raw.parentSpanId) : null,
          name,
          service,
          domain: classify(service, `${name} ${attributes["url.full"] ?? ""}`),
          startMs,
          durationMs: Math.max(0, endMs - startMs),
          status: statusCode === 2 ? "error" : "ok",
          attributes,
        };

        const existing = traces.get(traceId);
        if (existing) {
          // Exports arrive in batches, so a trace is assembled over several requests.
          existing.spans = existing.spans
            .filter((s) => s.spanId !== span.spanId)
            .concat(span);
          existing.startMs = Math.min(existing.startMs, span.startMs);
          existing.endMs = Math.max(existing.endMs, endMs);
        } else {
          traces.set(traceId, {
            traceId,
            startMs: span.startMs,
            endMs,
            spans: [span],
          });
        }
        touched.add(traceId);
      }
    }
  }

  // Keep the map bounded; a demo machine shouldn't grow without limit.
  while (traces.size > TRACE_LIMIT) {
    const oldest = traces.keys().next().value;
    if (oldest === undefined) break;
    traces.delete(oldest);
  }

  const updated = [...touched]
    .map((id) => traces.get(id))
    .filter((t): t is CollectedTrace => Boolean(t));

  for (const trace of updated) bus.emit("trace", trace);
  return updated;
}

export function subscribe(listener: (trace: CollectedTrace) => void): () => void {
  bus.on("trace", listener);
  return () => bus.off("trace", listener);
}

export function recentTraces(limit = 5): CollectedTrace[] {
  return [...traces.values()].slice(-limit);
}
