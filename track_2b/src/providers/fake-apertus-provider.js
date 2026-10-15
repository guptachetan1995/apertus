'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectLanguage } = require('../language');

const DEFAULT_FIXTURES = path.join(__dirname, '..', '..', 'data', 'fake-provider-fixtures.json');

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

function firstUrgentTerm(text, terms) {
  const lower = text.toLowerCase();
  const hit = terms.find((term) => lower.includes(term));
  if (!hit) return null;
  const start = lower.indexOf(hit);
  // Quote the term as the guest wrote it, extended to the end of the word.
  const end = text.slice(start).search(/[\s.,;:!?)]/);
  return text.slice(start, end === -1 ? text.length : start + end);
}

/**
 * Stands in for the model with no network and no randomness: the same review always gets
 * the same answer. The seeded reviews have canned, hand-written results; any other text
 * gets the shared language detector, a category from the rating (or a health term), and a
 * stock reply in the detected language. Its output is never presented as Apertus output;
 * describe() says so and the dashboard shows it.
 */
class FakeApertusProvider {
  constructor({ fixturesPath = DEFAULT_FIXTURES } = {}) {
    this.fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  }

  describe() {
    return {
      kind: 'fake',
      apertus: false,
      model: 'fixture provider (canned output, not a model)',
      endpointHost: null,
    };
  }

  async classify(review) {
    const canned = this.fixtures.byId[review.id];
    if (canned) {
      return {
        language: canned.language,
        category: canned.category,
        rationale: canned.triageRationale,
      };
    }
    const { generic } = this.fixtures;
    const { language } = detectLanguage(review.originalText);
    const evidence = firstUrgentTerm(review.originalText, generic.urgentTerms[language] || []);
    let category = review.rating >= 4 ? 'praise' : 'complaint';
    if (evidence) category = 'urgent';
    return {
      language,
      category,
      rationale: fill(generic.triageRationale[category], { evidence, rating: review.rating }),
    };
  }

  async draftReply(review) {
    const canned = this.fixtures.byId[review.id];
    if (canned && canned.language === review.detectedLanguage) {
      return { reply: canned.reply, rationale: canned.draftRationale };
    }
    const { generic } = this.fixtures;
    const replies = generic.replies[review.detectedLanguage];
    if (!replies) {
      throw new Error(`the fixture provider has no reply text for language "${review.detectedLanguage}"`);
    }
    return {
      reply: replies[review.triageCategory],
      rationale: generic.draftRationale[review.triageCategory],
    };
  }
}

module.exports = { FakeApertusProvider };
