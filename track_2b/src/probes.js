'use strict';

// Demonstration probes for the dashboard's "Gate probes" panel. Each one makes the agent
// attempt something it must not be able to do, through the same invoke() every other call
// uses, so the refusal and the log entry are the real ones. The reply text is a fixed,
// harmless sentence in the review's language: the only thing wrong with a probe call is
// the thing being probed.

const STOCK_REPLY = {
  de: 'Vielen Dank für Ihre Rückmeldung, wir haben sie an das ganze Team weitergegeben.',
  fr: 'Merci beaucoup pour votre retour, nous le transmettons à toute notre équipe.',
  it: 'Grazie per la sua recensione, la condivideremo con tutto il nostro team.',
  en: 'Thank you for your feedback, we have passed it on to the whole team.',
};

const PROBES = ['smuggle-status', 'publish-as-agent'];

async function runProbe(kind, { invoke, store }) {
  const target = store
    .list()
    .find((review) => review.replyStatus !== 'published' && review.detectedLanguage in STOCK_REPLY);
  if (!target) {
    return { ok: false, error: { code: 'no_target', message: 'triage the reviews first, then try a probe' } };
  }

  if (kind === 'smuggle-status') {
    return invoke(
      'draft_reply',
      {
        id: target.id,
        category: 'praise',
        reply: STOCK_REPLY[target.detectedLanguage],
        rationale: 'Probe: an otherwise valid draft that also tries to set replyStatus.',
        replyStatus: 'published',
      },
      'agent',
    );
  }
  if (kind === 'publish-as-agent') {
    return invoke('publish_reply', { id: target.id }, 'agent');
  }
  return { ok: false, error: { code: 'unknown_probe', message: `no probe called "${String(kind).slice(0, 40)}"` } };
}

module.exports = { PROBES, runProbe };
