import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

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

/**
 * Claude haiku 4.5 through a cross-region inference profile.
 *
 * Bedrock invocation uses the profile id (`us.` prefix), not the bare model id
 * `anthropic.claude-opus-5` that `list-foundation-models` reports — both exist in
 * us-east-2 and only the profile is invokable. `global.anthropic.claude-opus-5` is the
 * other option if you want routing outside the US.
 */
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-opus-5';

export function loadModel() {
  return bedrock(MODEL_ID);
}
