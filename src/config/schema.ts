/**
 * The declarative source of truth for every environment variable this project reads,
 * across all three services plus the agent. One entry per variable name — a var read
 * by more than one service (e.g. `RESOURCE_AS_ISSUER`, read by both `resource` and the
 * agent, since it's the `aud` both sides compare) has one spec with multiple profiles,
 * not duplicate entries that could drift apart.
 *
 * This feeds two consumers: `validate.ts` (runtime checks) and the config editor's UI
 * (field grouping, hints, secret-masking). Hint text is carried over verbatim from the
 * original `src/config.ts` — it was already the best documentation in the repo.
 */

export type Profile = "resource" | "chat" | "agent";
export type FieldKind = "url" | "url-no-slash" | "number" | "scopes" | "string" | "enum";

export interface FieldSpec {
  name: string;
  profiles: Profile[];
  /** A function form covers fields that are only required under some other field's value. */
  required: boolean | ((values: Record<string, string>) => boolean);
  secret: boolean;
  group: string;
  default?: string;
  hint: string;
  kind: FieldKind;
  enumValues?: string[];
}

const isNonBedrock = (v: Record<string, string>): boolean =>
  Boolean(v.MODEL_PROVIDER && v.MODEL_PROVIDER !== "bedrock");

export const FIELDS: FieldSpec[] = [
  // ---- PingFederate ----------------------------------------------------------
  {
    name: "PF_ISSUER",
    profiles: ["resource", "chat"],
    required: true,
    secret: false,
    group: "PingFederate",
    hint: "PingFederate issuer URL, e.g. https://pf.example.com",
    kind: "url-no-slash",
  },
  {
    name: "PF_DISCOVERY_URL",
    profiles: ["resource", "chat"],
    required: false,
    secret: false,
    group: "PingFederate",
    hint: "Override the discovery document location; defaults to PF_ISSUER + /.well-known/openid-configuration",
    kind: "url",
  },
  {
    name: "PF_JWKS_URI",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "PingFederate",
    hint: "Skip discovery and point straight at PF's JWKS",
    kind: "url",
  },
  {
    name: "PF_TOKEN_ENDPOINT",
    profiles: ["agent"],
    required: true,
    secret: false,
    group: "PingFederate",
    hint: "PF's token endpoint, used for the agent's step-1 token exchange (ID-JAG)",
    kind: "url",
  },

  // ---- Resource AS ------------------------------------------------------------
  {
    name: "RESOURCE_AS_ISSUER",
    profiles: ["resource", "agent"],
    required: true,
    secret: false,
    group: "Resource AS",
    hint: "This server's issuer identifier — must match the audience registered in PingFederate exactly",
    kind: "url-no-slash",
  },
  {
    name: "AS_PORT",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "Resource AS",
    default: "8081",
    hint: "Resource AS listen port",
    kind: "number",
  },
  {
    name: "ACCESS_TOKEN_TTL_SECONDS",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "Resource AS",
    default: "900",
    hint: "Issued access token lifetime, in seconds",
    kind: "number",
  },
  {
    name: "CLOCK_SKEW_SECONDS",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "Resource AS",
    default: "60",
    hint: "Clock skew tolerance for JWT time checks",
    kind: "number",
  },
  {
    name: "ALLOWED_SCOPES",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "Resource AS",
    default: "todos.read todos.write",
    hint: "Scopes local policy is willing to grant (space-separated); the granted set is the intersection of this and what the ID-JAG asked for",
    kind: "scopes",
  },
  {
    name: "TODOS_DB_PATH",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "Resource AS",
    hint: "SQLite file path for the todos DB (:memory: for a throwaway store)",
    kind: "string",
  },

  // ---- MCP ----------------------------------------------------------------------
  {
    name: "MCP_RESOURCE",
    profiles: ["resource", "agent"],
    required: true,
    secret: false,
    group: "MCP",
    hint: "Canonical URI of the MCP server, e.g. http://localhost:8082/mcp — becomes the token aud",
    kind: "url",
  },
  {
    name: "MCP_PORT",
    profiles: ["resource"],
    required: false,
    secret: false,
    group: "MCP",
    default: "8082",
    hint: "MCP + Todos listen port",
    kind: "number",
  },

  // ---- Shared client credentials (redeems ID-JAGs at the Resource AS) -----------
  {
    name: "CLIENT_ID",
    profiles: ["resource", "agent"],
    required: true,
    secret: false,
    group: "Client credentials",
    hint: "client_id allowed to redeem ID-JAGs — the same client_id PingFederate puts in the assertion",
    kind: "string",
  },
  {
    name: "CLIENT_SECRET",
    profiles: ["resource", "agent"],
    required: true,
    secret: true,
    group: "Client credentials",
    hint: "Secret for CLIENT_ID, used for client authentication at POST /token",
    kind: "string",
  },

  // ---- Chat / OIDC ----------------------------------------------------------------
  {
    name: "CHAT_PORT",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat",
    default: "8083",
    hint: "Chat app listen port",
    kind: "number",
  },
  {
    name: "AGENT_URL",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat",
    default: "http://localhost:8080/invocations",
    hint: "Where chat forwards prompts — the agent's AgentCore /invocations endpoint",
    kind: "url",
  },
  {
    name: "AUDIT_URL",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat",
    default: "http://todos-mcp:8082/api/audit",
    hint: "Where chat polls the resource service's audit log — must resolve to the resource container",
    kind: "url",
  },
  {
    name: "OIDC_CLIENT_ID",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat OIDC (human sign-in)",
    hint: "Chat's own OIDC client id — a different client from CLIENT_ID above. Empty disables login.",
    kind: "string",
  },
  {
    name: "OIDC_CLIENT_SECRET",
    profiles: ["chat"],
    required: false,
    secret: true,
    group: "Chat OIDC (human sign-in)",
    hint: "Secret for a confidential OIDC client; leave empty for a public client (PKCE-only)",
    kind: "string",
  },
  {
    name: "OIDC_REDIRECT_URI",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat OIDC (human sign-in)",
    default: "http://localhost:8083/auth/callback",
    hint: "OIDC callback URL — must match what's registered at PF exactly",
    kind: "url",
  },
  {
    name: "OIDC_SCOPES",
    profiles: ["chat"],
    required: false,
    secret: false,
    group: "Chat OIDC (human sign-in)",
    default: "openid profile",
    hint: "Scopes requested at PF login (PF here rejects 'email' as unknown)",
    kind: "scopes",
  },

  // ---- Agent: XAA chain -----------------------------------------------------------
  {
    name: "XAA_SCOPE",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent — XAA chain",
    default: "todos.read todos.write",
    hint: "Default scope ceiling the agent requests",
    kind: "scopes",
  },

  // ---- Agent: model provider --------------------------------------------------
  {
    name: "MODEL_PROVIDER",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent — model",
    default: "bedrock",
    hint: "bedrock | anthropic | openai | google | openai-compatible",
    kind: "enum",
    enumValues: ["bedrock", "anthropic", "openai", "google", "openai-compatible"],
  },
  {
    name: "MODEL_ID",
    profiles: ["agent"],
    required: isNonBedrock,
    secret: false,
    group: "Agent — model",
    hint: "Model id for the active provider, e.g. claude-opus-5, gpt-4.1, gemini-2.5-pro, llama3.1",
    kind: "string",
  },
  {
    name: "AWS_REGION",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent — model",
    default: "us-east-2",
    hint: "Bedrock region (only used when MODEL_PROVIDER=bedrock)",
    kind: "string",
  },
  {
    name: "BEDROCK_MODEL_ID",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent — model",
    hint: "Bedrock-only model override; MODEL_ID wins if both are set",
    kind: "string",
  },
  {
    name: "ANTHROPIC_API_KEY",
    profiles: ["agent"],
    required: (v) => v.MODEL_PROVIDER === "anthropic",
    secret: true,
    group: "Agent — model",
    hint: "Required when MODEL_PROVIDER=anthropic",
    kind: "string",
  },
  {
    name: "OPENAI_API_KEY",
    profiles: ["agent"],
    required: (v) => v.MODEL_PROVIDER === "openai",
    secret: true,
    group: "Agent — model",
    hint: "Required when MODEL_PROVIDER=openai",
    kind: "string",
  },
  {
    name: "GOOGLE_GENERATIVE_AI_API_KEY",
    profiles: ["agent"],
    required: (v) => v.MODEL_PROVIDER === "google",
    secret: true,
    group: "Agent — model",
    hint: "Required when MODEL_PROVIDER=google",
    kind: "string",
  },
  {
    name: "OPENAI_COMPATIBLE_BASE_URL",
    profiles: ["agent"],
    required: (v) => v.MODEL_PROVIDER === "openai-compatible",
    secret: false,
    group: "Agent — model",
    hint: "e.g. http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio)",
    kind: "url",
  },
  {
    name: "OPENAI_COMPATIBLE_NAME",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent — model",
    default: "openai-compatible",
    hint: "Cosmetic provider label",
    kind: "string",
  },
  {
    name: "OPENAI_COMPATIBLE_API_KEY",
    profiles: ["agent"],
    required: false,
    secret: true,
    group: "Agent — model",
    hint: "Usually unnecessary for local runtimes",
    kind: "string",
  },
  {
    name: "PORT",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Agent",
    default: "8080",
    hint: "Agent's own HTTP listen port",
    kind: "number",
  },

  // ---- OpenTelemetry --------------------------------------------------------------
  {
    name: "OTEL_SERVICE_NAME",
    profiles: ["resource", "chat", "agent"],
    required: false,
    secret: false,
    group: "Telemetry",
    hint: "Resource service.name on exported spans (defaults differ per service)",
    kind: "string",
  },
  {
    name: "OTEL_EXPORTER_OTLP_ENDPOINT",
    profiles: ["resource", "agent"],
    required: false,
    secret: false,
    group: "Telemetry",
    default: "http://localhost:8083/v1/traces",
    hint: "Where OTLP spans go — must resolve to the chat container's /v1/traces",
    kind: "url",
  },
  {
    name: "XAA_OTLP_TRACES_URL",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Telemetry",
    hint: "Explicit OTLP traces URL override for the agent (highest precedence)",
    kind: "url",
  },
  {
    name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    profiles: ["agent"],
    required: false,
    secret: false,
    group: "Telemetry",
    hint: "Standard OTel traces-specific endpoint (second precedence)",
    kind: "url",
  },
];

export function fieldsForProfile(profile: Profile): FieldSpec[] {
  return FIELDS.filter((f) => f.profiles.includes(profile));
}
