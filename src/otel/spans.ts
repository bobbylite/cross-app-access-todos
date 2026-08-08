import { SpanStatusCode, context, trace as otelTrace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { StepStatus } from "../trace.js";

/**
 * The ten checks, as spans.
 *
 * The Resource AS already narrates every step through `trace.ts`. This turns the same
 * events into OpenTelemetry spans without touching a single call site — the console and
 * the trace are two consumers of one narration, which is why adding observability here
 * cost almost nothing.
 *
 * Attributes are deliberately domain-specific. There is no OTel semantic convention for
 * an authorization decision, so `xaa.*` is ours: what was asked for, what was granted,
 * and which rule decided. That is the part worth querying later.
 */

const tracer = otelTrace.getTracer("cross-app-access");

export interface StepSpanInput {
  step: string;
  status: StepStatus;
  detail: string;
  error?: string;
}

/**
 * Records one completed check as a child of whatever span is currently active.
 *
 * Zero-duration by design: these are decisions, not work. The exception is step 2, whose
 * JWKS fetch shows up as a real child span from the fetch instrumentation — which is the
 * one place in the pipeline where latency is worth talking about.
 */
export function recordStep(input: StepSpanInput): void {
  const span = tracer.startSpan(input.step, {
    attributes: {
      "xaa.step": input.step,
      "xaa.status": input.status,
      "xaa.detail": input.detail,
      ...(input.error ? { "xaa.error": input.error } : {}),
    },
  });

  if (input.status === "fail") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: input.detail });
  }
  span.end();
}

/** Runs `fn` inside a named span, so everything it does nests underneath. */
export async function inSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  try {
    return await context.with(otelTrace.setSpan(context.active(), span), () =>
      fn(span),
    );
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}

/** Adds attributes to the active span — used to hang the decision off the parent. */
export function annotate(attributes: Record<string, string | number | boolean>): void {
  otelTrace.getActiveSpan()?.setAttributes(attributes);
}
