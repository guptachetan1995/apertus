'use strict';

const { harness } = require('./helpers');
const { runAgent } = require('../src/agent');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');

describe('the built-in agent', () => {
  test('triages and drafts every review, urgent first, as the agent, and publishes nothing', async () => {
    const h = harness();
    const summary = await runAgent(h);
    expect(summary).toEqual({ triaged: 6, drafted: 6, skipped: [], refused: [], error: null });

    const drafts = h.store.log().filter((e) => e.tool === 'draft_reply').map((e) => e.args.id);
    expect(drafts[0]).toBe('rev_002');
    expect(drafts).toHaveLength(6);
    expect(h.store.log().every((e) => e.actor === 'agent')).toBe(true);
    expect(h.store.list().every((r) => r.replyStatus === 'drafted' && r.publishedReply === null)).toBe(true);
  });

  test('a second run has nothing to do', async () => {
    const h = harness();
    await runAgent(h);
    expect(await runAgent(h)).toMatchObject({ triaged: 0, drafted: 0 });
  });

  test('drafts again for a review the owner rejected', async () => {
    const h = harness();
    await runAgent(h);
    await h.invoke('reject_reply', { id: 'rev_004', reason: 'Not warm enough' }, 'owner');
    expect(await runAgent(h)).toMatchObject({ drafted: 1 });
    expect(h.store.get('rev_004').replyStatus).toBe('drafted');
  });

  test('reports a draft the server refuses instead of forcing it through', async () => {
    class WrongLanguage extends FakeApertusProvider {
      async draftReply(review) {
        const draft = await super.draftReply(review);
        return review.id === 'rev_005'
          ? { ...draft, reply: 'Thank you very much for your kind review, we are delighted that you enjoyed it.' }
          : draft;
      }
    }
    const h = harness({ provider: new WrongLanguage() });
    const summary = await runAgent(h);
    expect(summary.drafted).toBe(5);
    expect(summary.refused).toEqual([expect.objectContaining({ id: 'rev_005', code: 'wrong_language' })]);
    expect(h.store.get('rev_005').replyStatus).toBe('unreviewed');
  });

  test('skips, and says so, when the provider cannot draft', async () => {
    class NoDraft extends FakeApertusProvider {
      async draftReply(review) {
        if (review.id === 'rev_001') throw new Error('model timed out');
        return super.draftReply(review);
      }
    }
    const h = harness({ provider: new NoDraft() });
    const summary = await runAgent(h);
    expect(summary.drafted).toBe(5);
    expect(summary.skipped).toEqual([{ id: 'rev_001', reason: 'no draft from the provider: model timed out' }]);
  });

  test('leaves a review whose language is not confirmed to the owner', async () => {
    class Confident extends FakeApertusProvider {
      async classify(review) {
        const found = await super.classify(review);
        return review.id === 'rev_001' ? { ...found, language: 'fr' } : found;
      }
    }
    const h = harness({ provider: new Confident() });
    const summary = await runAgent(h);
    expect(summary.skipped).toEqual([{ id: 'rev_001', reason: 'language not confirmed; the owner answers this one' }]);
    expect(summary.drafted).toBe(5);
  });

  test('reports a failed triage rather than drafting on nothing', async () => {
    class Down extends FakeApertusProvider {
      async classify() {
        throw new Error('endpoint unreachable');
      }
    }
    const summary = await runAgent(harness({ provider: new Down() }));
    expect(summary).toMatchObject({ triaged: 0, drafted: 0, error: { code: 'provider_error' } });
  });
});
