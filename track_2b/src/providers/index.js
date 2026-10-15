'use strict';

const { FakeApertusProvider } = require('./fake-apertus-provider');
const { OpenAICompatibleProvider } = require('./openai-compatible-provider');

/**
 * Chooses the provider from the loaded config. With none of LLM_NAME, LLM_BASE_URL and
 * LLM_API_KEY set the app runs offline on the fixture provider; with all three set it talks
 * to that OpenAI-compatible endpoint. There is no quiet fallback from the second to the
 * first: a run that says it used a model must have used one.
 */
function createProvider(config, options = {}) {
  if (config.llm) return new OpenAICompatibleProvider({ ...config.llm, ...options });
  return new FakeApertusProvider();
}

module.exports = { createProvider };
