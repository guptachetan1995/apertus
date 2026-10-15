'use strict';

// Mutation check for the approval gate. For each check listed below it takes a throw-away copy of
// the repository, removes that one check from the source, runs the whole test suite on the copy
// and requires it to FAIL. A check whose removal leaves the suite green is a check no test
// notices; the script exits 1 and names it. It first runs the suite on an unmodified copy, so a
// failure can only mean the removal was noticed. Nothing in the real checkout is touched.
//
// Usage: node scripts/mutation-check.js [--only ID] [--list]      (npm run mutation-check)
// Needs node_modules (npm ci) and, for the report tests, the installed Chrome, like npm test.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, '..');

// `find` must occur exactly once in `file`; tests/mutation-check.test.js keeps that true.
const MUTATIONS = [
  {
    id: 'invoke-owner-only-resolution',
    file: 'src/invoke.js',
    find: "if (actor !== 'owner') {",
    replace: 'if (false) {',
    removes: "invoke() resolving the owner verbs for the owner alone (an agent is handed publish_reply)",
  },
  {
    id: 'publish-actor-check',
    file: 'src/owner-verbs.js',
    find: "requireOwner(actor, 'publish_reply');",
    replace: '',
    removes: "publish_reply's own actor check inside its handler",
  },
  {
    id: 'reject-actor-check',
    file: 'src/owner-verbs.js',
    find: "requireOwner(actor, 'reject_reply');",
    replace: '',
    removes: "reject_reply's own actor check inside its handler",
  },
  {
    id: 'store-publish-needs-draft',
    file: 'src/store.js',
    find: "      if (review.replyStatus !== 'drafted' || review.draftReply === null) {\n        throw new Refusal('no_draft', `review \"${id}\" has no draft waiting to be published`);",
    replace: "      if (false) {\n        throw new Refusal('no_draft', `review \"${id}\" has no draft waiting to be published`);",
    removes: 'the store refusing to publish a review that has no draft waiting',
  },
  {
    id: 'store-publish-stale-draft',
    file: 'src/store.js',
    find: 'if (draftVersion !== undefined && draftVersion !== review.draftVersion) {',
    replace: 'if (false) {',
    removes: 'the store refusing to publish a draft that changed after the owner read it',
  },
  {
    id: 'agent-registry-gains-publish',
    file: 'src/tools.js',
    find: '  get_review: getReview,\n});',
    replace: "  get_review: getReview,\n  publish_reply: require('./owner-verbs').ownerVerbs.publish_reply,\n});",
    removes: 'the separation of the registries: publish_reply registered as an agent tool',
  },
  {
    id: 'extra-arguments',
    file: 'src/schema.js',
    find: 'problems.push(`unexpected argument "${key}"${hint}`);',
    replace: '',
    removes: 'the argument validator refusing any argument a tool does not define (a smuggled replyStatus gets through)',
  },
  {
    id: 'draft-reply-language-check',
    file: 'src/tools.js',
    find: 'if (replyLanguage !== review.detectedLanguage) {',
    replace: 'if (false) {',
    removes: "draft_reply refusing a reply that is not in the review's own language",
  },
  {
    id: 'http-forged-actor',
    file: 'src/server.js',
    find: 'if (claimed !== undefined && claimed !== req.actor) {',
    replace: 'if (false) {',
    removes: 'the HTTP edge refusing a request that names a different actor than its credential proves',
  },
  {
    id: 'http-owner-routes',
    file: 'src/server.js',
    find: "req.actor === 'owner' ? next() : fail(res, 'forbidden_actor', 'this needs the owner session', 403);",
    replace: 'next();',
    removes: 'the owner-session requirement on the dashboard-only routes',
  },
];

function occurrences(text, find) {
  return text.split(find).length - 1;
}

// Returns the source with the mutation applied; throws if the check it removes is not found
// exactly once, so a refactor cannot leave a mutation that silently does nothing.
function applyMutation(source, mutation) {
  const count = occurrences(source, mutation.find);
  if (count !== 1) throw new Error(`${mutation.id}: expected the text to remove once in ${mutation.file}, found it ${count} times`);
  return source.replace(mutation.find, () => mutation.replace);
}

function copyEntry(into) {
  fs.cpSync(ENTRY, into, {
    recursive: true,
    filter: (source) => !/(^|\/)(node_modules|\.git|eval-out|coverage)$/.test(source),
  });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(into, path.basename(ROOT), 'node_modules'), 'dir');
}

function runSuite(copy) {
  const track = path.join(copy, path.basename(ROOT));
  const run = spawnSync(process.execPath, [path.join(track, 'node_modules', 'jest', 'bin', 'jest.js'), '--silent', '--bail', '--ci'], {
    cwd: track,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    timeout: 300000,
  });
  const summary = /Tests:\s+(.*)/.exec(`${run.stdout}\n${run.stderr}`);
  return { passed: run.status === 0, summary: summary ? summary[1].trim() : `exit ${run.status}`, output: `${run.stdout}\n${run.stderr}` };
}

function withCopy(visit) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-mutation-'));
  try {
    const copy = path.join(work, path.basename(ENTRY));
    copyEntry(copy);
    return visit(copy);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') only = argv[(i += 1)];
    else if (argv[i] === '--list') {
      for (const m of MUTATIONS) console.log(`${m.id.padEnd(32)} ${m.removes}`);
      return 0;
    } else throw new Error(`unknown option "${argv[i]}"`);
  }
  const chosen = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
  if (chosen.length === 0) throw new Error(`no mutation called "${only}" (see --list)`);

  console.log('baseline: the suite on an unmodified copy');
  const baseline = withCopy((copy) => runSuite(copy));
  if (!baseline.passed) {
    console.error(`${baseline.output.slice(-1500)}\nthe unmodified copy does not pass, so a failure below would prove nothing`);
    return 1;
  }
  console.log(`  passes (${baseline.summary})`);

  const survived = [];
  for (const mutation of chosen) {
    const result = withCopy((copy) => {
      const file = path.join(copy, path.basename(ROOT), mutation.file);
      fs.writeFileSync(file, applyMutation(fs.readFileSync(file, 'utf8'), mutation));
      return runSuite(copy);
    });
    console.log(`${result.passed ? 'SURVIVED' : 'caught  '}  ${mutation.id}: ${mutation.removes}${result.passed ? '' : ` (${result.summary})`}`);
    if (result.passed) survived.push(mutation.id);
  }
  console.log(survived.length ? `\n${survived.length} of ${chosen.length} removals went unnoticed: ${survived.join(', ')}` : `\nall ${chosen.length} removals made the suite fail`);
  return survived.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`mutation-check failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { MUTATIONS, applyMutation, occurrences };
