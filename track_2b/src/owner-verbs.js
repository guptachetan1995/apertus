'use strict';

const { Refusal } = require('./errors');

// The two verbs that change what the public sees. They live apart from tools.js on purpose:
// the agent's registry is built from tools.js alone, so these are never registered as agent
// tools. invoke() resolves them only for the owner, and each handler checks the actor again
// so a mistake in one place cannot open the other.

function requireOwner(actor, verb) {
  if (actor !== 'owner') {
    throw new Refusal('forbidden_actor', `"${verb}" can only be done by the business owner`);
  }
}

const publishReply = {
  name: 'publish_reply',
  description:
    "Publishes the current draft reply of ONE review as the business's public reply, and marks that review published. Owner only: it is never offered to an agent. " +
    'In this prototype that records the reply in the app\'s own in-memory state; it does not post anything to Google or any other review platform. ' +
    'Pass the review id, and the draftVersion you read so that it is exactly that text which is recorded; if the draft has changed since, it refuses. ' +
    'It works on a single review per call, only when a draft is waiting, and cannot be undone from here.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 64 },
      draftVersion: { type: 'integer', minimum: 1 },
    },
    required: ['id'],
    additionalProperties: false,
  },
  actors: ['owner'],
  async handler(args, { store, actor }) {
    requireOwner(actor, 'publish_reply');
    const published = store.publish(args.id, { draftVersion: args.draftVersion });
    return {
      result: { id: published.id, replyStatus: published.replyStatus, publishedAt: published.publishedAt },
      summary: 'published',
    };
  },
};

const rejectReply = {
  name: 'reject_reply',
  description:
    'Throws away the current draft reply of ONE review and records why. Owner only: it is never offered to an agent. ' +
    'The review is marked rejected and can be drafted again; nothing is published and the reason is kept in the activity log. It works only when a draft is waiting.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 64 },
      reason: { type: 'string', minLength: 3, maxLength: 300 },
    },
    required: ['id', 'reason'],
    additionalProperties: false,
  },
  actors: ['owner'],
  async handler(args, { store, actor }) {
    requireOwner(actor, 'reject_reply');
    const rejected = store.reject(args.id, args.reason.trim());
    return { result: { id: rejected.id, replyStatus: rejected.replyStatus }, summary: 'rejected' };
  },
};

const ownerVerbs = Object.freeze({
  publish_reply: publishReply,
  reject_reply: rejectReply,
});

module.exports = { ownerVerbs };
