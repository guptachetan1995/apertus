'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, loadSeedReviews, SEED_FIELDS } = require('../src/store');
const { harness, steppingClock } = require('./helpers');

const seed = [
  { id: 'a', source: 's', originalText: 'Das war sehr gut und wir kommen gerne wieder.', rating: 5, receivedAt: '2026-10-01T00:00:00Z' },
  { id: 'b', source: 's', originalText: 'The coffee was cold and nobody came to help us.', rating: 1, receivedAt: '2026-10-02T00:00:00Z' },
];

describe('the store state machine', () => {
  test('starts every review unreviewed with nothing drafted or published', () => {
    const store = createStore({ seed, now: steppingClock() });
    for (const review of store.list()) {
      expect(review).toMatchObject({ replyStatus: 'unreviewed', draftReply: null, publishedReply: null, detectedLanguage: null, draftVersion: 0 });
    }
  });

  test('unreviewed -> drafted -> published, and only publish() produces published', () => {
    const store = createStore({ seed, now: steppingClock() });
    store.applyTriage('a', { language: 'de', category: 'praise', rationale: 'r', provider: { kind: 'fake' } });
    expect(store.get('a').replyStatus).toBe('unreviewed');
    store.writeDraft('a', { category: 'praise', reply: 'Danke!', rationale: 'r' });
    expect(store.get('a').replyStatus).toBe('drafted');
    store.publish('a');
    expect(store.get('a').replyStatus).toBe('published');
  });

  test('a rejected review can be drafted again; a published one cannot', () => {
    const store = createStore({ seed, now: steppingClock() });
    store.writeDraft('a', { category: 'praise', reply: 'Danke!', rationale: 'r' });
    store.reject('a', 'no');
    expect(store.get('a').replyStatus).toBe('rejected');
    store.writeDraft('a', { category: 'praise', reply: 'Danke sehr!', rationale: 'r' });
    store.publish('a');
    expect(() => store.writeDraft('a', { category: 'praise', reply: 'x', rationale: 'r' })).toThrow(/already has a published reply/);
  });

  test('two overlapping triage runs cannot overwrite each other', () => {
    const store = createStore({ seed, now: steppingClock() });
    expect(store.applyTriage('a', { language: 'de', category: 'praise', rationale: 'first', provider: null })).toBe(true);
    expect(store.applyTriage('a', { language: 'fr', category: 'urgent', rationale: 'second', provider: null })).toBe(false);
    expect(store.get('a')).toMatchObject({ detectedLanguage: 'de', triageRationale: 'first' });
  });

  test('rejects duplicate ids in the seed', () => {
    expect(() => createStore({ seed: [seed[0], seed[0]] })).toThrow(/duplicate/);
  });

  test('log entries are numbered and copies', () => {
    const store = createStore({ seed, now: steppingClock() });
    const entry = store.appendLog({ actor: 'agent', tool: 'x' });
    entry.actor = 'owner';
    expect(store.log()).toEqual([expect.objectContaining({ seq: 1, actor: 'agent' })]);
  });
});

describe('the seed file (the only source of reviews)', () => {
  const seedFile = (value) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-seed-')), 'seed-reviews.json');
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };

  test('the documented fields are the fields the bundled seed really has', () => {
    const bundled = loadSeedReviews();
    expect(SEED_FIELDS).toEqual(['id', 'source', 'originalText', 'rating', 'receivedAt']);
    for (const review of bundled) expect(Object.keys(review).sort()).toEqual([...SEED_FIELDS].sort());
  });

  test('a modified seed file loads, and its reviews are triaged and drafted like the bundled ones', async () => {
    const mine = [
      { id: 'mine_1', source: 'Our own reviews', originalText: 'Das Zimmer war sauber und das Personal sehr freundlich, danke!', rating: 5, receivedAt: '2026-10-10T09:00:00Z' },
      { id: 'mine_2', source: 'Our own reviews', originalText: 'Le café était froid et personne ne s\'est occupé de nous.', rating: 2, receivedAt: '2026-10-11T10:30:00+02:00' },
    ];
    const loaded = loadSeedReviews(seedFile(mine));
    expect(loaded).toEqual(mine);
    const { store, invoke, provider } = harness({ seed: loaded });
    expect(store.list().map((r) => r.id)).toEqual(['mine_1', 'mine_2']);
    const triage = await invoke('triage_reviews', {}, 'agent');
    expect(triage.ok).toBe(true);
    expect(store.get('mine_1')).toMatchObject({ detectedLanguage: 'de', triageCategory: 'praise' });
    expect(store.get('mine_2')).toMatchObject({ detectedLanguage: 'fr', triageCategory: 'complaint' });
    const review = store.get('mine_2');
    const draft = await provider.draftReply(review);
    const outcome = await invoke('draft_reply', { id: 'mine_2', category: 'complaint', ...draft }, 'agent');
    expect(outcome.ok).toBe(true);
    expect(store.get('mine_2').replyStatus).toBe('drafted');
  });

  test.each([
    ['not an array', { id: 'x' }, /must be a JSON array with at least one review/],
    ['an empty array', [], /at least one review/],
    ['a missing id', [{ source: 's', originalText: 't', rating: 3, receivedAt: '2026-10-01T00:00:00Z' }], /review 1: "id" must be a non-empty string/],
    ['an empty text', [{ id: 'a', source: 's', originalText: '  ', rating: 3, receivedAt: '2026-10-01T00:00:00Z' }], /review 1 \("a"\): "originalText"/],
    ['a rating of 0', [{ id: 'a', source: 's', originalText: 't', rating: 0, receivedAt: '2026-10-01T00:00:00Z' }], /"rating" must be a whole number from 1 to 5/],
    ['a rating of 4.5', [{ id: 'a', source: 's', originalText: 't', rating: 4.5, receivedAt: '2026-10-01T00:00:00Z' }], /"rating"/],
    ['a rating as text', [{ id: 'a', source: 's', originalText: 't', rating: '5', receivedAt: '2026-10-01T00:00:00Z' }], /"rating"/],
    ['an unreadable date', [{ id: 'a', source: 's', originalText: 't', rating: 3, receivedAt: 'last Tuesday' }], /"receivedAt" must be a date-time string/],
  ])('refuses %s, naming the file and the problem', (_label, value, message) => {
    expect(() => loadSeedReviews(seedFile(value))).toThrow(message);
    expect(() => loadSeedReviews(seedFile(value))).toThrow(/seed-reviews\.json/);
  });

  test('a duplicate id is refused when the store is built', () => {
    const one = { id: 'dup', source: 's', originalText: 't', rating: 3, receivedAt: '2026-10-01T00:00:00Z' };
    expect(() => createStore({ seed: loadSeedReviews(seedFile([one, one])) })).toThrow(/duplicate review id in seed: dup/);
  });
});
