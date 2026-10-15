'use strict';

const PRIORITY = { urgent: 0, complaint: 1, praise: 2 };

/**
 * The built-in agent: one pass over the inbox through invoke(), as the actor "agent".
 *
 *   1. triage_reviews: language and category for everything not yet triaged.
 *   2. For every triaged review still waiting for a reply, urgent first, ask the provider
 *      for a draft and save it with draft_reply.
 *
 * It holds no special access. Everything it does is a tool call the dashboard or an external
 * agent client could make, and it has no way to publish: publish_reply is not a tool it can
 * name. Drafts the server refuses are reported, not retried or forced.
 */
async function runAgent({ invoke, provider }) {
  const triage = await invoke('triage_reviews', {}, 'agent');
  if (!triage.ok) {
    return { triaged: 0, drafted: 0, skipped: [], refused: [], error: triage.error };
  }

  const listed = await invoke('list_reviews', {}, 'agent');
  const waiting = listed.result.reviews
    .filter(
      (review) =>
        review.triagedAt !== null && ['unreviewed', 'rejected'].includes(review.replyStatus),
    )
    .sort((a, b) => PRIORITY[a.triageCategory] - PRIORITY[b.triageCategory]);

  const skipped = [];
  const refused = [];
  let drafted = 0;

  for (const review of waiting) {
    if (review.detectedLanguage === 'und') {
      skipped.push({ id: review.id, reason: 'language not confirmed; the owner answers this one' });
      continue;
    }
    let draft;
    try {
      draft = await provider.draftReply(review);
    } catch (error) {
      skipped.push({ id: review.id, reason: `no draft from the provider: ${String(error.message).slice(0, 200)}` });
      continue;
    }
    const outcome = await invoke(
      'draft_reply',
      {
        id: review.id,
        category: review.triageCategory,
        reply: draft.reply,
        rationale: draft.rationale,
      },
      'agent',
    );
    if (outcome.ok) drafted += 1;
    else refused.push({ id: review.id, code: outcome.error.code, message: outcome.error.message });
  }

  return { triaged: triage.result.triaged.length, drafted, skipped, refused, error: null };
}

module.exports = { runAgent };
