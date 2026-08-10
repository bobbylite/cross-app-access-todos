import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';

/**
 * Picks the LLM provider + model for this agent.
 *
 * MCP tool-calling isn't provider-specific — this agent already speaks MCP (mcp.ts)
 * and hands tools to whichever model runs here via the Vercel AI SDK's provider-agnostic
 * `tool()` format. What varies per provider is whether the model itself supports
 * tool/function calling, which the AI SDK normalizes (OpenAI `tools`, Anthropic
 * `tool_use`, Google `functionDeclarations`, Bedrock Converse tool config) into the
 * single `LanguageModel` interface main.ts already consumes. Swapping providers is
 * therefore just swapping which SDK factory builds that LanguageModel.
 *
 * MODEL_PROVIDER selects which one. Unset (or "bedrock") preserves the original
 * zero-config behavior so nothing already deployed regresses.
 */

type Provider = 'bedrock' | 'anthropic' | 'openai' | 'google' | 'openai-compatible';

const PROVIDER = (process.env.MODEL_PROVIDER?.trim().toLowerCase() || 'bedrock') as Provider;

function requireEnv(name: string, hint?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required when MODEL_PROVIDER=${PROVIDER}.` + (hint ? ` ${hint}` : ''),
    );
  }
  return value;
}

function loadBedrockModel(): LanguageModel {
  const provider = fromNodeProviderChain();
  const bedrock = createAmazonBedrock({
    region: process.env.AWS_REGION ?? 'us-east-2',
    credentialProvider: async () => {
      const creds = await provider();
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      };
    },
  });
  // BEDROCK_MODEL_ID is a Bedrock-only override kept for back-compat; MODEL_ID wins
  // when set, for consistency with the other providers below.
  const modelId =
    process.env.MODEL_ID ?? process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-opus-5';
  return bedrock(modelId);
}

function loadAnthropicModel(): LanguageModel {
  const anthropic = createAnthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return anthropic(requireEnv('MODEL_ID', 'e.g. MODEL_ID=claude-opus-5'));
}

function loadOpenAIModel(): LanguageModel {
  const openai = createOpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  return openai(requireEnv('MODEL_ID', 'e.g. MODEL_ID=gpt-4.1'));
}

function loadGoogleModel(): LanguageModel {
  const google = createGoogleGenerativeAI({
    apiKey: requireEnv('GOOGLE_GENERATIVE_AI_API_KEY'),
  });
  return google(requireEnv('MODEL_ID', 'e.g. MODEL_ID=gemini-2.5-pro'));
}

function loadOpenAICompatibleModel(): LanguageModel {
  // Local/self-hosted runtimes that speak the OpenAI chat-completions wire format —
  // Ollama, LM Studio, vLLM, etc.
  const baseURL = requireEnv(
    'OPENAI_COMPATIBLE_BASE_URL',
    'e.g. http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio).',
  );
  const provider = createOpenAICompatible({
    name: process.env.OPENAI_COMPATIBLE_NAME ?? 'openai-compatible',
    baseURL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  });
  return provider(
    requireEnv('MODEL_ID', 'e.g. MODEL_ID=llama3.1 — must already be pulled/loaded locally.'),
  );
}

export function loadModel(): LanguageModel {
  switch (PROVIDER) {
    case 'bedrock':
      return loadBedrockModel();
    case 'anthropic':
      return loadAnthropicModel();
    case 'openai':
      return loadOpenAIModel();
    case 'google':
      return loadGoogleModel();
    case 'openai-compatible':
      return loadOpenAICompatibleModel();
    default:
      throw new Error(
        `Unknown MODEL_PROVIDER "${PROVIDER}". Expected one of: ` +
          'bedrock, anthropic, openai, google, openai-compatible.',
      );
  }
}
