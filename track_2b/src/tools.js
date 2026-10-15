'use strict';

const { Refusal } = require('./errors');
const { CATEGORIES, REPLY_STATUSES } = require('./store');
const { SUPPORTED, detectLanguage } = require('./language');

// The agent's tool registry. This file is the whole of what an agent can do. The two
// verbs that change what the public sees, publish_reply and reject_reply, are in
// owner-verbs.js and are not in this registry, so no agent client can be shown them,
// select them, or reach them through this table.
//
// Descriptions are written for a reader who cannot see the screen: what the tool does, what
// it returns, and what it does NOT do.

const REPLY_LIMITS = Object.freeze({ minReply: 20, maxReply: 1200, minRationale: 10, maxRationale: 600 });
const MAX_RATIONALE = REPLY_LIMITS.maxRationale;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The model's language label and the server's own detector both get a say. If the model
// names a language outside the four the reply check understands, or the two disagree
// clearly, the review is left as "und" for the owner: the check that guards the reply
// language would otherwise be built on a label nobody has confirmed.
function reconcileLanguage(claimed, text) {
  const modelLanguage = SUPPORTED.includes(claimed) ? claimed : 'und';
  const local = detectLanguage(text).language;
  if (modelLanguage === local || local === 'und') return { language: modelLanguage, note: '' };
  return {
    language: 'und',
    note: ` Language check: the model read "${claimed}", the server's own check read "${local}"; left for the owner to handle.`,
  };
}

const PRIORITY = { urgent: 0, complaint: 1, praise: 2 };

const listReviews = {
  name: 'list_reviews',
  description:
    'Returns the customer reviews the business has received, in the order they arrived. Each one has its id, source, original text, star rating (1 to 5), the detected language (null until triaged), the triage category and reason, the reply status (unreviewed, drafted, rejected or published), and any current draft with its version number. ' +
    'Optionally pass replyStatus to see only reviews in that status. ' +
    'Read-only: it does not triage, translate, draft or publish anything, and it never changes a review.',
  inputSchema: {
    type: 'object',
    properties: { replyStatus: { type: 'string', enum: REPLY_STATUSES } },
    additionalProperties: false,
  },
  actors: ['agent', 'owner'],
  async handler(args, { store }) {
    const reviews = store.list(args);
    return { result: { reviews }, summary: `listed ${reviews.length}` };
  },
};

const triageReviews = {
  name: 'triage_reviews',
  description:
    "Reads every review that has not been triaged yet, works out which language it is written in, and sorts it as praise, complaint or urgent (a possible health, safety or legal problem), with a one-sentence reason in English that quotes the words that decided it. It records only the language, the category and the reason. Returns the reviews it handled, urgent ones first. " +
    'It does not write any reply, does not change a review\'s reply status, and never posts anything publicly. Reviews that were already triaged are left exactly as they are, so calling it again is safe. Takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  actors: ['agent', 'owner'],
  async handler(_args, { store, provider }) {
    const targets = store
      .list({ replyStatus: 'unreviewed' })
      .filter((review) => review.triagedAt === null);
    const triaged = [];
    const failed = [];
    for (const review of targets) {
      try {
        const found = await provider.classify(review);
        if (!CATEGORIES.includes(found.category) || typeof found.rationale !== 'string') {
          throw new Error('the provider returned a category or rationale in an unusable shape');
        }
        const { language, note } = reconcileLanguage(found.language, review.originalText);
        const applied = store.applyTriage(review.id, {
          language,
          category: found.category,
          rationale: truncate(found.rationale.trim() + note, MAX_RATIONALE),
          provider: provider.describe(),
        });
        if (applied) triaged.push({ id: review.id, language, category: found.category });
      } catch (error) {
        failed.push({ id: review.id, message: truncate(String(error.message), 200) });
      }
    }
    if (targets.length > 0 && triaged.length === 0 && failed.length === targets.length) {
      throw new Refusal('provider_error', `the provider failed on every review: ${failed[0].message}`);
    }
    triaged.sort((a, b) => PRIORITY[a.category] - PRIORITY[b.category]);
    return {
      result: { triaged, failed, provider: provider.describe() },
      summary: `triaged ${triaged.length}${failed.length ? `, ${failed.length} failed` : ''}`,
    };
  },
};

const draftReply = {
  name: 'draft_reply',
  description:
    'Saves a proposed public reply to one review so the owner can read it. Nothing is posted: the reply stays a draft until the owner decides, and you have no way to publish it. ' +
    'You supply the review id, a category (praise, complaint or urgent), the reply text, and a rationale in English for the owner saying what in the review led you to this reply. ' +
    "The reply must be written in the review's own language, as detected when it was triaged; the server checks this itself and refuses a reply that reads as a different language. " +
    'It refuses: an id that does not exist, a review that has not been triaged yet, a review that already has a published reply, an empty or over-long reply, and any argument other than those four. In particular it refuses replyStatus: you cannot set a review\'s status. ' +
    'Calling it again for the same review replaces the earlier draft.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 64 },
      category: { type: 'string', enum: CATEGORIES },
      reply: { type: 'string', minLength: REPLY_LIMITS.minReply, maxLength: REPLY_LIMITS.maxReply },
      rationale: { type: 'string', minLength: REPLY_LIMITS.minRationale, maxLength: REPLY_LIMITS.maxRationale },
    },
    required: ['id', 'category', 'reply', 'rationale'],
    additionalProperties: false,
    argumentHints: {
      replyStatus:
        'replyStatus is not an argument of draft_reply. A draft never changes whether a reply is public; only the owner can publish one.',
    },
  },
  actors: ['agent', 'owner'],
  async handler(args, { store }) {
    const review = store.get(args.id);
    if (review.replyStatus === 'published') {
      throw new Refusal('already_published', `review "${args.id}" already has a published reply`);
    }
    if (review.detectedLanguage === null) {
      throw new Refusal('not_triaged', `review "${args.id}" has not been triaged yet; run triage_reviews first`);
    }
    if (review.detectedLanguage === 'und') {
      throw new Refusal(
        'language_unsupported',
        `the language of review "${args.id}" could not be confirmed, so a reply cannot be checked; the owner has to answer this one`,
      );
    }
    const replyLanguage = detectLanguage(args.reply).language;
    if (replyLanguage !== review.detectedLanguage) {
      throw new Refusal(
        'wrong_language',
        `the review is in "${review.detectedLanguage}" but the reply reads as "${replyLanguage}"; write the reply in the review's own language`,
      );
    }
    const saved = store.writeDraft(args.id, {
      category: args.category,
      reply: args.reply.trim(),
      rationale: args.rationale.trim(),
    });
    return {
      result: { id: saved.id, replyStatus: saved.replyStatus, draftVersion: saved.draftVersion },
      summary: 'drafted',
    };
  },
};

const getReview = {
  name: 'get_review',
  description:
    'Returns everything recorded about one review by its id: the original text, star rating, source, when it arrived, the detected language, the triage category and reason, the reply status, the current draft (reply, category, rationale and version) if there is one, the owner\'s last rejection reason if the previous draft was rejected, and the published reply if there is one. ' +
    'Read-only: it does not translate the review, triage it or draft anything. It refuses an id that does not exist.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['id'],
    additionalProperties: false,
  },
  actors: ['agent', 'owner'],
  async handler(args, { store }) {
    return { result: { review: store.get(args.id) }, summary: 'read' };
  },
};

const agentTools = Object.freeze({
  list_reviews: listReviews,
  triage_reviews: triageReviews,
  draft_reply: draftReply,
  get_review: getReview,
});

module.exports = { agentTools, reconcileLanguage, REPLY_LIMITS };
