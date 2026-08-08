import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { loadModel } from './model/load.js';
import { connectMcp } from './mcp.js';
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
const ANONYMOUS_PROMPT = `You are a todos assistant, but nobody has signed in yet, so you
currently have no access to anyone's todos.

You can still answer questions about yourself and about how access works. If asked, you
can explain: the person signs in once with PingFederate, and you then exchange that
sign-in for a short-lived token scoped to their todos — they are never asked to log in
to the todos app separately.

The moment a request would need to read or change someone's todos, call the
request_sign_in tool. Do not guess, do not invent a list, and do not ask them to paste
anything. After calling it, say in one short sentence what you'll do once they're signed
in. Do not call it for questions you can answer without their data.`;

const requestSchema = z.object({
  prompt: z.string().default(''),
});

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

        let askedToSignIn = false;
        const result = streamText({
          model,
          system: ANONYMOUS_PROMPT,
          messages: [...history, userMessage],
          tools: {
            request_sign_in: tool({
              description:
                "Ask the person to sign in with PingFederate. Call this as soon as a " +
                "request needs their todos and you have no access.",
              inputSchema: z.object({
                reason: z
                  .string()
                  .describe('One short phrase: what you need access for.'),
              }),
              execute: async ({ reason }) => {
                askedToSignIn = true;
                return `A sign-in prompt has been shown to the user (${reason}). Tell ` +
                  `them briefly what you'll do once they are signed in.`;
              },
            }),
          },
          stopWhen: stepCountIs(3),
        });

        let anonymousReply = '';
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            anonymousReply += part.text;
            yield { data: part.text };
          } else if (part.type === 'tool-call' && part.toolName === 'request_sign_in') {
            // The client turns this into a login. It is the only way the agent can ask.
            yield trace({
              type: 'auth-required',
              reason: (part.input as { reason?: string })?.reason ?? 'access to your todos',
            });
          }
        }

        if (anonymousReply.length > 0 && !askedToSignIn) {
          history.push(userMessage, { role: 'assistant', content: anonymousReply });
        }
        return;
      }

      // ---- the chain -------------------------------------------------------------
      let granted;
      try {
        granted = await accessForSession(loadXaaConfig(), sessionId, token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield trace({ type: 'chain-failed', detail: message });
        yield { data: `I couldn't get access to the todos app.\n\n${message}` };
        return;
      }

      for (const step of granted.steps as ChainStep[]) {
        yield trace({ type: 'chain', ...step });
      }

      // ---- tools -----------------------------------------------------------------
      const session = await connectMcp(
        loadXaaConfig().mcpResource,
        granted.accessToken,
        () => {
          /* announced below via onStepFinish, which has the arguments resolved */
        },
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
