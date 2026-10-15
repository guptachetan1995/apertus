'use strict';

const { createStore } = require('../src/store');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');
const { createInvoke } = require('../src/invoke');

// A clock that moves one second per call, so timestamps are distinct and predictable.
function steppingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++)).toISOString();
}

function harness({ provider = new FakeApertusProvider(), invokeOptions = {}, seed } = {}) {
  const store = createStore({ now: steppingClock(), ...(seed ? { seed } : {}) });
  const chokepoint = createInvoke({ store, provider, ...invokeOptions });
  return { store, provider, ...chokepoint };
}

// Runs the agent's first two steps by hand: triage, then a draft for every review.
async function triageAndDraftAll({ invoke, store, provider }) {
  await invoke('triage_reviews', {}, 'agent');
  for (const review of store.list()) {
    const draft = await provider.draftReply(review);
    const outcome = await invoke(
      'draft_reply',
      { id: review.id, category: review.triageCategory, reply: draft.reply, rationale: draft.rationale },
      'agent',
    );
    if (!outcome.ok) throw new Error(`setup draft for ${review.id} refused: ${outcome.error.message}`);
  }
}

module.exports = { harness, steppingClock, triageAndDraftAll };
