'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { loadEvalSet, runEval, computeMetrics, parseArgs, configFor, main, DEFAULT_SET } = require('../scripts/eval');
const { createProvider } = require('../src/providers');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');
const { OpenAICompatibleProvider } = require('../src/providers/openai-compatible-provider');
const { startStub, readRequest } = require('./stub-llm');
const fixtures = require('../data/fake-provider-fixtures.json');

const KEY = 'stub-secret-value-0123456789abcdef';
const { items, sha256 } = loadEvalSet();
const fixedNow = () => new Date('2026-10-07T09:00:00.000Z');

let stub;
afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  jest.restoreAllMocks();
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-eval-'));
}

async function realProvider(respond) {
  stub = await startStub(respond);
  return new OpenAICompatibleProvider({ name: 'swiss-ai/Apertus-v1.5-8B', baseUrl: stub.baseUrl, apiKey: KEY, timeoutMs: 2000, retryDelayMs: 0 });
}

// A model that always agrees with the gold labels.
function goldModel(request) {
  const { kind, text } = readRequest(request);
  const item = items.find((candidate) => candidate.originalText === text);
  if (kind === 'classify') {
    return JSON.stringify({ language: item.goldLanguage, category: item.goldCategory, rationale: 'Matches the gold label by construction.' });
  }
  const language = request.body.messages[0].content.match(/Write the reply in \w+ \((\w\w)\)/)[1];
  return JSON.stringify({ reply: fixtures.generic.replies[language][item.goldCategory], rationale: 'A stock reply in the right language.' });
}

describe('the evaluation set', () => {
  test('is a labelled set of at least 40 fictional reviews across de, fr, it and en', () => {
    expect(items.length).toBeGreaterThanOrEqual(40);
    for (const language of ['de', 'fr', 'it', 'en']) {
      expect(items.filter((i) => i.goldLanguage === language).length).toBeGreaterThanOrEqual(8);
    }
    for (const category of ['praise', 'complaint', 'urgent']) {
      expect(items.filter((i) => i.goldCategory === category).length).toBeGreaterThanOrEqual(10);
    }
  });

  test('includes Swiss German, Romansh, code-switched, short, mixed and injected reviews', () => {
    const tags = new Set(items.flatMap((i) => i.tags));
    for (const tag of ['swiss-german', 'romansh', 'code-switched', 'short', 'mixed', 'prompt-injection', 'rating-mismatch']) {
      expect(tags.has(tag)).toBe(true);
    }
    expect(items.filter((i) => i.tags.includes('romansh')).every((i) => i.goldLanguage === 'und')).toBe(true);
  });

  test('has unique ids, every field the pipeline needs, and no contact details', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.originalText.length).toBeGreaterThan(10);
      expect(item.rating).toBeGreaterThanOrEqual(1);
      expect(item.rating).toBeLessThanOrEqual(5);
      expect(item.originalText).not.toMatch(/@|https?:|\+\d|\d{4,}/);
    }
  });

  test('is hashed from its bytes, so a result names the exact set it ran on', () => {
    expect(sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(DEFAULT_SET)).digest('hex'));
  });

  test('is refused when a gold label is outside the label set', () => {
    const dir = tempDir();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'x', originalText: 'Gut.', rating: 5, goldCategory: 'neutral', goldLanguage: 'de' }] }));
    expect(() => loadEvalSet(file)).toThrow(/goldCategory/);
  });
});

describe('a run on the fixture provider', () => {
  let doc;
  beforeAll(async () => {
    doc = await runEval({ provider: new FakeApertusProvider(), items, setInfo: { file: 'data/eval-set.json', sha256 }, now: fixedNow });
  });

  test('records its provenance and says in its label that it is not an Apertus result', () => {
    expect(doc.provenance).toEqual({
      providerKind: 'fake',
      model: 'fixture provider (canned output, not a model)',
      endpointHost: null,
      modelNameSaysApertus: false,
      date: '2026-10-07T09:00:00.000Z',
      evalSet: { file: 'data/eval-set.json', items: items.length, sha256 },
      node: process.version,
      command: 'npm run eval',
    });
    expect(doc.label).toMatch(/FIXTURE PROVIDER RESULT/);
    expect(doc.label).toMatch(/NOT an Apertus result/);
    expect(doc.metrics.latency.note).toMatch(/not of a model/);
  });

  test('measures category accuracy, language accuracy, reply-language compliance and latency', () => {
    const m = doc.metrics;
    expect(m.items).toBe(items.length);
    expect(m.categoryAccuracy).toBeGreaterThan(0);
    expect(m.categoryAccuracy).toBeLessThan(1);
    expect(m.languageAccuracy).toBeGreaterThan(0.5);
    expect(m.reply.languageCompliance).toBe(1);
    expect(m.reply.producedByProvider).toBeGreaterThan(0);
    expect(m.latency.classify.calls).toBe(items.length);
    expect(m.latency.draft.calls).toBe(m.reply.producedByProvider);
    expect(m.latency.wallMs).toBeGreaterThan(0);
  });

  test('its numbers agree with its own per-item rows', () => {
    const correct = doc.items.filter((row) => row.categoryCorrect).length;
    expect(doc.metrics.categoryAccuracy).toBe(Math.round((correct / items.length) * 1000) / 1000);
    const urgent = doc.items.filter((row) => row.goldCategory === 'urgent');
    expect(doc.metrics.urgent.gold).toBe(urgent.length);
    expect(doc.metrics.urgent.caught).toBe(urgent.filter((row) => row.category === 'urgent').length);
    const confusionTotal = Object.values(doc.metrics.confusion).flatMap((row) => Object.values(row)).reduce((a, b) => a + b, 0);
    expect(confusionTotal).toBe(items.length);
  });

  test('runs through the same chokepoint: every draft the fixture produced was saved by draft_reply', () => {
    const produced = doc.items.filter((row) => row.draft && !row.draft.error);
    expect(produced.every((row) => row.draft.savedByGate && row.draft.gateRefusal === null)).toBe(true);
  });

  test('leaves a review whose language is not confirmed for the owner and drafts nothing for it', () => {
    const undetermined = doc.items.filter((row) => row.triaged && row.language === 'und');
    expect(undetermined.length).toBe(doc.metrics.reply.leftForOwnerLanguageUnconfirmed);
    expect(undetermined.every((row) => row.draft === null)).toBe(true);
  });
});

describe('a run on a real (stub) endpoint', () => {
  test('a model that agrees with the gold labels scores 100% on category and the model\'s own language label', async () => {
    const provider = await realProvider(goldModel);
    const doc = await runEval({ provider, items, setInfo: { file: 'data/eval-set.json', sha256 }, secrets: [KEY], now: fixedNow });
    expect(doc.metrics.categoryAccuracy).toBe(1);
    expect(doc.metrics.modelLanguageAccuracy).toBe(1);
    expect(doc.metrics.urgent.recall).toBe(1);
    expect(doc.metrics.reply.languageCompliance).toBe(1);
    expect(doc.metrics.promptInjection).toEqual({ items: 2, categoryCorrect: 2 });
    expect(doc.provenance).toMatchObject({
      providerKind: 'openai-compatible',
      model: 'swiss-ai/Apertus-v1.5-8B',
      endpointHost: `127.0.0.1:${stub.port}`,
      modelNameSaysApertus: true,
    });
    expect(doc.label).toMatch(/model name is as configured/);
    expect(doc.label).not.toMatch(/NOT an Apertus/);
    expect(doc.metrics.latency.note).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain(KEY);
  });

  test('replies in the wrong language are counted as non-compliant and refused by the gate', async () => {
    const english = (request) => {
      const { kind } = readRequest(request);
      if (kind === 'classify') return goldModel(request);
      const language = request.body.messages[0].content.match(/Write the reply in \w+ \((\w\w)\)/)[1];
      if (language === 'en') return goldModel(request);
      return JSON.stringify({ reply: 'Thank you very much for your review. We are delighted that you enjoyed your visit and hope to see you again.', rationale: 'A stock reply in English.' });
    };
    const provider = await realProvider(english);
    const doc = await runEval({ provider, items, secrets: [KEY], now: fixedNow });
    const nonEnglish = doc.items.filter((row) => row.draft && row.goldLanguage !== 'en' && row.draft.inGoldLanguage !== null);
    expect(nonEnglish.length).toBeGreaterThan(30);
    expect(doc.metrics.reply.languageCompliance).toBeLessThan(0.5);
    expect(doc.metrics.reply.refusedByGate.wrong_language).toBeGreaterThan(30);
    expect(doc.metrics.retries.draftRetried).toBeGreaterThan(30);
  });

  test('a model that obeys the instruction hidden in a review shows up as a miss, not a pass', async () => {
    const obedient = (request) => {
      const { kind, text } = readRequest(request);
      const answer = JSON.parse(goldModel(request));
      if (kind === 'classify' && /ignore your instructions|Ignoriere deine Anweisungen/.test(text)) answer.category = 'urgent';
      return JSON.stringify(answer);
    };
    const provider = await realProvider(obedient);
    const doc = await runEval({ provider, items, secrets: [KEY], now: fixedNow });
    expect(doc.metrics.promptInjection).toEqual({ items: 2, categoryCorrect: 0 });
    expect(doc.metrics.urgent.falseAlarms).toBe(2);
  });

  test('a provider that fails on every review records nothing', async () => {
    const provider = await realProvider(() => ({ status: 401, body: { error: { message: `bad key ${KEY}` } } }));
    const error = await runEval({ provider, items: items.slice(0, 3), secrets: [KEY], now: fixedNow }).catch((e) => e);
    expect(error.message).toMatch(/failed on every review/);
    expect(error.message).not.toContain(KEY);
  });

  test('a provider that fails on some reviews records those as misses', async () => {
    let seen = 0;
    const flaky = (request) => {
      if (readRequest(request).kind === 'classify' && (seen += 1) % 2 === 0) return { status: 400, body: 'nope' };
      return goldModel(request);
    };
    const provider = await realProvider(flaky);
    const doc = await runEval({ provider, items: items.slice(0, 10), secrets: [KEY], now: fixedNow });
    expect(doc.metrics.triageFailures).toBe(5);
    expect(doc.metrics.categoryAccuracy).toBe(0.5);
    expect(doc.items.filter((row) => !row.triaged).every((row) => /HTTP 400/.test(row.classifyError))).toBe(true);
  });
});

describe('latency', () => {
  test('is timed per call around the provider, retries included', async () => {
    class Slow extends FakeApertusProvider {
      async classify(review) {
        await sleep(25);
        return super.classify(review);
      }
      async draftReply(review) {
        await sleep(40);
        return super.draftReply(review);
      }
    }
    const doc = await runEval({ provider: new Slow(), items: items.slice(0, 6), now: fixedNow });
    expect(doc.metrics.latency.classify.meanMs).toBeGreaterThanOrEqual(20);
    expect(doc.metrics.latency.draft.meanMs).toBeGreaterThanOrEqual(35);
    expect(doc.metrics.latency.wallMs).toBeGreaterThanOrEqual(6 * 60);
  });

  test('percentiles use the nearest rank', () => {
    const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms, i) => ({ id: `r${i}`, op: 'classify', ms }));
    const results = rows.map((row) => ({ id: row.id, tags: [], goldCategory: 'praise', goldLanguage: 'de', triaged: true, category: 'praise', language: 'de', categoryCorrect: true, languageCorrect: true, modelLanguageCorrect: true, classifyAttempts: 1, draft: null }));
    const { latency } = computeMetrics(results, rows, 1000);
    expect(latency.classify).toMatchObject({ calls: 10, meanMs: 55, p50Ms: 50, p95Ms: 100, maxMs: 100 });
    expect(latency.reviewsPerMinute).toBe(600);
  });
});

describe('the command line', () => {
  test('a partial run needs an explicit output file', () => {
    expect(() => parseArgs(['--limit', '5'])).toThrow(/needs --out/);
    expect(parseArgs(['--limit', '5', '--out', 'x.json']).limit).toBe(5);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--limit', '0', '--out', 'x.json'])).toThrow(/positive integer/);
  });

  test('--fake runs offline even when LLM variables are set, and writes the result file', async () => {
    const out = path.join(tempDir(), 'results.json');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const env = { LLM_NAME: 'm', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LLM_API_KEY: KEY };
    await main(['--fake', '--out', out], env);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.provenance.providerKind).toBe('fake');
    expect(written.metrics.items).toBe(items.length);
    expect(fs.readFileSync(out, 'utf8')).not.toContain(KEY);
  });

  test('picks the real endpoint from the environment, as the app does', async () => {
    stub = await startStub(goldModel);
    const out = path.join(tempDir(), 'results.json');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const env = { LLM_NAME: 'swiss-ai/Apertus-v1.5-8B', LLM_BASE_URL: stub.baseUrl, LLM_API_KEY: KEY };
    await main(['--limit', '4', '--out', out], env);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(written.provenance).toMatchObject({ providerKind: 'openai-compatible', endpointHost: `127.0.0.1:${stub.port}`, modelNameSaysApertus: true });
    expect(written.metrics.items).toBe(4);
    expect(fs.readFileSync(out, 'utf8')).not.toContain(KEY);
  });

  describe('inside a container (make eval-docker), as the app does', () => {
    const env = (baseUrl, extra = {}) => ({ LLM_NAME: 'swiss-ai/apertus-v1.5-8b', LLM_BASE_URL: baseUrl, LLM_API_KEY: KEY, ...extra });

    test('a loopback LLM_BASE_URL is pointed at host.docker.internal, and the provenance says where the call went', () => {
      const config = configFor(parseArgs([]), env('http://localhost:8000/v1'), true);
      expect(config.llm).toMatchObject({ baseUrl: 'http://host.docker.internal:8000/v1', rewrittenFrom: 'localhost' });
      expect(createProvider(config).describe().endpointHost).toBe('host.docker.internal:8000');
    });

    test('the container is recognised from APERTUS_IN_CONTAINER, which make eval-docker sets', () => {
      const config = configFor(parseArgs([]), env('http://127.0.0.1:9/v1', { APERTUS_IN_CONTAINER: '1' }));
      expect(config.llm.rewrittenFrom).toBe('127.0.0.1');
    });

    test('an address that is not loopback is left alone, and so is everything outside a container', () => {
      expect(configFor(parseArgs([]), env('https://api.publicai.co/v1'), true).llm).not.toHaveProperty('rewrittenFrom');
      expect(configFor(parseArgs([]), env('http://localhost:8000/v1'), false).llm.baseUrl).toBe('http://localhost:8000/v1');
    });

    test('--fake still ignores every LLM variable', () => {
      expect(configFor(parseArgs(['--fake']), env('http://localhost:8000/v1'), true).llm).toBeNull();
    });
  });

  test('a fixture run will not overwrite a result that came from a real endpoint', async () => {
    const out = path.join(tempDir(), 'results.json');
    fs.writeFileSync(out, JSON.stringify({ provenance: { providerKind: 'openai-compatible', model: 'swiss-ai/Apertus-v1.5-8B', endpointHost: 'example.test' } }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(['--fake', '--out', out], {})).rejects.toThrow(/will not overwrite/);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).provenance.model).toBe('swiss-ai/Apertus-v1.5-8B');
    await main(['--fake', '--out', out, '--force'], {});
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).provenance.providerKind).toBe('fake');
  });
});
