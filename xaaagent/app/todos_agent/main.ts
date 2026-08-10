// Must be first: OpenTelemetry patches http and fetch as they load, so anything
// imported above this line would be invisible to the trace.
import './otel.js';

import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { loadModel } from './model/load.js';
import { connectMcp } from './mcp.js';
import { discoverAccessRequirements } from './discover.js';
import { accessForSession, loadXaaConfig, type ChainStep } from './xaa.js';

/**
 * A todos agent that never holds a credential for the todos app.
 *
 * On each turn it takes the caller's own token — validated by AgentCore's inbound
 * authorizer before this code runs — and trades it for a short-lived access token scoped
 * to one user and one resource. The tools it can call are whatever that token permits,
 * decided by the todos app rather than by anything in this file.
 */

const SYSTEM_PROMPT = `You are a todos assistant for a single signed-in person.

You act only through the tools you are given. Those tools already know who the user is —
never ask for a user id, and never accept one if it is offered. If you need to know what
is on their list, look, rather than guessing.

Be brief and concrete. When you change something, say what changed in one sentence and
include the item's title. When you are asked for a list, give it plainly; don't restate
the whole list after every change.

If a tool refuses because a permission is missing, say plainly what was refused and what
scope would have been needed. Do not retry it and do not look for another route to the
same thing.`;

/**
 * What the agent is told before anyone has signed in.
 *
 * It can still be useful — explain itself, answer questions about the flow — but it has
 * no tools and no way to see anyone's data. The moment a request would need the todos
 * app, it calls request_sign_in rather than apologising, and the client turns that into
 * a real PingFederate login.
 */
/**
 * What the agent is told before anyone has signed in.
 *
 * Note what it is *not* told: that a login is required. It doesn't know that yet, and
 * neither does anything else in this process. It is told only that it has one way to
 * reach the todos, and to use it when a request needs them. Whether that path is open
 * is decided by the resource server, not by this prompt.
 */
const ANONYMOUS_PROMPT = `You are a todos assistant.

Use the reach_todos tool whenever a request needs to read or change the person's todos.
Do not guess at their list, do not invent items, and do not ask them to paste anything —
call the tool and let it tell you what happens.

You can answer questions about yourself and about how access works without the tool.

If the tool reports that access is gated, say in one short sentence what you will do once
it opens. Do not speculate about why, and do not offer workarounds.`;

const requestSchema = z.object({
  prompt: z.string().default(''),
});

/**
 * `error.message` on a failed `fetch()` is almost always the unhelpful literal string
 * "fetch failed" — the actual reason (DNS lookup failure, connection refused, a bad
 * cert, ...) lives one level down in `error.cause`, which the raw message throws away.
 * Walks the whole cause chain so the real reason ends up in the trace instead of a
 * dead end.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' — caused by: ');
}

const HISTORY_LIMIT = 128;
const histories = new Map<string, ModelMessage[]>();

function getHistory(sessionId: string): ModelMessage[] {
  const existing = histories.get(sessionId);
  if (existing) {
    histories.delete(sessionId);
    histories.set(sessionId, existing);
    return existing;
  }
  if (histories.size >= HISTORY_LIMIT) {
    const oldest = histories.keys().next().value;
    if (oldest !== undefined) histories.delete(oldest);
  }
  const fresh: ModelMessage[] = [];
  histories.set(sessionId, fresh);
  return fresh;
}

/**
 * The caller's token.
 *
 * Locally this arrives because `agentcore dev -H` forwards it; deployed, it arrives
 * because the runtime's request-header allowlist passes it through after the inbound
 * authorizer has already verified it. Same header either way, which is what keeps the
 * local and deployed paths identical.
 */
function callerToken(context: unknown): string | null {
  const headers = (context as { headers?: Record<string, string> } | undefined)?.headers;
  if (!headers) return null;

  // The runtime filters incoming headers down to Authorization and Custom-*, so those
  // are the only two places worth looking.
  const match = Object.entries(headers).find(
    ([name]) =>
      name.toLowerCase() === 'authorization' ||
      name.toLowerCase() === 'custom-caller-token',
  );
  if (!match) return null;

  return match[1].replace(/^Bearer\s+/i, '').trim() || null;
}

/**
 * Marks a frame as structured trace rather than reply text.
 *
 * A NUL is the sentinel because the model will never emit one, so no reply can be
 * mistaken for a trace. Written as an escape rather than a literal — as a literal it is
 * an invisible byte in the source, which is a nasty thing to leave the next reader. The
 * chat client checks for the same constant.
 */
const TRACE_PREFIX = '\u0000TRACE';

/** Emitted as its own SSE frame so the UI can draw the chain rather than infer it. */
function trace(payload: Record<string, unknown>): { data: string } {
  return { data: `${TRACE_PREFIX}${JSON.stringify(payload)}` };
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      const sessionId = context?.sessionId ?? 'default-session';
      const history = getHistory(sessionId);

      const token = callerToken(context);

      // ---- nobody signed in yet ---------------------------------------------------
      if (!token) {
        const userMessage: ModelMessage = { role: 'user', content: payload.prompt };
        const model = await loadModel();

        // What the resource actually said, if we get as far as asking it. A holder
        // rather than a bare `let`: it is written inside a tool closure, and control
        // flow analysis cannot see that, so a plain variable narrows to `never` here.
        const gate: { pending: { reason: string; scope: string | null } | null } = {
          pending: null,
        };
        const discoverySteps: ChainStep[] = [];

        const result = streamText({
          model,
          system: ANONYMOUS_PROMPT,
          messages: [...history, userMessage],
          tools: {
            reach_todos: tool({
              description:
                "Reach the user's todos. Call this whenever a request needs to read " +
                "or change them.",
              inputSchema: z.object({
                intent: z
                  .string()
                  .describe('One short phrase: what you are trying to do.'),
              }),
              execute: async ({ intent }) => {
                // Try the resource for real. The 401 it returns — not this agent's
                // opinion — is what establishes that a sign-in is needed, and the
                // metadata it points at is what says an ID-JAG is the way in.
                try {
                  const discovery = await discoverAccessRequirements(
                    loadXaaConfig().mcpResource,
                    (step, detail, ok) =>
                      discoverySteps.push({ step, detail, ok }),
                  );
                  gate.pending = {
                    reason: intent,
                    scope: discovery.challenge.scope,
                  };
                  return (
                    `The todos server refused the call with 401 and asked for scope ` +
                    `[${discovery.challenge.scope ?? '?'}]. Its metadata says access ` +
                    `requires an ID-JAG, which requires the user's identity. A sign-in ` +
                    `prompt has been shown. Tell them briefly what you'll do once it's done.`
                  );
                } catch (error) {
                  const message = describeError(error);
                  discoverySteps.push({
                    step: 'Discovery failed',
                    detail: message,
                    ok: false,
                  });
                  return `Could not work out how to reach the todos: ${message}`;
                }
              },
            }),
          },
          stopWhen: stepCountIs(3),
        });

        let anonymousReply = '';
        // The model writes on both sides of the tool call, and the two runs of text
        // butt together ("I'll pull that up.There's a prompt...") without a break.
        let brokeForTool = false;
        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') brokeForTool = true;
          if (part.type === 'text-delta') {
            let text = part.text;
            if (brokeForTool && anonymousReply.length > 0) {
              text = `\n\n${text.replace(/^\s+/, '')}`;
              brokeForTool = false;
            }
            anonymousReply += text;
            yield { data: text };
          }
          // Discovery steps are emitted as they accumulate, so the pane shows the
          // 401 and the metadata walk *before* the sign-in card appears.
          while (discoverySteps.length > 0) {
            yield trace({ type: 'chain', ...discoverySteps.shift()! });
          }
          if (gate.pending) {
            yield trace({
              type: 'auth-required',
              reason: gate.pending.reason,
              scope: gate.pending.scope,
            });
            gate.pending = null;
          }
        }

        if (anonymousReply.length > 0 && discoverySteps.length === 0) {
          history.push(userMessage, { role: 'assistant', content: anonymousReply });
        }
        return;
      }

      // ---- the chain -------------------------------------------------------------
      // Start at the floor. Reading is the least a todos turn can need, so that is
      // what is asked for; a write earns its extra scope by being refused first. The
      // resource sets the ceiling, not the agent.
      let scopes = ['todos.read'];
      let granted;
      try {
        granted = await accessForSession(loadXaaConfig(), sessionId, token, scopes);
      } catch (error) {
        const message = describeError(error);
        yield trace({ type: 'chain-failed', detail: message });
        yield { data: `I couldn't get access to the todos app.\n\n${message}` };
        return;
      }

      for (const step of granted.steps as ChainStep[]) {
        yield trace({ type: 'chain', ...step });
      }

      // ---- tools -----------------------------------------------------------------
      //
      // Steps produced mid-turn by a scope step-up. Queued rather than yielded, because
      // the step-up happens inside a tool call and a generator can't yield from there.
      const stepUps: ChainStep[] = [];

      /**
       * Widens the grant, but only because the resource asked for it.
       *
       * The 403 named the scope, so the server sets the ceiling rather than the client
       * guessing. A whole fresh chain runs — new exchange, new assertion, new access
       * token — because the narrow one genuinely is not sufficient. Returns the wider
       * token so the tool call can be retried on it.
       */
      const stepUp = async (required: string[]): Promise<string> => {
        const before = scopes.join(' ');
        scopes = [...new Set([...scopes, ...required])].sort();
        stepUps.push({
          step: 'Scope step-up',
          detail:
            `Refused with 403, which named [${required.join(' ')}]. Re-running the ` +
            `chain for [${scopes.join(' ')}] — was [${before}]`,
          ok: true,
        });
        granted = await accessForSession(loadXaaConfig(), sessionId, token, scopes);
        for (const step of granted.steps) stepUps.push(step);
        return granted.accessToken;
      };

      const session = await connectMcp(
        loadXaaConfig().mcpResource,
        granted.accessToken,
        { onStepUp: stepUp },
      );

      try {
        const userMessage: ModelMessage = { role: 'user', content: payload.prompt };
        const model = await loadModel();

        const result = streamText({
          model,
          system: SYSTEM_PROMPT,
          messages: [...history, userMessage],
          tools: session.tools,
          // Enough room to read, act, and report back; a runaway loop stops here.
          stopWhen: stepCountIs(8),
        });

        let assistant = '';
        const pending: { data: string }[] = [];

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            assistant += part.text;
            yield { data: part.text };
          } else if (part.type === 'tool-call') {
            pending.push(
              trace({
                type: 'tool',
                name: part.toolName,
                args: part.input,
              }),
            );
          }
          // Tool traces are emitted between text chunks so the UI can interleave them
          // with the reply as it streams.
          while (pending.length > 0) yield pending.shift()!;
          // A step-up may have happened inside a tool call; drain it here, where
          // yielding is possible.
          while (stepUps.length > 0) {
            yield trace({ type: 'chain', ...stepUps.shift()! });
          }
        }

        while (stepUps.length > 0) {
          yield trace({ type: 'chain', ...stepUps.shift()! });
        }

        if (assistant.length > 0) {
          history.push(userMessage, { role: 'assistant', content: assistant });
        }
      } finally {
        await session.close();
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
