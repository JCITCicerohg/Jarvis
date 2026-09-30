import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config.ts';
import { HttpEmbedder, LocalEmbedder, azureEmbedTarget, openaiEmbedTarget, type Embedder } from '../embed/embedder.ts';
import { ModelPlanner, type Planner } from '../query/planner.ts';
import { AnthropicJson, azureJson, openaiJson, type CreateClient, type JsonModel } from './json-model.ts';

/** The planner model from KB_LLM_PROVIDER / KB_LLM_MODEL (cheapest model by default). */
export function createJsonModel(env: Env): JsonModel {
  switch (env.llm.provider) {
    case 'anthropic': return new AnthropicJson(new Anthropic() as unknown as CreateClient, env.llm.model);
    case 'openai': return openaiJson(env.openaiKey, env.llm.model).model;
    case 'azure': return azureJson(env.azure, env.llm.model).model;
  }
}

export const createPlanner = (env: Env): Planner => new ModelPlanner(createJsonModel(env));

export function createEmbedder(env: Env): Embedder {
  if (env.embedProvider === 'local') return new LocalEmbedder();
  return new HttpEmbedder(env.embedProvider === 'azure' ? azureEmbedTarget(env.azure) : openaiEmbedTarget(env.openaiKey));
}
