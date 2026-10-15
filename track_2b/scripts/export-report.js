'use strict';

// Exports technical_report.md to the PDF the organisers ask for (<TeamName>_Report.pdf in this
// directory, at most 6 pages) using the Chrome that is already installed, and checks the page
// count. Usage: node scripts/export-report.js [--out FILE] [--max-pages N]
//
// The only dependency beyond Chrome is `marked`, a development dependency that is not in the
// Docker image. Set CHROME_BIN to use a particular browser binary.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { marked } = require('marked');
const { REPORT_PDF } = require('../src/config');
const { countPdfPages } = require('./pdf-pages');
const { run: fillRun } = require('./report-fill');

const ROOT = path.join(__dirname, '..');
const REPORT_MD = path.join(ROOT, 'technical_report.md');
const MAX_PAGES = 6;

const CSS = `
@page { size: A4; margin: 15mm 14mm; }
* { box-sizing: border-box; }
html { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9.4pt; line-height: 1.38; color: #1b1b1b; }
body { margin: 0; }
h1 { font-size: 17pt; margin: 0 0 6px; line-height: 1.2; }
h2 { font-size: 12.5pt; margin: 14px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #c9c9c9; break-after: avoid; }
h3 { font-size: 10.5pt; margin: 10px 0 3px; break-after: avoid; }
p, ul, ol, table, pre, blockquote { margin: 0 0 6px; }
ul, ol { padding-left: 18px; }
li { margin: 0 0 2px; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 8.4pt; background: #f1f1f1; padding: 0 2px; border-radius: 2px; }
pre { background: #f4f4f4; padding: 6px 8px; border-radius: 3px; overflow: hidden; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 8.6pt; break-inside: avoid; }
th, td { border: 1px solid #bdbdbd; padding: 2px 5px; vertical-align: top; text-align: left; }
th { background: #ececec; }
tr { break-inside: avoid; }
img { display: block; max-width: 100%; margin: 4px auto 6px; }
a { color: #0b4f9c; text-decoration: none; }
blockquote { border-left: 3px solid #c9c9c9; padding-left: 8px; color: #444; }
hr { border: 0; border-top: 1px solid #c9c9c9; }
`;

function chromePath(env = process.env) {
  const candidates = [
    env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// A relative link (to another file in the repository) is dead inside a PDF, so only the text
// stays; absolute links are kept.
function renderHtml(markdown) {
  const renderer = new marked.Renderer();
  const defaultLink = renderer.link.bind(renderer);
  renderer.link = function link(token) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(token.href)) return defaultLink(token);
    return this.parser.parseInline(token.tokens);
  };
  const body = marked.parse(markdown, { renderer, gfm: true });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Technical report</title><base href="${pathToFileURL(`${ROOT}/`).href}"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function exportReport({ out = path.join(ROOT, REPORT_PDF), maxPages = MAX_PAGES, chrome = chromePath(), source = REPORT_MD } = {}) {
  if (!chrome) throw new Error('no Chrome found: install Google Chrome or set CHROME_BIN to a Chrome or Chromium binary');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-report-'));
  try {
    const html = path.join(work, 'report.html');
    fs.writeFileSync(html, renderHtml(fs.readFileSync(source, 'utf8')));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const run = spawnSync(
      chrome,
      ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${path.join(work, 'profile')}`, `--print-to-pdf=${out}`, pathToFileURL(html).href],
      { encoding: 'utf8', timeout: 90000 },
    );
    if (run.status !== 0 || !fs.existsSync(out)) {
      throw new Error(`Chrome did not write the PDF (exit ${run.status}): ${String(run.stderr).split('\n').slice(-3).join(' ').trim()}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const pages = countPdfPages(fs.readFileSync(out));
  if (pages > maxPages) {
    throw new Error(`${path.basename(out)} is ${pages} pages; the limit is ${maxPages}. Shorten technical_report.md.`);
  }
  return { out, pages, maxPages };
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') options.out = path.resolve(argv[(i += 1)]);
    else if (argv[i] === '--max-pages') options.maxPages = Number(argv[(i += 1)]);
    else throw new Error(`unknown option "${argv[i]}"`);
  }
  const { stale } = fillRun({ check: true });
  if (stale.length) throw new Error(`${stale.join(', ')} is out of step with data/eval-results.json or TEAM_NAME; run: npm run report:fill`);
  const { out, pages, maxPages } = exportReport(options);
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${pages} page${pages === 1 ? '' : 's'} (limit ${maxPages})`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`report export failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { exportReport, renderHtml, chromePath, MAX_PAGES };
