'use strict';

// Evaluation harness: runs the app's own pipeline (triage, then draft, through invoke() as the
// actor "agent") over a labelled set of fictional reviews with ANY provider, and measures what
// came out. Usage: node scripts/eval.js [--fake] [--set FILE] [--out FILE] [--limit N] [--force]
//
// The provider is chosen exactly as the app chooses it: from LLM_NAME, LLM_BASE_URL and
// LLM_API_KEY (or ENV_FILE=<path>), or the offline fixture provider when none is set (or with
// --fake). Every result file records which provider produced it, so a fixture result can never
// be mistaken for a model result. Inside a container (`make eval-docker`) a loopback LLM_BASE_URL
// is pointed at the host the same way the app does it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { loadConfig, detectContainer, rewriteNotice } = require('../src/config');
const { createProvider } = require('../src/providers');
const { createStore, CATEGORIES } = require('../src/store');
const { createInvoke } = require('../src/invoke');
const { runAgent } = require('../src/agent');
const { detectLanguage } = require('../src/language');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SET = path.join(ROOT, 'data', 'eval-set.json');
const DEFAULT_OUT = path.join(ROOT, 'data', 'eval-results.json');
const LANGUAGES = ['de', 'fr', 'it', 'en', 'und'];
const REPLY_LANGUAGES = ['de', 'fr', 'it', 'en'];

function loadEvalSet(file = DEFAULT_SET) {
  const raw = fs.readFileSync(file);
  const items = JSON.parse(raw.toString('utf8')).items;
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${file} has no items`);
  const seen = new Set();
  for (const item of items) {
    if (!item.id || seen.has(item.id)) throw new Error(`duplicate or missing id in the evaluation set: ${item.id}`);
    seen.add(item.id);
    if (!CATEGORIES.includes(item.goldCategory)) throw new Error(`${item.id}: goldCategory must be one of ${CATEGORIES.join(', ')}`);
    if (!LANGUAGES.includes(item.goldLanguage)) throw new Error(`${item.id}: goldLanguage must be one of ${LANGUAGES.join(', ')}`);
    if (typeof item.originalText !== 'string' || !Number.isInteger(item.rating)) {
      throw new Error(`${item.id}: needs originalText and an integer rating`);
    }
  }
  return { items, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function ratio(part, whole) {
  return whole === 0 ? null : round(part / whole);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function latencyStats(values) {
  if (values.length === 0) return { calls: 0, meanMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    calls: sorted.length,
    meanMs: round(mean, 1),
    p50Ms: round(percentile(sorted, 50), 1),
    p95Ms: round(percentile(sorted, 95), 1),
    maxMs: round(sorted[sorted.length - 1], 1),
  };
}

// Wraps a provider so every call is timed and its raw answer kept, without changing what the
// app sees. The app under test gets exactly the answers (and errors) the inner provider gave.
function recordingProvider(inner, scrub) {
  const calls = [];
  async function timed(op, review, run) {
    const started = performance.now();
    try {
      const result = await run();
      calls.push({ id: review.id, op, ms: performance.now() - started, ok: true, result });
      return result;
    } catch (error) {
      calls.push({ id: review.id, op, ms: performance.now() - started, ok: false, error: scrub(String(error.message)).slice(0, 300) });
      throw error;
    }
  }
  return {
    calls,
    describe: () => inner.describe(),
    classify: (review) => timed('classify', review, () => inner.classify(review)),
    draftReply: (review) => timed('draft', review, () => inner.draftReply(review)),
  };
}

function lastCall(calls, id, op) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    if (calls[i].id === id && calls[i].op === op) return calls[i];
  }
  return null;
}

function buildItemResults(items, store, calls, log) {
  const byId = new Map(store.list().map((review) => [review.id, review]));
  return items.map((item) => {
    const review = byId.get(item.id);
    const classify = lastCall(calls, item.id, 'classify');
    const draft = lastCall(calls, item.id, 'draft');
    const triaged = review.triagedAt !== null;
    const gate = [...log].reverse().find((entry) => entry.tool === 'draft_reply' && entry.args && entry.args.id === item.id);

    const result = {
      id: item.id,
      tags: item.tags || [],
      goldCategory: item.goldCategory,
      goldLanguage: item.goldLanguage,
      triaged,
      modelLanguage: classify && classify.ok ? classify.result.language : null,
      modelCategory: classify && classify.ok ? classify.result.category : null,
      language: triaged ? review.detectedLanguage : null,
      category: triaged ? review.triageCategory : null,
      categoryCorrect: triaged && review.triageCategory === item.goldCategory,
      languageCorrect: triaged && review.detectedLanguage === item.goldLanguage,
      modelLanguageCorrect: Boolean(classify && classify.ok && classify.result.language === item.goldLanguage),
      classifyAttempts: classify && classify.ok ? classify.result.attempts || 1 : null,
      classifyMs: classify ? round(classify.ms, 1) : null,
      classifyError: classify && !classify.ok ? classify.error : null,
      draft: null,
    };

    if (draft && draft.ok) {
      const read = detectLanguage(draft.result.reply).language;
      result.draft = {
        reply: draft.result.reply,
        rationale: draft.result.rationale,
        attempts: draft.result.attempts || 1,
        ms: round(draft.ms, 1),
        replyLanguageRead: read,
        inGoldLanguage: REPLY_LANGUAGES.includes(item.goldLanguage) ? read === item.goldLanguage : null,
        savedByGate: review.replyStatus === 'drafted' && review.draftReply !== null,
        gateRefusal: gate && gate.outcome === 'refused' ? gate.error.code : null,
      };
    } else if (draft) {
      result.draft = { error: draft.error, ms: round(draft.ms, 1) };
    }
    return result;
  });
}

function computeMetrics(results, calls, wallMs, kind = 'openai-compatible') {
  const n = results.length;
  const count = (predicate) => results.filter(predicate).length;
  const gold = (category) => results.filter((r) => r.goldCategory === category);

  const urgentGold = gold('urgent');
  const confusion = {};
  for (const category of CATEGORIES) {
    confusion[category] = Object.fromEntries([...CATEGORIES, 'not_triaged'].map((c) => [c, 0]));
  }
  for (const r of results) confusion[r.goldCategory][r.triaged ? r.category : 'not_triaged'] += 1;

  const perLanguage = {};
  for (const language of LANGUAGES) {
    const subset = results.filter((r) => r.goldLanguage === language);
    if (subset.length === 0) continue;
    perLanguage[language] = {
      items: subset.length,
      categoryAccuracy: ratio(subset.filter((r) => r.categoryCorrect).length, subset.length),
      languageAccuracy: ratio(subset.filter((r) => r.languageCorrect).length, subset.length),
    };
  }

  const produced = results.filter((r) => r.draft && !r.draft.error);
  const judged = produced.filter((r) => r.draft.inGoldLanguage !== null);
  const refusals = {};
  for (const r of produced) {
    if (r.draft.gateRefusal) refusals[r.draft.gateRefusal] = (refusals[r.draft.gateRefusal] || 0) + 1;
  }
  const injection = results.filter((r) => r.tags.includes('prompt-injection'));
  const classifyMs = calls.filter((c) => c.op === 'classify').map((c) => c.ms);
  const draftMs = calls.filter((c) => c.op === 'draft').map((c) => c.ms);

  return {
    items: n,
    categoryAccuracy: ratio(count((r) => r.categoryCorrect), n),
    languageAccuracy: ratio(count((r) => r.languageCorrect), n),
    modelLanguageAccuracy: ratio(count((r) => r.modelLanguageCorrect), n),
    urgent: {
      gold: urgentGold.length,
      caught: urgentGold.filter((r) => r.category === 'urgent').length,
      recall: ratio(urgentGold.filter((r) => r.category === 'urgent').length, urgentGold.length),
      falseAlarms: results.filter((r) => r.goldCategory !== 'urgent' && r.category === 'urgent').length,
    },
    promptInjection: { items: injection.length, categoryCorrect: injection.filter((r) => r.categoryCorrect).length },
    triageFailures: count((r) => !r.triaged),
    confusion,
    perLanguage,
    reply: {
      producedByProvider: produced.length,
      providerFailures: count((r) => r.draft && r.draft.error),
      languageCompliance: ratio(judged.filter((r) => r.draft.inGoldLanguage).length, judged.length),
      languageCompliantCount: judged.filter((r) => r.draft.inGoldLanguage).length,
      languageJudged: judged.length,
      savedByGate: produced.filter((r) => r.draft.savedByGate).length,
      refusedByGate: refusals,
      leftForOwnerLanguageUnconfirmed: count((r) => r.triaged && r.language === 'und'),
    },
    retries: {
      classifyRetried: count((r) => r.classifyAttempts > 1),
      draftRetried: count((r) => r.draft && r.draft.attempts > 1),
    },
    latency: {
      ...(kind === 'fake' ? { note: 'Fixture provider: these timings are of canned lookups, not of a model.' } : {}),
      classify: latencyStats(classifyMs),
      draft: latencyStats(draftMs),
      wallMs: round(wallMs, 1),
      reviewsPerMinute: kind !== 'fake' && wallMs > 0 ? round((n / wallMs) * 60000, 1) : null,
    },
  };
}

function labelFor(about) {
  if (about.kind === 'fake') {
    return 'FIXTURE PROVIDER RESULT. Produced by the offline fixture provider (canned output, no model). This is NOT an Apertus result.';
  }
  if (about.apertus) {
    return 'Produced by the endpoint and model name in provenance. The model name is as configured: a client cannot verify what a remote server really runs.';
  }
  return 'Produced by a model whose configured name does not say Apertus. This is NOT an Apertus result.';
}

/**
 * Runs the pipeline over `items` with `provider`. Returns the result document, or throws if
 * the provider failed on every review (nothing worth recording).
 */
async function runEval({ provider, items, setInfo = {}, secrets = [], now = () => new Date() }) {
  const scrub = (text) => secrets.filter(Boolean).reduce((clean, secret) => clean.replaceAll(secret, '[redacted]'), text);
  const recorder = recordingProvider(provider, scrub);
  const store = createStore({ seed: items });
  const { invoke } = createInvoke({ store, provider: recorder });

  const started = performance.now();
  const summary = await runAgent({ invoke, provider: recorder });
  const wallMs = performance.now() - started;
  if (summary.error) throw new Error(`the provider failed on every review: ${scrub(summary.error.message)}`);

  const results = buildItemResults(items, store, recorder.calls, store.log());
  const about = provider.describe();
  return {
    schemaVersion: 1,
    label: labelFor(about),
    provenance: {
      providerKind: about.kind,
      model: about.model,
      endpointHost: about.endpointHost,
      modelNameSaysApertus: about.apertus,
      date: now().toISOString(),
      evalSet: { file: setInfo.file || 'data/eval-set.json', items: items.length, sha256: setInfo.sha256 || null },
      node: process.version,
      command: 'npm run eval',
    },
    metrics: computeMetrics(results, recorder.calls, wallMs, about.kind),
    items: results,
  };
}

function parseArgs(argv) {
  const options = { fake: false, force: false, set: DEFAULT_SET, out: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fake') options.fake = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--set') options.set = path.resolve(argv[(i += 1)]);
    else if (arg === '--out') options.out = path.resolve(argv[(i += 1)]);
    else if (arg === '--limit') options.limit = Number(argv[(i += 1)]);
    else throw new Error(`unknown option "${arg}"`);
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }
  if (options.limit !== null && !options.out) {
    throw new Error('--limit runs on a subset, so it needs --out: a partial run must not replace data/eval-results.json');
  }
  return options;
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function summarise(doc) {
  const m = doc.metrics;
  const p = doc.provenance;
  return [
    doc.label,
    `provider: ${p.providerKind} | model: ${p.model} | endpoint host: ${p.endpointHost || 'none (offline)'} | date: ${p.date}`,
    `items: ${m.items} (${p.evalSet.file}, sha256 ${String(p.evalSet.sha256).slice(0, 12)})`,
    `category accuracy:        ${percent(m.categoryAccuracy)}`,
    `language accuracy:        ${percent(m.languageAccuracy)} after the server's own check (the model alone: ${percent(m.modelLanguageAccuracy)})`,
    `urgent recall:            ${percent(m.urgent.recall)} (${m.urgent.caught} of ${m.urgent.gold}; ${m.urgent.falseAlarms} false alarms)`,
    `reply-language compliance: ${percent(m.reply.languageCompliance)} (${m.reply.languageCompliantCount} of ${m.reply.languageJudged} replies)`,
    `drafts saved by draft_reply: ${m.reply.savedByGate} of ${m.reply.producedByProvider} produced; refused: ${JSON.stringify(m.reply.refusedByGate)}`,
    m.latency.note
      ? `latency: ${m.latency.note}`
      : `latency per call: classify mean ${m.latency.classify.meanMs} ms, p95 ${m.latency.classify.p95Ms} ms; draft mean ${m.latency.draft.meanMs} ms, p95 ${m.latency.draft.p95Ms} ms`,
    `wall clock: ${m.latency.wallMs} ms${m.latency.reviewsPerMinute === null ? '' : ` (${m.latency.reviewsPerMinute} reviews per minute, one at a time)`}`,
  ].join('\n');
}

function guardAgainstClobber(out, doc, force) {
  if (force || !fs.existsSync(out)) return;
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    return;
  }
  const real = existing.provenance && existing.provenance.providerKind !== 'fake';
  if (real && doc.provenance.providerKind === 'fake') {
    throw new Error(
      `${path.relative(process.cwd(), out)} holds a result from ${existing.provenance.model} at ${existing.provenance.endpointHost}; a fixture run will not overwrite it. Pass --out for another file, or --force.`,
    );
  }
}

// The configuration exactly as the app reads it: --fake ignores every LLM_* variable.
function configFor(options, env, inContainer = detectContainer(env)) {
  return loadConfig(options.fake ? {} : env, { inContainer });
}

async function main(argv = process.argv.slice(2), env = process.env, { inContainer = detectContainer(env) } = {}) {
  const options = parseArgs(argv);
  const config = configFor(options, env, inContainer);
  if (config.llm && config.llm.rewrittenFrom) console.log(rewriteNotice(config.llm.rewrittenFrom));
  const provider = createProvider(config);
  const { items: all, sha256 } = loadEvalSet(options.set);
  const items = options.limit ? all.slice(0, options.limit) : all;
  const setFile = path.relative(ROOT, options.set) || 'data/eval-set.json';

  const doc = await runEval({
    provider,
    items,
    setInfo: { file: setFile, sha256 },
    secrets: config.llm ? [config.llm.apiKey] : [],
  });
  const out = options.out || DEFAULT_OUT;
  guardAgainstClobber(out, doc, options.force);
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(summarise(doc));
  const relative = path.relative(process.cwd(), out);
  console.log(`wrote ${relative.startsWith('..') ? out : relative}`);
  return doc;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`eval failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { loadEvalSet, runEval, computeMetrics, parseArgs, summarise, configFor, main, DEFAULT_OUT, DEFAULT_SET };
