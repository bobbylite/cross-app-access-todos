import { FIELDS, fieldsForProfile, type Profile } from "./schema.js";

export interface Finding {
  field: string;
  level: "error" | "warn";
  message: string;
}

/** `aud` comparison is an exact string match, so a stray trailing slash is a real bug. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isRequired(
  required: boolean | ((values: Record<string, string>) => boolean),
  values: Record<string, string>,
): boolean {
  return typeof required === "function" ? required(values) : required;
}

/** Single-file checks: is this profile's own env, taken alone, valid and complete. */
export function validateProfile(
  profile: Profile,
  values: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];

  for (const field of fieldsForProfile(profile)) {
    const raw = values[field.name]?.trim();

    if (!raw) {
      if (isRequired(field.required, values) && !field.default) {
        findings.push({
          field: field.name,
          level: "error",
          message: `Required — ${field.hint}`,
        });
      }
      continue;
    }

    switch (field.kind) {
      case "number":
        if (!Number.isFinite(Number(raw))) {
          findings.push({
            field: field.name,
            level: "error",
            message: `Must be a number, got ${JSON.stringify(raw)}`,
          });
        }
        break;
      case "url":
      case "url-no-slash":
        try {
          new URL(raw);
          if (field.kind === "url-no-slash" && raw.endsWith("/")) {
            findings.push({
              field: field.name,
              level: "warn",
              message: "Has a trailing slash — this is compared as an exact string elsewhere, strip it",
            });
          }
        } catch {
          findings.push({ field: field.name, level: "error", message: "Not a valid URL" });
        }
        break;
      case "enum":
        if (field.enumValues && !field.enumValues.includes(raw)) {
          findings.push({
            field: field.name,
            level: "error",
            message: `Must be one of: ${field.enumValues.join(", ")}`,
          });
        }
        break;
      case "scopes":
      case "string":
        break;
    }
  }

  return findings;
}

/**
 * Cross-file checks — only the config editor, holding all three profiles' values at
 * once, can catch these. Each one here is a real failure mode this project has hit.
 */
export function validateConsistency(
  files: Partial<Record<Profile, Record<string, string>>>,
): Finding[] {
  const findings: Finding[] = [];
  const resource = files.resource ?? {};
  const chat = files.chat ?? {};
  const agent = files.agent ?? {};

  const same = (a: string | undefined, b: string | undefined, field: string, message: string) => {
    if (a && b && stripTrailingSlash(a) !== stripTrailingSlash(b)) {
      findings.push({ field, level: "error", message });
    }
  };

  same(
    resource.RESOURCE_AS_ISSUER,
    agent.RESOURCE_AS_ISSUER,
    "RESOURCE_AS_ISSUER",
    "Differs between resource.env and agent.env — this is the ID-JAG audience; a mismatch fails as an opaque signature error at token exchange",
  );
  same(
    resource.MCP_RESOURCE,
    agent.MCP_RESOURCE,
    "MCP_RESOURCE",
    "Differs between resource.env and agent.env — this becomes the access token's aud, checked by the MCP server",
  );
  same(
    resource.CLIENT_ID,
    agent.CLIENT_ID,
    "CLIENT_ID",
    "Differs between resource.env and agent.env — the Resource AS checks the redeeming client matches who the assertion was issued to",
  );
  same(
    resource.CLIENT_SECRET,
    agent.CLIENT_SECRET,
    "CLIENT_SECRET",
    "Differs between resource.env and agent.env",
  );
  same(resource.PF_ISSUER, chat.PF_ISSUER, "PF_ISSUER", "Differs between resource.env and chat.env");

  if (agent.MCP_RESOURCE && !agent.MCP_RESOURCE.endsWith("/mcp")) {
    findings.push({
      field: "MCP_RESOURCE",
      level: "warn",
      message: "Doesn't end in /mcp — check this is the canonical MCP resource URI, not just the host",
    });
  }

  if (chat.AGENT_URL && !chat.AGENT_URL.endsWith("/invocations")) {
    findings.push({
      field: "AGENT_URL",
      level: "warn",
      message: "Doesn't end in /invocations — the agent's AgentCore contract expects that path",
    });
  }

  // The telemetry tripwire: both exporters must land on the chat container's /v1/traces,
  // or the trace pane goes quiet with no error anywhere to explain why.
  const otelTargets = [
    ["resource.OTEL_EXPORTER_OTLP_ENDPOINT", resource.OTEL_EXPORTER_OTLP_ENDPOINT],
    ["agent.XAA_OTLP_TRACES_URL", agent.XAA_OTLP_TRACES_URL],
    ["agent.OTEL_EXPORTER_OTLP_ENDPOINT", agent.OTEL_EXPORTER_OTLP_ENDPOINT],
  ] as const;
  for (const [label, value] of otelTargets) {
    if (value && !value.includes("/v1/traces")) {
      findings.push({
        field: label,
        level: "warn",
        message: "Doesn't end in /v1/traces — spans exported here won't reach the chat app's OTLP receiver",
      });
    }
  }

  return findings;
}

export function assertProfileValid(profile: Profile, values: Record<string, string>): void {
  const errors = validateProfile(profile, values).filter((f) => f.level === "error");
  if (errors.length === 0) return;
  const lines = errors.map((f) => `  - ${f.field} — ${f.message}`).join("\n");
  throw new Error(
    `Missing or invalid environment configuration for '${profile}':\n${lines}\n\n` +
      `Copy the matching .env.example template and fill these in.`,
  );
}

export { FIELDS };
