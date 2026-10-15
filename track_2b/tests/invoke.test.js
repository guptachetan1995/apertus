'use strict';

const { harness, triageAndDraftAll } = require('./helpers');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');

const GERMAN_REPLY = 'Vielen Dank für Ihre Rückmeldung, wir haben sie an das ganze Team weitergegeben.';

describe('list_reviews and get_review', () => {
  test('list_reviews returns the six seeded reviews in arrival order, and can filter', async () => {
    const { invoke } = harness();
    const all = await invoke('list_reviews', {}, 'agent');
    expect(all.ok).toBe(true);
    expect(all.result.reviews.map((r) => r.id)).toEqual(['rev_001', 'rev_002', 'rev_003', 'rev_004', 'rev_005', 'rev_006']);
    const drafted = await invoke('list_reviews', { replyStatus: 'drafted' }, 'agent');
    expect(drafted.result.reviews).toEqual([]);
  });

  test('list_reviews refuses a status that does not exist', async () => {
    const { invoke } = harness();
    const out = await invoke('list_reviews', { replyStatus: 'archived' }, 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });

  test('get_review returns the full record and refuses an unknown id', async () => {
    const { invoke } = harness();
    const found = await invoke('get_review', { id: 'rev_002' }, 'agent');
    expect(found.result.review).toMatchObject({ id: 'rev_002', replyStatus: 'unreviewed', detectedLanguage: null });
    const missing = await invoke('get_review', { id: 'rev_999' }, 'agent');
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  test('what a caller gets back is a copy: changing it changes nothing in the store', async () => {
    const { invoke, store } = harness();
    const { result } = await invoke('list_reviews', {}, 'agent');
    result.reviews[0].replyStatus = 'published';
    expect(store.get('rev_001').replyStatus).toBe('unreviewed');
  });
});

describe('triage_reviews', () => {
  test('records language, category and reason, lists urgent first, and leaves replyStatus alone', async () => {
    const { invoke, store } = harness();
    const out = await invoke('triage_reviews', {}, 'agent');
    expect(out.ok).toBe(true);
    expect(out.result.triaged).toHaveLength(6);
    expect(out.result.triaged[0]).toMatchObject({ id: 'rev_002', category: 'urgent', language: 'fr' });
    expect(out.result.triaged.map((t) => t.category)).toEqual(['urgent', 'complaint', 'complaint', 'praise', 'praise', 'praise']);
    for (const review of store.list()) {
      expect(review.replyStatus).toBe('unreviewed');
      expect(review.draftReply).toBeNull();
      expect(review.detectedLanguage).not.toBeNull();
      expect(review.triageRationale).toEqual(expect.any(String));
    }
  });

  test('is safe to repeat: already triaged reviews are not touched', async () => {
    const { invoke, store } = harness();
    await invoke('triage_reviews', {}, 'agent');
    const before = JSON.stringify(store.list());
    const again = await invoke('triage_reviews', {}, 'agent');
    expect(again.result.triaged).toEqual([]);
    expect(JSON.stringify(store.list())).toBe(before);
  });

  test('records which provider produced the result, in the review and in the log', async () => {
    const { invoke, store } = harness();
    await invoke('triage_reviews', {}, 'agent');
    expect(store.get('rev_001').triageProvider).toMatchObject({ kind: 'fake', apertus: false });
    const entry = store.log().find((e) => e.tool === 'triage_reviews');
    expect(entry.provider).toMatchObject({ kind: 'fake', apertus: false });
  });

  test('refuses arguments it does not take', async () => {
    const { invoke } = harness();
    const out = await invoke('triage_reviews', { force: true }, 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });

  test('a provider failure on one review does not stop the others, and is reported', async () => {
    class Flaky extends FakeApertusProvider {
      async classify(review) {
        if (review.id === 'rev_003') throw new Error('model unavailable');
        return super.classify(review);
      }
    }
    const { invoke, store } = harness({ provider: new Flaky() });
    const out = await invoke('triage_reviews', {}, 'agent');
    expect(out.ok).toBe(true);
    expect(out.result.triaged).toHaveLength(5);
    expect(out.result.failed).toEqual([{ id: 'rev_003', message: 'model unavailable' }]);
    expect(store.get('rev_003').triagedAt).toBeNull();
  });

  test('refuses outright when the provider fails on every review', async () => {
    class Down extends FakeApertusProvider {
      async classify() {
        throw new Error('endpoint unreachable');
      }
    }
    const { invoke } = harness({ provider: new Down() });
    const out = await invoke('triage_reviews', {}, 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'provider_error' } });
  });

  test('refuses an unusable provider answer instead of storing it', async () => {
    class Garbage extends FakeApertusProvider {
      async classify() {
        return { language: 'de', category: 'spam', rationale: 'x' };
      }
    }
    const { invoke, store } = harness({ provider: new Garbage() });
    const out = await invoke('triage_reviews', {}, 'agent');
    expect(out.ok).toBe(false);
    expect(store.list().every((r) => r.triagedAt === null)).toBe(true);
  });

  test('when the model and the server\'s own check disagree about the language, the review is left to the owner', async () => {
    class Confident extends FakeApertusProvider {
      async classify(review) {
        const found = await super.classify(review);
        return review.id === 'rev_001' ? { ...found, language: 'fr' } : found;
      }
    }
    const { invoke, store } = harness({ provider: new Confident() });
    await invoke('triage_reviews', {}, 'agent');
    const review = store.get('rev_001');
    expect(review.detectedLanguage).toBe('und');
    expect(review.triageRationale).toMatch(/left for the owner/);
    const draft = await invoke(
      'draft_reply',
      { id: 'rev_001', category: 'complaint', reply: GERMAN_REPLY, rationale: 'a reply the server should not accept' },
      'agent',
    );
    expect(draft).toMatchObject({ ok: false, error: { code: 'language_unsupported' } });
  });

  test('a language outside the four is recorded as not confirmed', async () => {
    const seed = [{ id: 'es_1', source: 's', originalText: 'Muchas gracias por todo, el personal fue muy amable y volveremos pronto sin duda alguna.', rating: 5, receivedAt: '2026-10-06T00:00:00Z' }];
    class Spanish extends FakeApertusProvider {
      async classify() {
        return { language: 'es', category: 'praise', rationale: 'Praise.' };
      }
    }
    const { invoke, store } = harness({ provider: new Spanish(), seed });
    await invoke('triage_reviews', {}, 'agent');
    expect(store.get('es_1').detectedLanguage).toBe('und');
  });
});

describe('draft_reply', () => {
  async function triaged() {
    const h = harness();
    await h.invoke('triage_reviews', {}, 'agent');
    return h;
  }
  const valid = (overrides = {}) => ({
    id: 'rev_001',
    category: 'complaint',
    reply: GERMAN_REPLY,
    rationale: 'Complaint about a cold breakfast.',
    ...overrides,
  });

  test('saves the draft, moves the review to drafted, and never publishes', async () => {
    const { invoke, store } = await triaged();
    const out = await invoke('draft_reply', valid(), 'agent');
    expect(out).toMatchObject({ ok: true, result: { id: 'rev_001', replyStatus: 'drafted', draftVersion: 1 } });
    const review = store.get('rev_001');
    expect(review).toMatchObject({ replyStatus: 'drafted', draftReply: GERMAN_REPLY, draftCategory: 'complaint', publishedReply: null, publishedAt: null });
    expect(review.draftedAt).toEqual(expect.any(String));
  });

  test('refuses a smuggled replyStatus, says why, logs it, and changes nothing', async () => {
    const { invoke, store } = await triaged();
    const before = JSON.stringify(store.list());
    const out = await invoke('draft_reply', valid({ replyStatus: 'published' }), 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(out.error.message).toMatch(/replyStatus/);
    expect(out.error.message).toMatch(/only the owner can publish/);
    expect(JSON.stringify(store.list())).toBe(before);
    const entry = store.log().at(-1);
    expect(entry).toMatchObject({ actor: 'agent', tool: 'draft_reply', outcome: 'refused', result: 'refused: invalid_arguments' });
    expect(entry.args.replyStatus).toBe('published');
  });

  test.each(['publishedReply', 'publishedAt', 'draftVersion', 'detectedLanguage', 'id2'])(
    'refuses any other field smuggled in: %s',
    async (field) => {
      const { invoke } = await triaged();
      const out = await invoke('draft_reply', valid({ [field]: 'x' }), 'agent');
      expect(out).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    },
  );

  test('refuses a reply that is not in the review\'s own language', async () => {
    const { invoke, store } = await triaged();
    const english = 'Thank you very much for your feedback, we are sorry that the breakfast was cold.';
    const out = await invoke('draft_reply', valid({ reply: english }), 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'wrong_language' } });
    expect(out.error.message).toMatch(/"de"/);
    expect(store.get('rev_001').draftReply).toBeNull();
    expect(store.get('rev_001').replyStatus).toBe('unreviewed');
  });

  test('refuses a reply whose language cannot be told', async () => {
    const { invoke } = await triaged();
    const out = await invoke('draft_reply', valid({ reply: '1234567890 1234567890 1234567890' }), 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'wrong_language' } });
  });

  test('refuses an unknown id, a missing field and a wrong category', async () => {
    const { invoke } = await triaged();
    expect(await invoke('draft_reply', valid({ id: 'rev_999' }), 'agent')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    const { rationale, ...missing } = valid();
    expect(rationale).toBeDefined();
    expect(await invoke('draft_reply', missing, 'agent')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(await invoke('draft_reply', valid({ category: 'spam' }), 'agent')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
  });

  test('refuses a review that has not been triaged', async () => {
    const { invoke } = harness();
    const out = await invoke('draft_reply', valid(), 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'not_triaged' } });
  });

  test('refuses an empty or over-long reply', async () => {
    const { invoke } = await triaged();
    expect((await invoke('draft_reply', valid({ reply: '   ' }), 'agent')).error.code).toBe('invalid_arguments');
    expect((await invoke('draft_reply', valid({ reply: GERMAN_REPLY.repeat(30) }), 'agent')).error.code).toBe('invalid_arguments');
  });

  test('a second draft replaces the first and bumps the version', async () => {
    const { invoke, store } = await triaged();
    await invoke('draft_reply', valid(), 'agent');
    const second = 'Guten Tag und danke für Ihre Nachricht, wir sind der Sache nachgegangen und bitten um Entschuldigung.';
    await invoke('draft_reply', valid({ reply: second }), 'agent');
    expect(store.get('rev_001')).toMatchObject({ draftReply: second, draftVersion: 2 });
  });

  test('cannot draft over a published reply', async () => {
    const { invoke, store } = await triaged();
    await invoke('draft_reply', valid(), 'agent');
    await invoke('publish_reply', { id: 'rev_001' }, 'owner');
    const out = await invoke('draft_reply', valid(), 'agent');
    expect(out).toMatchObject({ ok: false, error: { code: 'already_published' } });
    expect(store.get('rev_001').publishedReply).toBe(GERMAN_REPLY);
  });
});

describe('the activity log', () => {
  test('every call is logged with its actor, allowed or refused', async () => {
    const { invoke, store } = harness();
    await invoke('triage_reviews', {}, 'agent');
    await invoke('get_review', { id: 'rev_001' }, 'owner');
    await invoke('get_review', { id: 'nope' }, 'agent');
    await invoke('publish_reply', { id: 'rev_001' }, 'agent');
    await invoke('no_such_tool', {}, 'owner');
    const log = store.log();
    expect(log.map((e) => [e.actor, e.tool, e.outcome])).toEqual([
      ['agent', 'triage_reviews', 'ok'],
      ['owner', 'get_review', 'ok'],
      ['agent', 'get_review', 'refused'],
      ['agent', 'publish_reply', 'refused'],
      ['owner', 'no_such_tool', 'refused'],
    ]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.every((e) => typeof e.timestamp === 'string')).toBe(true);
  });

  test('a draft and its publication are separate entries with different actors', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    await invoke('publish_reply', { id: 'rev_002' }, 'owner');
    const forRev2 = store.log().filter((e) => e.args && e.args.id === 'rev_002');
    expect(forRev2.map((e) => [e.actor, e.tool, e.result])).toEqual([
      ['agent', 'draft_reply', 'drafted'],
      ['owner', 'publish_reply', 'published'],
    ]);
  });

  test('an actor that is neither agent nor owner is refused and logged as unknown', async () => {
    const { invoke, store } = harness();
    for (const actor of [undefined, null, 'dashboard', 'Owner', 'owner ', '', 42, { toString: () => 'owner' }]) {
      const out = await invoke('list_reviews', {}, actor);
      expect(out).toMatchObject({ ok: false, error: { code: 'invalid_actor' } });
    }
    expect(store.log().every((e) => e.actor === 'unknown' && e.outcome === 'refused')).toBe(true);
  });

  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', '', 7, null])(
    'a tool name that is only an object property resolves to nothing: %p',
    async (tool) => {
      const { invoke } = harness();
      expect(await invoke(tool, {}, 'owner')).toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    },
  );

  test('long arguments are cut in the log, not stored whole', async () => {
    const { invoke, store } = harness();
    await invoke('triage_reviews', {}, 'agent');
    await invoke('draft_reply', { id: 'rev_001', category: 'complaint', reply: 'x'.repeat(5000), rationale: 'y'.repeat(20) }, 'agent');
    expect(store.log().at(-1).args.reply.length).toBeLessThan(700);
  });

  test('non-object arguments are refused, not crashed on', async () => {
    const { invoke } = harness();
    for (const args of [null, 'rev_001', 12, ['rev_001']]) {
      expect(await invoke('get_review', args, 'agent')).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    }
  });
});
