'use strict';

// Keeps the documents in step with the recorded evaluation result and with the team name.
// Usage: node scripts/report-fill.js [--check] [--root DIR]
//
// The README, the technical report and the repository README carry blocks between
//   <!-- generated:NAME:start -->  and  <!-- generated:NAME:end -->
// that this script rewrites from data/eval-results.json (plus any data/eval-results-*.json) and
// from TEAM_NAME in src/config.js. With only the offline fixture's result on record, the blocks
// say "Not yet run against Apertus". With a result from a real endpoint they print its numbers,
// its provenance and a failure analysis listed from the per-review results. Nothing in them is
// written by hand: a sentence about quality appears only as a number or a list read from the
// results file. --check changes nothing and fails if any block is out of date.
//
// A document is found relative to --root (the track directory, default: this one): its own
// README.md and technical_report.md, and the repository README.md one level up.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TEAM_NAME, isLoopbackHost } = require('../src/config');

const DEFAULT_ROOT = path.join(__dirname, '..');
const MARKER = /<!-- generated:([a-z0-9-]+):start -->([\s\S]*?)<!-- generated:\1:end -->/g;
const TEAM_FORMAT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const KNOWN_GATEWAYS = { 'api.publicai.co': 'Public AI Gateway' };
const LIST_CAP = 8;

// What each document must carry. A missing block is an error, so a rewritten paragraph cannot
// quietly stop being kept up to date.
const DOCUMENTS = [
  { file: 'README.md', blocks: ['status', 'limits', 'evaluation-note', 'team-pdf'] },
  {
    file: 'technical_report.md',
    blocks: ['team', 'maturity', 'headline', 'gateway', 'deploy-status', 'model-status', 'where-ran', 'hypothesis', 'evaluation', 'fell-short', 'next-eval'],
  },
  { file: '../README.md', blocks: ['status-root'] },
];

const pct = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const day = (iso) => String(iso).slice(0, 10);
const fmtMs = (ms) => (ms === null || ms === undefined ? 'n/a' : `${Math.round(ms).toLocaleString('en-US')} ms`);
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const numWord = (count) => NUMBER_WORDS[count] || String(count);
const LANGUAGE_NAMES = { de: 'German', fr: 'French', it: 'Italian', en: 'English', und: 'undetermined' };
const words = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

function capped(ids, cap = LIST_CAP) {
  if (ids.length <= cap) return ids.join(', ');
  return `${ids.slice(0, cap).join(', ')} and ${ids.length - cap} more`;
}

function endpointKind(host) {
  if (!host) return 'none';
  const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '[$1]');
  const privateRange = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(name);
  const localName = name === 'host.docker.internal' || /\.(local|internal|lan)$/.test(name);
  return isLoopbackHost(name) || privateRange || localName ? 'local' : 'third-party';
}

function gatewayName(host) {
  return KNOWN_GATEWAYS[String(host).replace(/:\d+$/, '')] || null;
}

// --- reading the results --------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadResults(root) {
  const dir = path.join(root, 'data');
  const primary = readJson(path.join(dir, 'eval-results.json'));
  const extras = fs
    .readdirSync(dir)
    .filter((name) => /^eval-results-.+\.json$/.test(name))
    .sort()
    .map((name) => ({ name, doc: readJson(path.join(dir, name)) }));
  const all = [{ name: 'eval-results.json', doc: primary }, ...extras];
  const real = all.filter(({ doc }) => doc.provenance.providerKind !== 'fake');
  const setFile = path.join(dir, 'eval-set.json');
  if (fs.existsSync(setFile)) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(setFile)).digest('hex');
    for (const { name, doc } of real.length ? real : [all[0]]) {
      if (doc.provenance.evalSet.sha256 !== sha) {
        throw new Error(`data/${name} was produced on a different version of data/eval-set.json (its SHA-256 does not match)`);
      }
    }
  }
  return real.length ? { mode: 'real', docs: real.map((r) => r.doc).sort((a, b) => a.provenance.model.localeCompare(b.provenance.model)), fixture: primary } : { mode: 'fixture', docs: [primary], fixture: primary };
}

// --- wording shared by several blocks ---------------------------------------------------------

function runLabel(doc) {
  const p = doc.provenance;
  return `${p.model} via ${p.endpointHost} on ${day(p.date)}`;
}

function runsPhrase(docs) {
  return words(docs.map(runLabel));
}

function apertusNote(docs) {
  const unnamed = docs.filter((doc) => !doc.provenance.modelNameSaysApertus);
  return unnamed.length ? ` (the model name of ${words(unnamed.map((d) => `\`${d.provenance.model}\``))} does not say Apertus, so ${unnamed.length === 1 ? 'that run is' : 'those runs are'} not recorded as ${unnamed.length === 1 ? 'an' : ''} Apertus result${unnamed.length === 1 ? '' : 's'})` : '';
}

function hostKinds(docs) {
  const kinds = new Set(docs.map((d) => endpointKind(d.provenance.endpointHost)));
  return { thirdParty: kinds.has('third-party'), local: kinds.has('local') };
}

function hostsPhrase(docs) {
  return words([...new Set(docs.map((d) => {
    const host = d.provenance.endpointHost;
    const name = gatewayName(host);
    return name ? `\`${host}\` (${name})` : `\`${host}\``;
  }))]);
}

// --- the failure analysis, listed from the per-review results ---------------------------------

function analysisBullets(doc) {
  const items = doc.items;
  const m = doc.metrics;
  const bullets = [];
  const n = items.length;

  const wrongCategory = items.filter((r) => !r.categoryCorrect);
  if (wrongCategory.length === 0) {
    bullets.push('**Category:** every review was classified as labelled.');
  } else {
    const cells = [];
    for (const [gold, row] of Object.entries(m.confusion)) {
      for (const [said, count] of Object.entries(row)) {
        if (said === gold || count === 0) continue;
        const ids = items.filter((r) => r.goldCategory === gold && (r.triaged ? r.category : 'not_triaged') === said).map((r) => r.id);
        cells.push(`labelled ${gold}, classified ${said.replace('_', ' ')}: ${count} (${capped(ids)})`);
      }
    }
    bullets.push(`**Category:** ${wrongCategory.length} of ${n} wrong. ${cells.join('; ')}.`);
  }

  const urgent = items.filter((r) => r.goldCategory === 'urgent');
  const missed = urgent.filter((r) => r.category !== 'urgent');
  const falseAlarms = items.filter((r) => r.goldCategory !== 'urgent' && r.category === 'urgent');
  bullets.push(
    `**Urgent:** ${m.urgent.caught} of ${m.urgent.gold} caught.` +
      (missed.length ? ` Missed: ${capped(missed.map((r) => `${r.id} (${(r.tags || []).join(', ') || 'no tag'}; classified ${r.triaged ? r.category : 'not triaged'})`))}.` : '') +
      (falseAlarms.length ? ` Over-called as urgent: ${capped(falseAlarms.map((r) => `${r.id} (labelled ${r.goldCategory})`))}.` : ' No false alarms.'),
  );

  const labelWrong = items.filter((r) => r.triaged && r.modelLanguage !== null && r.modelLanguage !== r.goldLanguage);
  const stillWrong = items.filter((r) => !r.languageCorrect);
  const short = Object.entries(m.perLanguage)
    .filter(([, v]) => v.categoryAccuracy < m.categoryAccuracy || v.languageAccuracy < 1)
    .map(([language]) => language);
  bullets.push(
    `**Languages:** the model's own language label differed from the label on ${labelWrong.length} reviews` +
      (labelWrong.length ? ` (${capped(labelWrong.map((r) => `${r.id}: labelled ${r.goldLanguage}, said ${r.modelLanguage}`))})` : '') +
      `; after the server's own check ${stillWrong.length} differ` +
      (stillWrong.length ? ` (${capped(stillWrong.map((r) => `${r.id}: labelled ${r.goldLanguage}, read as ${r.language === null ? 'not triaged' : r.language}`))})` : '') +
      `. ${short.length ? `Short of the run's overall category accuracy or of a perfect language label: ${short.join(', ')} (figures above).` : 'No language fell short.'}`,
  );

  const produced = items.filter((r) => r.draft && !r.draft.error);
  const wrongReplyLanguage = produced.filter((r) => r.draft.inGoldLanguage === false);
  const failedDrafts = items.filter((r) => r.draft && r.draft.error);
  const refused = Object.entries(m.reply.refusedByGate);
  bullets.push(
    `**Replies:** ${m.reply.producedByProvider} produced; ${wrongReplyLanguage.length} of ${m.reply.languageJudged} judged were not in the review's language` +
      (wrongReplyLanguage.length ? ` (${capped(wrongReplyLanguage.map((r) => `${r.id}: read as ${r.draft.replyLanguageRead}`))})` : '') +
      `; ${failedDrafts.length} provider failures` +
      (failedDrafts.length ? ` (${capped(failedDrafts.map((r) => r.id))})` : '') +
      `; refused by \`draft_reply\`: ${refused.length ? refused.map(([code, count]) => `${code} ${count}`).join(', ') : 'none'}; ` +
      `${m.reply.leftForOwnerLanguageUnconfirmed} left for the owner because the language was not confirmed; retries: classify ${m.retries.classifyRetried}, draft ${m.retries.draftRetried}; reviews not triaged: ${m.triageFailures}.`,
  );

  const tagStats = {};
  for (const r of items) for (const tag of r.tags || []) {
    tagStats[tag] = tagStats[tag] || { n: 0, wrong: 0 };
    tagStats[tag].n += 1;
    if (!r.categoryCorrect) tagStats[tag].wrong += 1;
  }
  const hard = Object.entries(tagStats).filter(([, v]) => v.wrong > 0).sort((a, b) => b[1].wrong / b[1].n - a[1].wrong / a[1].n || a[0].localeCompare(b[0]));
  bullets.push(
    `**By kind of review:** ${hard.length ? hard.map(([tag, v]) => `${tag} ${v.wrong} of ${v.n} wrong`).join('; ') : 'no kind of review had a category error'}. ` +
      `Reviews carrying an instruction aimed at the model: ${m.promptInjection.categoryCorrect} of ${m.promptInjection.items} classified as labelled.`,
  );
  return bullets;
}

// --- the blocks -------------------------------------------------------------------------------

function fixtureEvaluation(doc) {
  const m = doc.metrics;
  const p = doc.provenance;
  const items = doc.items;
  const und = items.filter((r) => r.triaged && r.language === 'und');
  const undKinds = {};
  for (const r of und) {
    const kind = (r.tags && r.tags[0]) || 'untagged';
    undKinds[kind] = (undKinds[kind] || 0) + 1;
  }
  const romansh = items.filter((r) => (r.tags || []).includes('romansh'));
  const romanshRead = {};
  for (const r of romansh) {
    const read = r.triaged ? r.language : 'not triaged';
    romanshRead[read] = (romanshRead[read] || 0) + 1;
  }
  const romanshMisread = romansh.filter((r) => r.language !== 'und');
  const refused = Object.entries(m.reply.refusedByGate);
  return [
    '**Not yet run against Apertus.** `npm run eval` runs the app\'s own pipeline (triage, then draft,',
    'through `invoke()` as the agent) over the evaluation set with whichever provider the environment',
    'selects, and writes `data/eval-results.json` with provenance: provider kind, model name,',
    'endpoint host, date, the evaluation set\'s SHA-256. A fixture run will not overwrite a result that',
    'came from a real endpoint. Replies are checked by the server\'s own language detector, an',
    'instrument with limits (below), not an independent judge.',
    '',
    '| Setup | Category accuracy | Urgent recall | Language label | Reply in review\'s language | Latency |',
    '|---|---|---|---|---|---|',
    `| **Fixture provider**, ${m.items} reviews (a rating-and-keyword baseline, not a model; run ${day(p.date)} UTC) | ${pct(m.categoryAccuracy)} (${items.filter((r) => r.categoryCorrect).length} of ${m.items}) | ${pct(m.urgent.recall)} (${m.urgent.caught} of ${m.urgent.gold}), ${m.urgent.falseAlarms} false alarms | ${pct(m.languageAccuracy)} (${items.filter((r) => r.languageCorrect).length} of ${m.items}) | ${pct(m.reply.languageCompliance)} (${m.reply.languageCompliantCount} of ${m.reply.languageJudged} replies) | Not meaningful: canned lookups |`,
    '| Apertus 8B | Not yet run | Not yet run | Not yet run | Not yet run | Not yet run |',
    '| Apertus 70B | Not yet run | Not yet run | Not yet run | Not yet run | Not yet run |',
    '',
    'What the fixture result shows is about the set and the harness, not a model:',
    '',
    `- **The set is not trivially passable.** A baseline that reads the stars plus a short word list misses ${m.urgent.gold - m.urgent.caught} of ${m.urgent.gold} urgent reviews, so a model has room to do better or worse.`,
    `- **The language check has limits, and they are measured.** The server's own check leaves ${und.length} reviews (${words(Object.entries(undKinds).map(([kind, count]) => `${numWord(count)} ${kind} one${count === 1 ? '' : 's'}`)) || 'none'}) as "language not confirmed": these go to the owner, never to a draft. ${romansh.length ? `It misreads ${romanshMisread.length === romansh.length ? (romansh.length === 2 ? 'both' : `all ${numWord(romansh.length)}`) : `${numWord(romanshMisread.length)} of the ${numWord(romansh.length)}`} Romansh reviews (read as ${words(Object.keys(romanshRead).filter((k) => k !== 'und').map((k) => LANGUAGE_NAMES[k] || k))}).` : ''} It is a four-language stopword rule, and is declared as one.`,
    `- **Every draft went through the gate.** ${m.reply.savedByGate === m.reply.producedByProvider ? `All ${m.reply.savedByGate}` : `${m.reply.savedByGate} of ${m.reply.producedByProvider}`} replies the fixture produced were saved by \`draft_reply\` (${refused.length ? refused.map(([code, count]) => `${count} refused: ${code}`).join(', ') : 'none refused'}), which is the same check any real provider's replies must pass.`,
  ].join('\n');
}

function realEvaluation(docs) {
  const lines = [];
  const first = docs[0];
  lines.push(
    `**Run against ${runsPhrase(docs)}**${apertusNote(docs)}. \`npm run eval\` runs the app's own pipeline over the evaluation set with whichever provider the environment selects. Host and model name are as configured: the client cannot see what a remote server really runs. Replies are checked by the server's own language detector, not an independent judge.`,
    '',
    `Provenance: ${docs.map((d) => `model \`${d.provenance.model}\`, host \`${d.provenance.endpointHost}\`, date ${d.provenance.date.slice(0, 16)}Z, ${d.provenance.evalSet.items} reviews of \`${d.provenance.evalSet.file}\`, SHA-256 \`${d.provenance.evalSet.sha256}\``).join('; ')}.`,
    '',
    '| Model (endpoint, date) | Category accuracy | Urgent recall | Language label | Reply in review\'s language | Latency p50 / p95 per call |',
    '|---|---|---|---|---|---|',
  );
  for (const doc of docs) {
    const m = doc.metrics;
    const p = doc.provenance;
    lines.push(
      `| \`${p.model}\` (${p.endpointHost}, ${day(p.date)}) | ${pct(m.categoryAccuracy)} (${doc.items.filter((r) => r.categoryCorrect).length} of ${m.items}) | ${pct(m.urgent.recall)} (${m.urgent.caught} of ${m.urgent.gold}), ${m.urgent.falseAlarms} false alarms | ${pct(m.languageAccuracy)} (${doc.items.filter((r) => r.languageCorrect).length} of ${m.items}) | ${pct(m.reply.languageCompliance)} (${m.reply.languageCompliantCount} of ${m.reply.languageJudged} replies) | classify ${fmtMs(m.latency.classify.p50Ms)} / ${fmtMs(m.latency.classify.p95Ms)}; draft ${fmtMs(m.latency.draft.p50Ms)} / ${fmtMs(m.latency.draft.p95Ms)} |`,
    );
  }
  for (const [label, pattern] of [['Apertus 8B', /(^|[^0-9])8b/i], ['Apertus 70B', /(^|[^0-9])70b/i]]) {
    if (!docs.some((d) => pattern.test(d.provenance.model))) lines.push(`| ${label} | Not yet run | Not yet run | Not yet run | Not yet run | Not yet run |`);
  }
  lines.push('', '**Per language** (reviews, category accuracy, language label):', '');
  for (const doc of docs) {
    lines.push(`- \`${doc.provenance.model}\`: ${Object.entries(doc.metrics.perLanguage).map(([language, v]) => `${language} (${v.items}) ${pct(v.categoryAccuracy)}, ${pct(v.languageAccuracy)}`).join('; ')}.`);
  }
  lines.push('', '**Decision rule from section 3, applied to the recorded run(s):**', '');
  for (const doc of docs) {
    const m = doc.metrics;
    const allUrgent = m.urgent.caught === m.urgent.gold;
    const compliant = m.reply.languageCompliance !== null && m.reply.languageCompliance >= 0.95;
    const is8b = /(^|[^0-9])8b/i.test(doc.provenance.model);
    lines.push(
      `- \`${doc.provenance.model}\`: urgent ${m.urgent.caught} of ${m.urgent.gold} (the rule asks for all ${m.urgent.gold}): ${allUrgent ? 'met' : 'not met'}; reply in the review's language ${pct(m.reply.languageCompliance)} (the rule asks for at least 95%): ${compliant ? 'met' : 'not met'}.${is8b ? (allUrgent && compliant ? ' The rule says to stay on 8B.' : ' The rule calls for running 70B on the same set.') : ''}`,
    );
  }
  lines.push('', '### Failure analysis', '', 'Listed from the per-review results in `data/eval-results*.json`, not written by hand.', '');
  for (const doc of docs) {
    if (docs.length > 1) lines.push(`**${doc.provenance.model}**`, '');
    for (const bullet of analysisBullets(doc)) lines.push(`- ${bullet}`);
    lines.push('');
  }
  const n = first.metrics.items;
  lines.push(
    `**Caveats.** One annotator labelled the ${n} reviews, so one review moves a rate by about ${(100 / n).toFixed(1)} points; one run per model at temperature 0, so variance is not measured; the language check is a four-language stopword heuristic; the reviews are fictional.`,
  );
  return lines.join('\n');
}

function buildBlocks({ teamName, reportPdf, results }) {
  const { mode, docs, fixture } = results;
  const real = mode === 'real';
  const setItems = docs[0].provenance.evalSet.items;
  const runs = real ? runsPhrase(docs) : '';
  const kinds = real ? hostKinds(docs) : null;
  const numbers = real
    ? docs.map((d) => `${d.provenance.model}: category accuracy ${pct(d.metrics.categoryAccuracy)}, urgent recall ${pct(d.metrics.urgent.recall)} (${d.metrics.urgent.caught} of ${d.metrics.urgent.gold}), reply in the review's language ${pct(d.metrics.reply.languageCompliance)}`).join('; ')
    : '';
  const anyNamedApertus = real ? docs.some((d) => d.provenance.modelNameSaysApertus) : false;

  const blocks = {};
  blocks['team'] = `\`${teamName}\``;
  blocks['team-pdf'] = `\`${reportPdf}\``;

  blocks['status'] = real
    ? [
        `**Status: a proof of concept, built and tested, run against ${runs}${anyNamedApertus ? '' : ' (not recorded as an Apertus result)'}.** The core, the approval gate, the dashboard, a client for any OpenAI-compatible endpoint (tested against a local stub server) and an evaluation harness with a ${setItems}-review labelled set are in place. The recorded evaluation result${docs.length > 1 ? 's were' : ' was'} produced by ${runs}${apertusNote(docs)}: ${numbers}. The technical report's section 5 has the table, the provenance and the failure analysis. Every result records the model, endpoint host and date that produced it, and the dashboard says which provider is answering.`,
      ].join('\n')
    : [
        '**Status: a proof of concept, built and tested, not yet run against Apertus.** The core, the',
        'approval gate, the dashboard, a client for any OpenAI-compatible endpoint (tested against a local',
        `stub server) and an evaluation harness with a ${setItems}-review labelled set are in place. No result in`,
        'this repository has been produced by Apertus yet: the only evaluation result is the offline',
        'fixture\'s, and its file says so. Every result records the model, endpoint host and date that',
        'produced it, and the dashboard says which provider is answering.',
      ].join('\n');

  blocks['limits'] = real
    ? `- Evaluation results from ${runs} are recorded${apertusNote(docs)}: ${docs.length > 1 ? 'one run each' : 'one run'} on ${setItems} fictional reviews labelled by one person, with the failure analysis in the technical report's section 5. The client is also tested against a local stub server.`
    : [
        '- Nothing in this repository has been produced by Apertus yet. The client is tested against a',
        '  local stub server, and the evaluation harness is ready to run against a real endpoint.',
      ].join('\n');

  blocks['evaluation-note'] = real
    ? `The committed \`data/eval-results.json\`${docs.length > 1 ? ' and its siblings were' : ' was'} produced by ${runs}${apertusNote(docs)}. After a new run, \`npm run report:fill\` brings this README and the technical report in line with the results file.`
    : 'The committed `data/eval-results.json` is the fixture\'s. It is labelled as not an Apertus result,\nand it is not one.';

  blocks['status-root'] = real
    ? `One evaluation run${docs.length > 1 ? 's' : ''}, against ${runs}, ${docs.length > 1 ? 'are' : 'is'} recorded in \`track_2b/data/\` and the technical report${apertusNote(docs)}; the documents say what was and was not run.`
    : 'Nothing in this\nrepository has been produced by Apertus yet, and the documents say so.';

  // technical_report.md
  blocks['maturity'] = real
    ? `quality of ${docs.map((d) => d.provenance.model).join(' and ')} on classifications and replies has been measured once, on ${setItems} fictional reviews (section 5).`
    : 'quality of Apertus\'s classifications and replies has **not been measured yet** (section 5).';

  blocks['headline'] = real
    ? `Headline result: the whole loop runs on a client for any OpenAI-compatible chat endpoint (the three variables \`LLM_NAME\`, \`LLM_BASE_URL\`, \`LLM_API_KEY\`), tested against a local stub server, with a ${setItems}-review labelled evaluation set and a harness that records provenance with every result. Run against ${runs}${apertusNote(docs)}: ${numbers}. Section 5 has the table and where the run fell short.`
    : [
        'Headline result so far: the whole loop runs on a client for any OpenAI-compatible chat',
        'endpoint (the three variables `LLM_NAME`, `LLM_BASE_URL`, `LLM_API_KEY`), tested against a local',
        `stub server, with a ${setItems}-review labelled evaluation set and a harness that records provenance`,
        'with every result. **Not yet run against Apertus:** no number in this report was produced by',
        'Apertus, and the one result table (section 5) is the offline fixture provider\'s, labelled as',
        'such.',
      ].join('\n');

  if (!real) {
    blocks['gateway'] = 'If `LLM_BASE_URL` instead names a third-party gateway (the Public AI Gateway or CSCS, for\nexample), that host becomes an external service receiving every review\'s text and rating; this\nproject has not used one.';
    blocks['deploy-status'] = 'but no real Apertus server has been run, so neither the\non-premise nor the air-gapped deployment has been exercised end to end.**';
  } else {
    const gateway = 'If `LLM_BASE_URL` instead names a third-party gateway (the Public AI Gateway or CSCS, for\nexample), that host becomes an external service receiving every review\'s text and rating.';
    const used = [];
    if (kinds.thirdParty) {
      used.push(`**The evaluation run in section 5 used one: ${hostsPhrase(docs.filter((d) => endpointKind(d.provenance.endpointHost) === 'third-party'))}, a third-party gateway${docs.some((d) => gatewayName(d.provenance.endpointHost)) ? '' : ' (judged from the address)'}, which received the text and star rating of the ${setItems} fictional evaluation reviews.** No real customer data was sent. The declared on-premise deployment, where \`LLM_BASE_URL\` names a server inside the organisation, is not what produced that result.`);
    }
    if (kinds.local) used.push(`A recorded run used a server at ${hostsPhrase(docs.filter((d) => endpointKind(d.provenance.endpointHost) === 'local'))}, which is a local or private address (judged from the address alone), so no external service received review text in that run.`);
    blocks['gateway'] = `${gateway} ${used.join(' ')}`;
    blocks['deploy-status'] = kinds.thirdParty
      ? 'and the real evaluation run used a third-party gateway (section 5), so neither the\non-premise nor the air-gapped deployment has been exercised end to end.**'
      : 'and the real evaluation run used a server at a local or private address (section 5);\nair-gapped operation has not been checked separately.**';
  }

  blocks['model-status'] = real
    ? `**Run against ${runs}${anyNamedApertus ? '' : ' (the model name does not say Apertus)'}.**`
    : '**Not yet run against Apertus.**';

  blocks['where-ran'] = real
    ? `wherever \`LLM_BASE_URL\` names. The recorded run${docs.length > 1 ? 's' : ''}: ${runs} (${kinds.thirdParty ? 'a third-party gateway' : 'a local or private address'}); the fixture and a local stub were exercised before.`
    : 'wherever `LLM_BASE_URL` names. Only the fixture and a local stub have been\n  exercised.';

  blocks['hypothesis'] = real
    ? 'How the decision rule came out on the recorded run is in section 5.'
    : 'Whether 8B suffices is a hypothesis until that run exists.';

  blocks['evaluation'] = real ? realEvaluation(docs) : fixtureEvaluation(fixture);

  const sample = docs[0];
  blocks['fell-short'] = real
    ? `- **Where Apertus fell short:** the failure analysis in section 5 lists it from the recorded run${docs.length > 1 ? 's' : ''}, with ids. In short, ${docs.map((d) => `${d.provenance.model}: ${d.items.filter((r) => !r.categoryCorrect).length} category errors, ${d.metrics.urgent.gold - d.metrics.urgent.caught} urgent reviews missed, ${d.items.filter((r) => r.draft && r.draft.inGoldLanguage === false).length} replies not in the review's language, ${d.metrics.reply.providerFailures} provider failures`).join('; ')} (of ${sample.metrics.items} reviews).`
    : [
        '- **Where Apertus fell short: not yet known.** No Apertus endpoint has been run, so this report',
        '  cannot say. What it will look for, from the evaluation: urgent reviews missed or over-called,',
        '  replies in the wrong language (including Swiss German and code-switched input), invalid JSON,',
        '  and obeying instructions hidden in a review.',
      ].join('\n');

  const present = (pattern) => docs.some((d) => pattern.test(d.provenance.model));
  const both = present(/(^|[^0-9])8b/i) && present(/(^|[^0-9])70b/i);
  blocks['next-eval'] = real
    ? both
      ? '- Repeat the runs to see the variance, and measure latency and throughput on the intended hardware.'
      : '- Run the Apertus size not yet in the table (`npm run eval -- --out data/eval-results-<size>.json`; every such file is picked up by `npm run report:fill`), repeat runs to see the variance, and measure latency on the intended hardware.'
    : [
        '- Run `npm run eval` against Apertus 8B and 70B, record the results with their provenance, and',
        '  replace every "not yet run" in this report with what happened, including where Apertus fell short.',
      ].join('\n');

  return blocks;
}

// --- applying them ------------------------------------------------------------------------------

// Blocks that sit inside a sentence or a line are written as they are; the others stand on lines
// of their own between the markers.
const INLINE = new Set(['team', 'team-pdf', 'status-root', 'maturity', 'deploy-status', 'model-status', 'where-ran', 'hypothesis']);

// Long prose lines are wrapped at 100 columns like the hand-written text around them. Table rows
// and headings are left alone.
function wrapLine(line, width = 100) {
  if (line.length <= width || /^(\||#)/.test(line)) return line;
  const hang = ' '.repeat(/^(\s*(?:- )?)/.exec(line)[1].length);
  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      out.push(current);
      current = hang + word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  out.push(current);
  return out.join('\n');
}

function blockWrap(name, content) {
  return INLINE.has(name) ? content : `\n${content.split('\n').map((line) => wrapLine(line)).join('\n')}\n`;
}

function applyBlocks(text, blocks, expected, label) {
  const seen = new Set();
  const out = text.replace(MARKER, (_whole, name) => {
    if (!(name in blocks)) throw new Error(`${label}: unknown generated block "${name}"`);
    seen.add(name);
    return `<!-- generated:${name}:start -->${blockWrap(name, blocks[name])}<!-- generated:${name}:end -->`;
  });
  for (const name of expected) {
    if (!seen.has(name)) throw new Error(`${label}: the generated block "${name}" is missing`);
  }
  return out;
}

function checkTeamName(teamName) {
  if (!TEAM_FORMAT.test(teamName)) {
    throw new Error(`TEAM_NAME must be non-empty, start with a letter or digit and hold only letters, digits, "_" and "-" (no spaces): got "${teamName}"`);
  }
}

function run({ root = DEFAULT_ROOT, check = false, teamName = TEAM_NAME } = {}) {
  checkTeamName(teamName);
  const results = loadResults(root);
  const blocks = buildBlocks({ teamName, reportPdf: `${teamName}_Report.pdf`, results });
  const stale = [];
  for (const { file, blocks: expected } of DOCUMENTS) {
    const target = path.join(root, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = applyBlocks(before, blocks, expected, file);
    if (after !== before) {
      stale.push(file);
      if (!check) fs.writeFileSync(target, after);
    }
  }
  return { mode: results.mode, stale };
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--root') options.root = path.resolve(argv[(i += 1)]);
    else throw new Error(`unknown option "${argv[i]}"`);
  }
  const { mode, stale } = run(options);
  if (options.check) {
    if (stale.length) throw new Error(`${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} out of step with data/eval-results.json or TEAM_NAME; run: npm run report:fill`);
    console.log(`documents are in step with the results (${mode} mode)`);
  } else {
    console.log(`${stale.length ? `rewrote ${stale.join(', ')}` : 'nothing to change'} (${mode} mode)`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`report:fill failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { run, buildBlocks, applyBlocks, loadResults, endpointKind, checkTeamName, TEAM_FORMAT, DOCUMENTS };
