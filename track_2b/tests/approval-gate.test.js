'use strict';

const { harness, triageAndDraftAll } = require('./helpers');
const { assertGateHolds } = require('./gate-contract');
const { agentTools } = require('../src/tools');
const { ownerVerbs } = require('../src/owner-verbs');
const { createInvoke } = require('../src/invoke');

describe('publish_reply and reject_reply are not agent tools', () => {
  test('the agent registry holds exactly the four agent tools', () => {
    expect(Object.keys(agentTools).sort()).toEqual(['draft_reply', 'get_review', 'list_reviews', 'triage_reviews']);
  });

  test('an agent is never shown the owner verbs, in the tool list or anywhere in it', () => {
    const { describeTools } = harness();
    const shown = describeTools('agent');
    expect(shown.map((t) => t.name).sort()).toEqual(['draft_reply', 'get_review', 'list_reviews', 'triage_reviews']);
    const everything = JSON.stringify(shown);
    expect(everything).not.toMatch(/publish_reply|reject_reply/);
  });

  test('the owner is shown all six', () => {
    const { describeTools } = harness();
    expect(describeTools('owner').map((t) => t.name).sort()).toEqual([
      'draft_reply', 'get_review', 'list_reviews', 'publish_reply', 'reject_reply', 'triage_reviews',
    ]);
  });

  test('every tool description says what it does not do, and none is a one-liner', () => {
    for (const tool of [...Object.values(agentTools), ...Object.values(ownerVerbs)]) {
      expect(tool.description.length).toBeGreaterThan(160);
      expect(tool.description).toMatch(/\bnot\b|never|cannot|refuses|only/i);
    }
    expect(agentTools.draft_reply.description).toMatch(/Nothing is posted/);
    expect(ownerVerbs.publish_reply.description).toMatch(/never offered to an agent/);
  });
});

describe('the gate holds against everything an agent can try', () => {
  test('publish_reply and reject_reply are refused for the agent, even called directly on invoke()', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    const published = await invoke('publish_reply', { id: 'rev_002' }, 'agent');
    expect(published).toMatchObject({ ok: false, error: { code: 'forbidden_actor' } });
    const rejected = await invoke('reject_reply', { id: 'rev_002', reason: 'not mine to reject' }, 'agent');
    expect(rejected).toMatchObject({ ok: false, error: { code: 'forbidden_actor' } });
    expect(store.get('rev_002')).toMatchObject({ replyStatus: 'drafted', publishedReply: null });
    expect(store.get('rev_002').draftReply).not.toBeNull();
  });

  test('the full battery of agent attempts leaves every review untouched', async () => {
    await assertGateHolds(harness());
  });

  test('a seeded fuzz of agent calls never reaches published, and a refusal never changes a review', async () => {
    const h = harness();
    await triageAndDraftAll(h);
    let state = 20261007;
    const next = (n) => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state % n;
    };
    const tools = [...Object.keys(agentTools), 'publish_reply', 'reject_reply', 'approve', 'constructor'];
    const ids = ['rev_001', 'rev_002', 'rev_003', 'rev_999', '', 7, null];
    const extras = [{}, { replyStatus: 'published' }, { publishedReply: 'x' }, { draftVersion: 1 }, { reason: 'because I say so' }, { force: true }];
    for (let i = 0; i < 300; i += 1) {
      const before = JSON.stringify(h.store.list());
      const args = {
        id: ids[next(ids.length)],
        category: ['praise', 'urgent', 'spam'][next(3)],
        reply: ['Vielen Dank für Ihre Rückmeldung, wir haben sie an das ganze Team weitergegeben.', 'ok'][next(2)],
        rationale: 'fuzzed rationale for the gate',
        ...extras[next(extras.length)],
      };
      const out = await h.invoke(tools[next(tools.length)], args, 'agent');
      if (!out.ok) expect(JSON.stringify(h.store.list())).toBe(before);
      expect(h.store.list().some((r) => r.replyStatus === 'published')).toBe(false);
    }
  });

  test('the test would notice a missing gate: the same battery fails on an invoke() with the gate taken out', async () => {
    const base = harness();
    const open = {
      ...ownerVerbs.publish_reply,
      actors: ['agent', 'owner'],
      async handler(args, ctx) {
        const published = ctx.store.publish(args.id);
        return { result: { id: published.id, replyStatus: published.replyStatus }, summary: 'published' };
      },
    };
    const broken = createInvoke({
      store: base.store,
      provider: base.provider,
      tools: { ...agentTools, publish_reply: open },
    });
    await expect(assertGateHolds({ ...broken, store: base.store, provider: base.provider })).rejects.toThrow(/got "publish_reply" through/);
  });
});

describe('what the owner can do, one review at a time', () => {
  test('publish_reply publishes the draft, clears it, and is the only way to published', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    const draft = store.get('rev_002');
    const out = await invoke('publish_reply', { id: 'rev_002', draftVersion: draft.draftVersion }, 'owner');
    expect(out).toMatchObject({ ok: true, result: { id: 'rev_002', replyStatus: 'published' } });
    const after = store.get('rev_002');
    expect(after).toMatchObject({ replyStatus: 'published', publishedReply: draft.draftReply, draftReply: null, draftCategory: null, draftRationale: null });
    expect(after.publishedAt).toEqual(expect.any(String));
    expect(store.list().filter((r) => r.replyStatus === 'published')).toHaveLength(1);
  });

  test('works on a single review per call: a list of ids is refused', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    for (const args of [{ ids: ['rev_001', 'rev_002'] }, { id: ['rev_001', 'rev_002'] }, { id: 'all' }, { id: '*' }]) {
      expect((await invoke('publish_reply', args, 'owner')).ok).toBe(false);
    }
    expect(store.list().some((r) => r.replyStatus === 'published')).toBe(false);
  });

  test('refuses to publish when no draft is waiting', async () => {
    const { invoke } = harness();
    expect(await invoke('publish_reply', { id: 'rev_001' }, 'owner')).toMatchObject({ ok: false, error: { code: 'no_draft' } });
    expect(await invoke('publish_reply', { id: 'rev_999' }, 'owner')).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  test('refuses to publish a draft that changed after the owner read it', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    const readVersion = store.get('rev_001').draftVersion;
    await invoke(
      'draft_reply',
      { id: 'rev_001', category: 'complaint', reply: 'Guten Tag und danke für Ihre Nachricht, wir sind der Sache nachgegangen und bitten um Entschuldigung.', rationale: 'A newer draft arrived.' },
      'agent',
    );
    const out = await invoke('publish_reply', { id: 'rev_001', draftVersion: readVersion }, 'owner');
    expect(out).toMatchObject({ ok: false, error: { code: 'stale_draft' } });
    expect(store.get('rev_001').replyStatus).toBe('drafted');
  });

  test('a published review cannot be published or rejected again', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    await invoke('publish_reply', { id: 'rev_003' }, 'owner');
    expect((await invoke('publish_reply', { id: 'rev_003' }, 'owner')).error.code).toBe('no_draft');
    expect((await invoke('reject_reply', { id: 'rev_003', reason: 'too late' }, 'owner')).error.code).toBe('no_draft');
    expect(store.get('rev_003').replyStatus).toBe('published');
  });

  test('reject_reply clears the draft, keeps the reason, publishes nothing, and allows a new draft', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    const out = await invoke('reject_reply', { id: 'rev_001', reason: 'Too apologetic for a cold breakfast' }, 'owner');
    expect(out).toMatchObject({ ok: true, result: { replyStatus: 'rejected' } });
    expect(store.get('rev_001')).toMatchObject({ replyStatus: 'rejected', draftReply: null, publishedReply: null, rejectionReason: 'Too apologetic for a cold breakfast' });
    const entry = store.log().at(-1);
    expect(entry).toMatchObject({ actor: 'owner', tool: 'reject_reply', result: 'rejected' });
    expect(entry.args.reason).toBe('Too apologetic for a cold breakfast');

    const again = await provider.draftReply(store.get('rev_001'));
    const redraft = await invoke('draft_reply', { id: 'rev_001', category: 'complaint', reply: again.reply, rationale: again.rationale }, 'agent');
    expect(redraft.ok).toBe(true);
    expect(store.get('rev_001')).toMatchObject({ replyStatus: 'drafted', rejectionReason: null });
  });

  test('reject_reply needs a reason', async () => {
    const { invoke, store, provider } = harness();
    await triageAndDraftAll({ invoke, store, provider });
    expect((await invoke('reject_reply', { id: 'rev_001' }, 'owner')).error.code).toBe('invalid_arguments');
    expect((await invoke('reject_reply', { id: 'rev_001', reason: ' ' }, 'owner')).error.code).toBe('invalid_arguments');
  });
});

describe('defence in depth', () => {
  test('each owner verb checks the actor itself, even if invoke() were to hand it to the wrong one', async () => {
    const { store } = harness();
    await expect(ownerVerbs.publish_reply.handler({ id: 'rev_001' }, { store, actor: 'agent' })).rejects.toMatchObject({ code: 'forbidden_actor' });
    await expect(ownerVerbs.reject_reply.handler({ id: 'rev_001', reason: 'x y z' }, { store, actor: 'agent' })).rejects.toMatchObject({ code: 'forbidden_actor' });
  });

  test('the store itself will not publish without a draft', () => {
    const { store } = harness();
    expect(() => store.publish('rev_001')).toThrow(/no draft/);
  });
});
