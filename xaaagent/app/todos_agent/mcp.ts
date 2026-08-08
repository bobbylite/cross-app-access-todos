import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jsonSchema, tool, type Tool } from 'ai';

/**
 * The todos MCP server, as seen by the agent.
 *
 * The only credential here is the access token the Resource AS minted from the ID-JAG.
 * It is bound to this user and this resource, so the tool surface the agent gets is
 * exactly the surface that user is entitled to.
 *
 * The agent deliberately arrives under-privileged — read-only — and widens only when the
 * resource refuses with a 403 that names the scope it wants. That step-up happens inside
 * the tool call, so the model never sees a failure and the extra authority is visibly
 * earned rather than assumed.
 */

/** The resource says the token is too narrow, and names what it needs. */
export class InsufficientScope extends Error {
  constructor(readonly required: string[]) {
    super(`The resource requires scope [${required.join(' ')}]`);
    this.name = 'InsufficientScope';
  }
}

export interface McpSession {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

/** Called when a 403 names a wider scope. Returns a token that carries it. */
export type StepUp = (required: string[]) => Promise<string>;

/** Pulls the plain-text payload out of an MCP tool result. */
function flatten(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  return text || JSON.stringify(result);
}

interface Connection {
  client: Client;
  /** Set when the last response was a 403 naming a scope. */
  challenged: () => string[] | null;
}

/**
 * One authenticated MCP connection.
 *
 * The custom fetch exists to read the 403's `WWW-Authenticate`. Without it the SDK
 * surfaces a generic transport error and the scope the server asked for is lost — the
 * one fact needed to widen by exactly the right amount and no more.
 */
async function connect(resourceUrl: string, accessToken: string): Promise<Connection> {
  let challenged: string[] | null = null;

  const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: async (input, init) => {
      const response = await fetch(input as string | URL | Request, init);
      if (response.status === 403) {
        const header = response.headers.get('www-authenticate') ?? '';
        const named = header.match(/scope="([^"]+)"/)?.[1];
        if (header.includes('insufficient_scope') && named) {
          challenged = named.split(/\s+/).filter(Boolean);
        }
      }
      return response;
    },
  });

  const client = new Client(
    { name: 'xaa-todos-agent', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  return {
    client,
    challenged: () => challenged,
  };
}

export async function connectMcp(
  resourceUrl: string,
  accessToken: string,
  options: { onStepUp?: StepUp; onToolCall?: (name: string, args: unknown) => void } = {},
): Promise<McpSession> {
  let active = await connect(resourceUrl, accessToken);
  const listed = await active.client.listTools();

  const tools: Record<string, Tool> = {};
  for (const descriptor of listed.tools) {
    tools[descriptor.name] = tool({
      description: descriptor.description ?? descriptor.name,
      inputSchema: jsonSchema(
        (descriptor.inputSchema ?? { type: 'object', properties: {} }) as never,
      ),
      execute: async (args: unknown) => {
        options.onToolCall?.(descriptor.name, args);
        const call = { name: descriptor.name, arguments: (args ?? {}) as Record<string, unknown> };

        try {
          const result = await active.client.callTool(call);
          if ((result as { isError?: boolean }).isError) {
            return `The todos app refused that: ${flatten(result)}`;
          }
          return flatten(result);
        } catch (error) {
          const required = active.challenged();
          if (!required) throw error;

          // The resource named a wider scope. Earn it, reconnect, and try once more —
          // the model is never told any of this happened.
          if (!options.onStepUp) throw new InsufficientScope(required);

          const widerToken = await options.onStepUp(required);
          await active.client.close().catch(() => {});
          active = await connect(resourceUrl, widerToken);

          const result = await active.client.callTool(call);
          if ((result as { isError?: boolean }).isError) {
            return `The todos app refused that: ${flatten(result)}`;
          }
          return flatten(result);
        }
      },
    });
  }

  return {
    tools,
    close: async () => {
      try {
        await active.client.close();
      } catch {
        // A closed transport on teardown is not worth surfacing.
      }
    },
  };
}
