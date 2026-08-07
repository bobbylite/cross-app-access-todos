import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/**
 * The narration layer. Every validation step publishes exactly one event here, which
 * goes to stdout and to the live console over SSE. The order events arrive in is the
 * order the checks run in, which is the order they get talked through on stage.
 */

export type StepStatus = "pass" | "fail" | "info";

export interface TraceStep {
  /** Step label as it appears in the spec walkthrough, e.g. "3. typ header". */
  step: string;
  status: StepStatus;
  /** One line on what was actually compared, with the real values. */
  detail: string;
  /** OAuth error code when this step rejected the request. */
  error?: string;
}

export interface TraceEvent extends TraceStep {
  traceId: string;
  /** Which server emitted this — the console shows them in separate lanes. */
  source: "resource-as" | "mcp";
  seq: number;
  at: string;
}

export interface TraceExtras {
  /** Decoded JWTs to display alongside the steps. */
  tokens?: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Recent events, replayed to a console that connects mid-flow. */
const recent: (TraceEvent | TraceExtrasEvent)[] = [];
const RECENT_LIMIT = 400;

export interface TraceExtrasEvent {
  traceId: string;
  source: "resource-as" | "mcp";
  kind: "tokens";
  tokens: Record<string, unknown>;
  at: string;
}

function publish(event: TraceEvent | TraceExtrasEvent): void {
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  bus.emit("trace", event);
}

const STATUS_MARK: Record<StepStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  info: "····",
};

/**
 * A single request's narration. Steps are numbered by arrival so the console and the
 * logs agree even when a request bails out early.
 */
export class Trace {
  readonly traceId = randomUUID().slice(0, 8);
  private seq = 0;

  constructor(private readonly source: "resource-as" | "mcp") {}

  step(step: TraceStep): void {
    const event: TraceEvent = {
      ...step,
      traceId: this.traceId,
      source: this.source,
      seq: ++this.seq,
      at: new Date().toISOString(),
    };
    publish(event);
    const mark = STATUS_MARK[step.status];
    const suffix = step.error ? ` (${step.error})` : "";
    console.log(
      `[${this.traceId}] ${mark}  ${step.step.padEnd(28)} ${step.detail}${suffix}`,
    );
  }

  pass(step: string, detail: string): void {
    this.step({ step, status: "pass", detail });
  }

  info(step: string, detail: string): void {
    this.step({ step, status: "info", detail });
  }

  /** Records the rejection and returns an Error the route handler can throw. */
  fail(step: string, detail: string, error: string): void {
    this.step({ step, status: "fail", detail, error });
  }

  /** Publishes decoded token payloads for the console's side-by-side panel. */
  tokens(tokens: Record<string, unknown>): void {
    publish({
      traceId: this.traceId,
      source: this.source,
      kind: "tokens",
      tokens,
      at: new Date().toISOString(),
    });
  }
}

export function subscribe(
  listener: (event: TraceEvent | TraceExtrasEvent) => void,
): () => void {
  bus.on("trace", listener);
  return () => bus.off("trace", listener);
}

export function recentEvents(): (TraceEvent | TraceExtrasEvent)[] {
  return [...recent];
}
