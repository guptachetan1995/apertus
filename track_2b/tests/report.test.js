'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportReport, renderHtml, chromePath, MAX_PAGES } = require('../scripts/export-report');
const { countPdfPages } = require('../scripts/pdf-pages');
const { TEAM_NAME, REPORT_PDF } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const report = fs.readFileSync(path.join(ROOT, 'technical_report.md'), 'utf8');
const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'eval-results.json'), 'utf8'));

const pct = (value) => `${(value * 100).toFixed(1)}%`;

describe('countPdfPages', () => {
  test('counts the page objects of a Skia-style PDF', () => {
    const pdf = '%PDF-1.4\n<</Type /Pages /Count 3 /Kids [1 0 R]>>\n<</Type /Page /Parent 2 0 R>>\n<</Type /Page /Parent 2 0 R>>\n<</Type /Page /Parent 2 0 R>>\n';
    expect(countPdfPages(pdf)).toBe(3);
  });

  test('falls back to the page tree\'s largest /Count when page objects are packed away', () => {
    expect(countPdfPages('%PDF-1.5\n<</Type /Pages /Count 2 /Kids [1 0 R]>>\n<</Type /Pages /Count 7 /Kids [2 0 R]>>')).toBe(7);
  });

  test('refuses what it cannot read, rather than guess', () => {
    expect(() => countPdfPages('hello')).toThrow(/not a PDF/);
    expect(() => countPdfPages('%PDF-1.4\nnothing here')).toThrow(/could not read the page count/);
  });
});

describe('the report as HTML', () => {
  const html = renderHtml('# T\n\nSee [the doc](docs/architecture.md) and [the site](https://example.test/x).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![fig](docs/architecture.svg)\n');

  test('keeps absolute links and drops relative ones, which are dead inside a PDF', () => {
    expect(html).toContain('<a href="https://example.test/x">the site</a>');
    expect(html).toContain('the doc');
    expect(html).not.toContain('href="docs/architecture.md"');
  });

  test('renders tables and resolves images against the track directory', () => {
    expect(html).toContain('<table>');
    expect(html).toContain('<img src="docs/architecture.svg"');
    expect(html).toMatch(/<base href="file:\/\/[^"]*track_2b\/">/);
  });

  test('loads nothing from the network', () => {
    expect(renderHtml(report)).not.toMatch(/(src|href)="https?:\/\/[^"]*\.(js|css|woff2?|png|svg)"/);
  });

  test('leaves no raw markdown behind: a generated block that opens a line swallows its line as raw HTML', () => {
    const body = renderHtml(report).replace(/<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>/g, '');
    expect(body).not.toContain('**');
    expect(body.replace(/<!--[\s\S]*?-->/g, '')).toMatch(/built and tested; the\s+quality of /);
  });
});

describe('the report', () => {
  test('names the PDF <TeamName>_Report.pdf, with the one TEAM_NAME constant and no spaces', () => {
    expect(REPORT_PDF).toBe(`${TEAM_NAME}_Report.pdf`);
    expect(REPORT_PDF).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*_Report\.pdf$/);
  });

  test('draws its figure from a file that exists', () => {
    expect(report).toContain('(docs/architecture.svg)');
    expect(fs.existsSync(path.join(ROOT, 'docs', 'architecture.svg'))).toBe(true);
  });

  test('declares what the jury asks for', () => {
    const required = [
      /Declared maturity level:\*\* \*\*proof of concept/,
      /### Target architecture \(mandatory\)/,
      /Declared target: on-premise/,
      /Build time versus runtime/,
      /External services contacted by the running solution: none/,
      /8B versus 70B/,
      /ten times the volume/,
      /Where Apertus fell short/,
      /Use of coding assistants/,
      /Claude Code/,
      /publish_reply/,
    ];
    for (const pattern of required) expect(report).toMatch(pattern);
  });

  test('stays within six pages of A4 when exported with the installed Chrome', () => {
    if (!chromePath()) {
      console.warn('report PDF check skipped: no Chrome found');
      return;
    }
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-pdf-')), REPORT_PDF);
    const { pages } = exportReport({ out });
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(MAX_PAGES);
    expect(fs.readFileSync(out).subarray(0, 5).toString()).toBe('%PDF-');
  }, 90000);

  test('fails the export, naming the limit, when the report is too long', () => {
    if (!chromePath()) return;
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-pdf-')), 'long.pdf');
    expect(() => exportReport({ out, maxPages: 1 })).toThrow(/limit is 1/);
  }, 90000);
});

describe('the report and the evaluation results agree', () => {
  test('the committed result names the exact evaluation set it ran on', () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'data', 'eval-set.json'));
    expect(results.provenance.evalSet.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(results.metrics.items).toBe(results.provenance.evalSet.items);
  });

  test('says "Not yet run against Apertus" while the only result is the fixture\'s, and quotes its numbers', () => {
    if (results.provenance.providerKind !== 'fake') return;
    expect(report).toMatch(/Not yet run against Apertus/);
    expect(results.label).toMatch(/NOT an Apertus result/);
    const m = results.metrics;
    expect(report).toContain(pct(m.categoryAccuracy));
    expect(report).toContain(pct(m.languageAccuracy));
    expect(report).toContain(pct(m.urgent.recall));
    expect(report).toContain(pct(m.reply.languageCompliance));
    expect(report).toContain(`${m.reply.languageCompliantCount} of ${m.reply.languageJudged}`);
    expect(report).toContain(`${m.urgent.caught} of ${m.urgent.gold}`);
    expect(report).toContain(results.provenance.date.slice(0, 10));
  });

  test('once a real result is committed, the report must name its model and host', () => {
    if (results.provenance.providerKind === 'fake') return;
    expect(report).toContain(results.provenance.model);
    expect(report).toContain(results.provenance.endpointHost);
  });
});
