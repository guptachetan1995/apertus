'use strict';

const { triageAndDraftAll } = require('./helpers');

// The approval gate, stated as one reusable check: whatever the agent tries, no review ends
// up published and nothing about a public reply changes. It runs against the real chokepoint
// in approval-gate.test.js, and against a deliberately broken one to prove the check itself
// would notice a missing gate.
async function assertGateHolds({ invoke, store, provider }) {
  await triageAndDraftAll({ invoke, store, provider });
  const before = JSON.stringify(store.list());

  const attempts = [
    ['publish_reply', (id) => ({ id })],
    ['publish_reply', (id, v) => ({ id, draftVersion: v })],
    ['reject_reply', (id) => ({ id, reason: 'agent changed its mind' })],
    ['PUBLISH_REPLY', (id) => ({ id })],
    [' publish_reply', (id) => ({ id })],
    ['draft_reply', (id, v, review) => ({ id, category: 'praise', reply: review.draftReply, rationale: 'a valid draft except for one field', replyStatus: 'published' })],
    ['draft_reply', (id, v, review) => ({ id, category: 'praise', reply: review.draftReply, rationale: 'a valid draft except for one field', publishedReply: 'x' })],
  ];

  for (const review of store.list()) {
    for (const [tool, makeArgs] of attempts) {
      const outcome = await invoke(tool, makeArgs(review.id, review.draftVersion, review), 'agent');
      if (outcome.ok) throw new Error(`the agent got "${tool}" through on ${review.id}`);
    }
  }

  const after = store.list();
  if (after.some((review) => review.replyStatus === 'published' || review.publishedReply !== null)) {
    throw new Error('a review was published without the owner');
  }
  if (JSON.stringify(after) !== before) {
    throw new Error('a refused agent call still changed a review');
  }
}

module.exports = { assertGateHolds };
