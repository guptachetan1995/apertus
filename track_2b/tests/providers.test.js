'use strict';

const net = require('node:net');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');
const { createProvider } = require('../src/providers');
const { detectLanguage } = require('../src/language');
const { loadConfig } = require('../src/config');
const seeds = require('../data/seed-reviews.json');

const EXPECTED = {
  rev_001: ['de', 'complaint'],
  rev_002: ['fr', 'urgent'],
  rev_003: ['it', 'praise'],
  rev_004: ['en', 'praise'],
  rev_005: ['de', 'praise'],
  rev_006: ['it', 'complaint'],
};

describe('FakeApertusProvider', () => {
  const provider = new FakeApertusProvider();

  test('classifies each seeded review with a language and category', async () => {
    for (const review of seeds) {
      const found = await provider.classify(review);
      expect([found.language, found.category]).toEqual(EXPECTED[review.id]);
    }
  });

  test('is deterministic: the same review always gets the same answer', async () => {
    const other = new FakeApertusProvider();
    for (const review of seeds) {
      const triaged = { ...review, detectedLanguage: EXPECTED[review.id][0], triageCategory: EXPECTED[review.id][1] };
      expect(await provider.classify(review)).toEqual(await provider.classify(review));
      expect(await provider.classify(review)).toEqual(await other.classify(review));
      expect(await provider.draftReply(triaged)).toEqual(await other.draftReply(triaged));
    }
  });

  test('quotes words that really are in the review in every canned reason', async () => {
    for (const review of seeds) {
      const { rationale } = await provider.classify(review);
      const quoted = [...rationale.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      expect(quoted.length).toBeGreaterThan(0);
      for (const phrase of quoted) {
        expect(review.originalText.toLowerCase()).toContain(phrase.toLowerCase());
      }
    }
  });

  test('drafts a reply in the review\'s own language, in English rationale', async () => {
    for (const review of seeds) {
      const [language, category] = EXPECTED[review.id];
      const draft = await provider.draftReply({ ...review, detectedLanguage: language, triageCategory: category });
      expect(detectLanguage(draft.reply).language).toBe(language);
      expect(detectLanguage(draft.rationale).language).toBe('en');
    }
  });

  test('handles reviews it has no canned answer for: language, a health term, then the rating', async () => {
    const base = { id: 'x_1', source: 's', receivedAt: '2026-10-06T00:00:00Z' };
    const urgent = await provider.classify({ ...base, rating: 3, originalText: "Après le dîner, nous avons eu une intoxication alimentaire et nous sommes très déçus de la cuisine." });
    expect([urgent.language, urgent.category]).toEqual(['fr', 'urgent']);
    expect(urgent.rationale).toContain('intoxication');

    const low = await provider.classify({ ...base, rating: 1, originalText: 'The room was small and we were not happy with the noise at night, which was very loud.' });
    expect([low.language, low.category]).toEqual(['en', 'complaint']);

    const high = await provider.classify({ ...base, rating: 5, originalText: 'Wir hatten einen sehr schönen Aufenthalt und sind mit allem sehr zufrieden gewesen.' });
    expect([high.language, high.category]).toEqual(['de', 'praise']);
  });

  test('reports plainly that it is not a model', () => {
    expect(provider.describe()).toMatchObject({ kind: 'fake', apertus: false, endpointHost: null });
  });

  test('makes no network connection', async () => {
    const connect = jest.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    for (const review of seeds) {
      await provider.classify(review);
      await provider.draftReply({ ...review, detectedLanguage: EXPECTED[review.id][0], triageCategory: EXPECTED[review.id][1] });
    }
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('createProvider', () => {
  test('is the offline fixture provider when no LLM variables are set', () => {
    expect(createProvider(loadConfig({})).describe().kind).toBe('fake');
  });

  test('with all three LLM variables set, never quietly falls back to the fixture', () => {
    const config = loadConfig({ LLM_NAME: 'm', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: 'a-test-key-value' });
    const provider = createProvider(config);
    expect(provider.describe()).toMatchObject({ kind: 'openai-compatible', endpointHost: '127.0.0.1:1' });
    expect(provider.describe().kind).not.toBe('fake');
  });
});
