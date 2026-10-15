'use strict';

// report:fill keeps the README, the technical report and the repository README in step with the
// recorded evaluation result and the team name. These tests run it on throw-away copies of the
// documents, once with the offline fixture's result and once with a sample real-endpoint result
// (tests/fixtures: produced by the harness against a local stub, labelled as a test sample).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, checkTeamName, endpointKind, DOCUMENTS } = require('../scripts/report-fill');
const { exportReport, chromePath, MAX_PAGES } = require('../scripts/export-report');
const { TEAM_NAME } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const FIXTURE_SAMPLE = path.join(FIXTURES, 'eval-results.fixture-sample.json');
const REAL_SAMPLE = path.join(FIXTURES, 'eval-results.real-mode-sample.json');
const realSample = JSON.parse(fs.readFileSync(REAL_SAMPLE, 'utf8'));

function workspace(resultsDoc, extras = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-fill-'));
  const root = path.join(base, 'track_2b');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  for (const { file } of DOCUMENTS) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  fs.copyFileSync(path.join(ROOT, 'data', 'eval-set.json'), path.join(root, 'data', 'eval-set.json'));
  fs.writeFileSync(path.join(root, 'data', 'eval-results.json'), JSON.stringify(resultsDoc));
  for (const [name, doc] of Object.entries(extras)) fs.writeFileSync(path.join(root, 'data', name), JSON.stringify(doc));
  const raw = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  // The text is wrapped at 100 columns, so searches run on it with line breaks as single spaces.
  const flat = (file) => raw(file).replace(/\s+/g, ' ');
  return { root, base, raw, report: () => flat('technical_report.md'), readme: () => flat('README.md'), top: () => flat('../README.md') };
}

const withProvenance = (doc, changes) => ({ ...doc, provenance: { ...doc.provenance, ...changes } });
const publicAi = withProvenance(realSample, { model: 'swiss-ai/apertus-v1.5-8b', endpointHost: 'api.publicai.co', modelNameSaysApertus: true });

describe('fixture mode (only the offline fixture has a result)', () => {
  const fixtureDoc = JSON.parse(fs.readFileSync(FIXTURE_SAMPLE, 'utf8'));
  let ws;
  beforeAll(() => {
    ws = workspace(fixtureDoc);
    run({ root: ws.root });
  });

  test('every document says "Not yet run against Apertus", and quotes the fixture\'s numbers', () => {
    expect(ws.report()).toMatch(/\*\*Not yet run against Apertus\.\*\*/);
    expect(ws.report()).toMatch(/Not yet run against Apertus:\*\* no number in this report was produced by/);
    expect(ws.readme()).toMatch(/not yet run against Apertus\.\*\*/);
    expect(ws.readme()).toMatch(/Nothing in this repository has been produced by Apertus yet/);
    expect(ws.top()).toMatch(/Nothing in this\s+repository has been produced by Apertus yet/);
    const m = fixtureDoc.metrics;
    for (const text of [`${(m.categoryAccuracy * 100).toFixed(1)}%`, `${m.urgent.caught} of ${m.urgent.gold}`, `${m.reply.languageCompliantCount} of ${m.reply.languageJudged} replies`]) {
      expect(ws.report()).toContain(text);
    }
    expect(ws.report()).toContain(fixtureDoc.provenance.date.slice(0, 10));
  });

  test('the report keeps "no external service" and says the project has used no third-party gateway', () => {
    expect(ws.report()).toMatch(/External services contacted by the running solution: none/);
    expect(ws.report()).toMatch(/this\s+project has not used one/);
    expect(ws.report()).not.toMatch(/third-party gateway, which received/);
  });

  test('a second run changes nothing, and --check agrees', () => {
    expect(run({ root: ws.root })).toEqual({ mode: 'fixture', stale: [] });
    expect(run({ root: ws.root, check: true }).stale).toEqual([]);
  });
});

describe('real mode (a result from a real endpoint is on record)', () => {
  let ws;
  beforeAll(() => {
    ws = workspace(realSample);
    run({ root: ws.root });
  });

  test('the status flips to "run against <model> via <host> on <date>" everywhere', () => {
    const label = 'test-model-8b via gateway.example.test on 2026-10-20';
    expect(ws.readme()).toContain(`run against ${label}`);
    expect(ws.readme()).toContain(`produced by ${label}`);
    expect(ws.top()).toContain(label);
    expect(ws.report()).toContain(`Run against ${label}`);
    for (const text of [ws.report(), ws.readme(), ws.top()]) {
      expect(text).not.toMatch(/not yet run against Apertus/i);
      expect(text).not.toMatch(/has not been produced by Apertus yet|no number in this report was produced/i);
    }
  });

  test('a model name that does not say Apertus is not recorded as an Apertus result', () => {
    expect(ws.report()).toMatch(/does not say Apertus/);
    expect(ws.readme()).toMatch(/not recorded as an Apertus result/);
  });

  test('the table carries the metrics, the provenance line has the SHA-256, and 70B is still "Not yet run"', () => {
    const m = realSample.metrics;
    const report = ws.report();
    expect(report).toContain(`${(m.categoryAccuracy * 100).toFixed(1)}% (`);
    expect(report).toContain(`${(m.urgent.recall * 100).toFixed(1)}% (${m.urgent.caught} of ${m.urgent.gold})`);
    expect(report).toContain(`${m.reply.languageCompliantCount} of ${m.reply.languageJudged} replies`);
    expect(report).toContain('classify');
    expect(report).toMatch(/p50 \/ p95 per call/);
    expect(report).toContain(`Provenance: model \`test-model-8b\`, host \`gateway.example.test\`, date ${realSample.provenance.date.slice(0, 16)}Z`);
    expect(report).toContain(realSample.provenance.evalSet.sha256);
    expect(report).toMatch(/\| Apertus 70B \| Not yet run/);
    expect(report).not.toMatch(/\| Apertus 8B \| Not yet run/);
  });

  test('the per-language lines and the decision rule are computed from the results', () => {
    const report = ws.report();
    for (const [language, v] of Object.entries(realSample.metrics.perLanguage)) {
      expect(report).toContain(`${language} (${v.items}) ${(v.categoryAccuracy * 100).toFixed(1)}%`);
    }
    expect(report).toMatch(/urgent 12 of 14 \(the rule asks for all 14\): not met/);
    expect(report).toMatch(/The rule calls for running 70B on the same set/);
  });

  test('the failure analysis lists, by id, what the results file shows went wrong', () => {
    const report = ws.report();
    const analysis = report.slice(report.indexOf('### Failure analysis'));
    expect(analysis).toBeTruthy();
    const items = realSample.items;
    const missed = items.filter((r) => r.goldCategory === 'urgent' && r.category !== 'urgent');
    expect(missed).toHaveLength(2);
    for (const r of missed) expect(analysis).toContain(`${r.id} (`);
    const wrongCategory = items.filter((r) => !r.categoryCorrect);
    expect(analysis).toContain(`**Category:** ${wrongCategory.length} of ${items.length} wrong.`);
    const wrongLabel = items.filter((r) => r.modelLanguage !== r.goldLanguage);
    for (const r of wrongLabel) expect(analysis).toContain(`${r.id}: labelled ${r.goldLanguage}, said ${r.modelLanguage}`);
    const wrongReply = items.filter((r) => r.draft && r.draft.inGoldLanguage === false);
    expect(wrongReply.length).toBeGreaterThan(0);
    for (const r of wrongReply) expect(analysis).toContain(`${r.id}: read as ${r.draft.replyLanguageRead}`);
    expect(analysis).toMatch(/\*\*Caveats\.\*\* One annotator labelled the 53 reviews/);
  });

  test('"Where Apertus fell short" points at the analysis with counts from the results', () => {
    expect(ws.report()).toMatch(/\*\*Where Apertus fell short:\*\* the failure analysis in section 5/);
    expect(ws.report()).toMatch(/test-model-8b: 3 category errors, 2 urgent reviews missed, 1 replies not in the review's language, 0 provider failures/);
  });

  test('says the run used a third-party gateway only when the host is one', () => {
    expect(endpointKind('gateway.example.test')).toBe('third-party');
    expect(ws.report()).toMatch(/used one: `gateway\.example\.test`, a third-party gateway \(judged from the address\)/);
    expect(ws.report()).toMatch(/fictional evaluation reviews/);
    const local = workspace(withProvenance(realSample, { endpointHost: '127.0.0.1:8000' }));
    run({ root: local.root });
    expect(local.report()).toMatch(/local or private address/);
    expect(local.report()).not.toMatch(/third-party gateway, which received/);
  });

  test('Public AI is named, and the report still shows the fictional data', () => {
    const pa = workspace(publicAi);
    run({ root: pa.root });
    expect(pa.report()).toMatch(/`api\.publicai\.co` \(Public AI Gateway\), a third-party gateway, which received the text and star rating of the 53 fictional evaluation reviews/);
    expect(pa.report()).toMatch(/\*\*Run against swiss-ai\/apertus-v1\.5-8b via api\.publicai\.co on 2026-10-20\.\*\*/);
    expect(pa.report()).not.toMatch(/does not say Apertus/);
    expect(pa.report()).toMatch(/neither the\s+on-premise nor the air-gapped deployment has been exercised end to end/);
  });

  test('another model\'s file (data/eval-results-70b.json) gets its own row and the 70B row stops saying "Not yet run"', () => {
    const both = workspace(publicAi, { 'eval-results-70b.json': withProvenance(realSample, { model: 'swiss-ai/apertus-v1.5-70b', endpointHost: 'api.publicai.co', modelNameSaysApertus: true }) });
    run({ root: both.root });
    expect(both.report()).toContain('`swiss-ai/apertus-v1.5-70b`');
    expect(both.report()).not.toMatch(/\| Apertus 70B \| Not yet run/);
    expect(both.report()).toMatch(/Repeat the runs to see the variance/);
  });

  test('a result produced on another version of the evaluation set is refused', () => {
    const stale = workspace(withProvenance(realSample, {}));
    const doc = JSON.parse(JSON.stringify(realSample));
    doc.provenance.evalSet.sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(stale.root, 'data', 'eval-results.json'), JSON.stringify(doc));
    expect(() => run({ root: stale.root })).toThrow(/different version of data\/eval-set\.json/);
  });

  test('the real-mode report still exports to at most six pages', () => {
    if (!chromePath()) return;
    const out = path.join(ws.base, 'real-mode.pdf');
    const { pages } = exportReport({ out, source: path.join(ws.root, 'technical_report.md') });
    expect(pages).toBeLessThanOrEqual(MAX_PAGES);
  }, 90000);

  test('--check reports stale documents without touching them', () => {
    const fresh = workspace(JSON.parse(fs.readFileSync(FIXTURE_SAMPLE, 'utf8')));
    run({ root: fresh.root });
    fs.writeFileSync(path.join(fresh.root, 'data', 'eval-results.json'), JSON.stringify(realSample));
    const before = fresh.raw('technical_report.md');
    expect(run({ root: fresh.root, check: true }).stale).toEqual(['README.md', 'technical_report.md', '../README.md']);
    expect(fresh.raw('technical_report.md')).toBe(before);
  });
});

describe('a missing or unknown block is an error, not a silent skip', () => {
  test('a document that lost a generated block', () => {
    const ws = workspace(JSON.parse(fs.readFileSync(FIXTURE_SAMPLE, 'utf8')));
    const file = path.join(ws.root, 'technical_report.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/<!-- generated:headline:start -->[\s\S]*?<!-- generated:headline:end -->/, ''));
    expect(() => run({ root: ws.root })).toThrow(/the generated block "headline" is missing/);
  });

  test('a marker no generator knows', () => {
    const ws = workspace(JSON.parse(fs.readFileSync(FIXTURE_SAMPLE, 'utf8')));
    const file = path.join(ws.root, 'README.md');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n<!-- generated:nonsense:start -->x<!-- generated:nonsense:end -->\n`);
    expect(() => run({ root: ws.root })).toThrow(/unknown generated block "nonsense"/);
  });
});

describe('the team name', () => {
  test.each(['TEAM_NAME', 'Atlas', 'Team-9', 'a1'])('%s is an acceptable name', (name) => {
    expect(() => checkTeamName(name)).not.toThrow();
  });

  test.each(['', ' ', 'My Team', 'a/b', '_x', 'Équipe', 'x.pdf'])('"%s" is not', (name) => {
    expect(() => checkTeamName(name)).toThrow(/TEAM_NAME must be/);
  });

  test('is changed in one line, and the README line, the report line and the PDF name follow', () => {
    const ws = workspace(JSON.parse(fs.readFileSync(FIXTURE_SAMPLE, 'utf8')));
    run({ root: ws.root, teamName: 'Atlas' });
    expect(ws.readme()).toContain('<!-- generated:team-pdf:start -->`Atlas_Report.pdf`<!-- generated:team-pdf:end -->');
    expect(ws.raw('README.md').split('\n').filter((line) => line.includes('Atlas_Report.pdf'))).toHaveLength(1);
    expect(ws.report()).toContain('- **Team:** Chetan Gupta (identifier <!-- generated:team:start -->`Atlas`<!-- generated:team:end -->)');
    expect(ws.report()).not.toContain('`ChetanGupta`');
    expect(run({ root: ws.root, teamName: 'Atlas', check: true }).stale).toEqual([]);
    expect(run({ root: ws.root, check: true }).stale).toEqual(['README.md', 'technical_report.md']);
  });
});

describe('the committed documents', () => {
  test('are in step with data/eval-results.json and src/config.js (run: npm run report:fill)', () => {
    expect(run({ check: true }).stale).toEqual([]);
  });

  test('carry the team name from the one constant', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const report = fs.readFileSync(path.join(ROOT, 'technical_report.md'), 'utf8');
    expect(readme.split('\n').filter((line) => line.includes(`${TEAM_NAME}_Report.pdf`))).toHaveLength(1);
    expect(report).toContain(`- **Team:** Chetan Gupta (identifier <!-- generated:team:start -->\`${TEAM_NAME}\`<!-- generated:team:end -->)`);
  });
});
