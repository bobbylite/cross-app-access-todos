import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { jsonSchema, tool, type Tool } from 'ai';

/**
 * The todos MCP server, as seen by the agent.
 *
 * The only credential here is the access token the Resource AS minted from the ID-JAG.
 * It is bound to this user and this resource, so the tool surface the agent gets is
 * exactly the tool surface that user is entitled to — the server enforces scope, and an
 * under-scoped token simply cannot call the write tools.
 */

export interface McpSession {
  tools: Record<string, Tool>;
  close: () => Promise<void>;
}

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

export async function connectMcp(
  resourceUrl: string,
  accessToken: string,
  onToolCall?: (name: string, args: unknown) => void,
): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });

  const client = new Client(
    { name: 'xaa-todos-agent', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const listed = await client.listTools();

  // Each MCP tool becomes an AI SDK tool whose execute() calls back over the same
  // authenticated transport. The model never sees the token.
  const tools: Record<string, Tool> = {};
  for (const descriptor of listed.tools) {
    tools[descriptor.name] = tool({
      description: descriptor.description ?? descriptor.name,
      inputSchema: jsonSchema(
        (descriptor.inputSchema ?? { type: 'object', properties: {} }) as never,
      ),
      execute: async (args: unknown) => {
        onToolCall?.(descriptor.name, args);
        const result = await client.callTool({
          name: descriptor.name,
          arguments: (args ?? {}) as Record<string, unknown>,
        });
        if ((result as { isError?: boolean }).isError) {
          return `The todos app refused that: ${flatten(result)}`;
        }
        return flatten(result);
      },
    });
  }

  return {
    tools,
    close: async () => {
      try {
        await client.close();
      } catch {
        // A closed transport on teardown is not worth surfacing.
      }
    },
  };
}
