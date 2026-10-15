'use strict';

// The mutation check (npm run mutation-check) removes one gate check at a time from a copy of the
// source and needs the suite to fail. It runs the whole suite per removal, so it is not part of
// this suite; what is checked here is that every removal still applies to the current source.

const fs = require('node:fs');
const path = require('node:path');
const { MUTATIONS, applyMutation, occurrences } = require('../scripts/mutation-check');

const ROOT = path.join(__dirname, '..');

describe('the mutations of the approval gate', () => {
  test('are ten, each with a unique id and a stated purpose', () => {
    expect(MUTATIONS).toHaveLength(10);
    expect(new Set(MUTATIONS.map((m) => m.id)).size).toBe(MUTATIONS.length);
    for (const m of MUTATIONS) expect(m.removes.length).toBeGreaterThan(20);
  });

  test.each(MUTATIONS.map((m) => [m.id, m]))('%s still applies, once, to the current source and changes it', (_id, mutation) => {
    const source = fs.readFileSync(path.join(ROOT, mutation.file), 'utf8');
    expect(occurrences(source, mutation.find)).toBe(1);
    expect(applyMutation(source, mutation)).not.toBe(source);
  });

  test('a removal that no longer finds its text is an error, not a silent no-op', () => {
    expect(() => applyMutation('nothing to see', MUTATIONS[0])).toThrow(/found it 0 times/);
    expect(() => applyMutation(`${MUTATIONS[0].find}${MUTATIONS[0].find}`, MUTATIONS[0])).toThrow(/found it 2 times/);
  });
});
