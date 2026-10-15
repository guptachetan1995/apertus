'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TEAM_NAME, REPORT_PDF, loadConfig, detectContainer, isLoopbackHost } = require('../src/config');

describe('loadConfig', () => {
  test('defaults to loopback and the offline provider', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: 3000, llm: null, publicOrigin: null, ownerToken: null, agentToken: null });
  });

  test('takes the three LLM variables together', () => {
    const config = loadConfig({ LLM_NAME: 'swiss-ai/Apertus-v1.5-8B', LLM_BASE_URL: 'http://127.0.0.1:8000/v1', LLM_API_KEY: 'test-key-value' });
    expect(config.llm).toEqual({ name: 'swiss-ai/Apertus-v1.5-8B', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'test-key-value', timeoutMs: 60000 });
  });

  test('names what is missing when only some are set, without printing any value', () => {
    expect(() => loadConfig({ LLM_NAME: 'a-model', LLM_API_KEY: 'a-secret-value' })).toThrow(/missing: LLM_BASE_URL/);
    try {
      loadConfig({ LLM_NAME: 'a-model', LLM_API_KEY: 'a-secret-value' });
    } catch (error) {
      expect(error.message).not.toContain('a-secret-value');
    }
  });

  test('treats empty strings as unset, so an empty .env.example changes nothing', () => {
    expect(loadConfig({ LLM_NAME: '', LLM_BASE_URL: '', LLM_API_KEY: '' }).llm).toBeNull();
  });

  test('takes fixed tokens only if they are long enough to be a secret', () => {
    expect(loadConfig({ OWNER_TOKEN: 'o'.repeat(16), AGENT_TOKEN: 'a'.repeat(32) })).toMatchObject({ ownerToken: 'o'.repeat(16), agentToken: 'a'.repeat(32) });
    expect(() => loadConfig({ OWNER_TOKEN: 'short' })).toThrow(/OWNER_TOKEN must be at least 16/);
    expect(() => loadConfig({ AGENT_TOKEN: 'short' })).toThrow(/AGENT_TOKEN must be at least 16/);
  });

  test('refuses a port that is not a port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('a loopback LLM_BASE_URL inside a container', () => {
  const env = (url) => ({ LLM_NAME: 'swiss-ai/Apertus-v1.5-8B', LLM_BASE_URL: url, LLM_API_KEY: 'test-key-value' });

  test.each([
    ['http://localhost:8000/v1', 'http://host.docker.internal:8000/v1', 'localhost'],
    ['http://127.0.0.1:8000/v1', 'http://host.docker.internal:8000/v1', '127.0.0.1'],
    ['http://127.0.1.5/v1', 'http://host.docker.internal/v1', '127.0.1.5'],
    ['https://[::1]:8443/api/v1/', 'https://host.docker.internal:8443/api/v1/', '[::1]'],
    ['http://0.0.0.0:8000/v1', 'http://host.docker.internal:8000/v1', '0.0.0.0'],
    ['http://LOCALHOST:8000/v1', 'http://host.docker.internal:8000/v1', 'localhost'],
  ])('%s is rewritten to %s', (given, expected, from) => {
    const { llm } = loadConfig(env(given), { inContainer: true });
    expect(llm.baseUrl).toBe(expected);
    expect(llm.rewrittenFrom).toBe(from);
  });

  test('is not rewritten outside a container', () => {
    expect(loadConfig(env('http://localhost:8000/v1')).llm).toEqual({
      name: 'swiss-ai/Apertus-v1.5-8B',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key-value',
      timeoutMs: 60000,
    });
    expect(loadConfig(env('http://127.0.0.1:8000/v1'), { inContainer: false }).llm.baseUrl).toBe('http://127.0.0.1:8000/v1');
  });

  test.each(['https://api.publicai.co/v1', 'http://host.docker.internal:8000/v1', 'http://192.168.1.20:8000/v1', 'http://localhost.example.test/v1', 'http://10.0.0.127/v1'])(
    'leaves %s alone, container or not',
    (url) => {
      const { llm } = loadConfig(env(url), { inContainer: true });
      expect(llm.baseUrl).toBe(url);
      expect(llm.rewrittenFrom).toBeUndefined();
    },
  );

  test('changes nothing when no endpoint is configured', () => {
    expect(loadConfig({}, { inContainer: true }).llm).toBeNull();
  });

  test('knows a loopback host from one that only looks like it', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.255.0.9', '[::1]', '0.0.0.0']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['localhost.example.test', '128.0.0.1', '1127.0.0.1', 'host.docker.internal', 'api.publicai.co']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('detectContainer', () => {
  const nothing = () => false;

  test('is true for the Dockerfile hint, /.dockerenv or /run/.containerenv, and false otherwise', () => {
    expect(detectContainer({ APERTUS_IN_CONTAINER: '1' }, nothing)).toBe(true);
    expect(detectContainer({}, (file) => file === '/.dockerenv')).toBe(true);
    expect(detectContainer({}, (file) => file === '/run/.containerenv')).toBe(true);
    expect(detectContainer({}, nothing)).toBe(false);
    expect(detectContainer({ APERTUS_IN_CONTAINER: '0' }, nothing)).toBe(false);
  });
});

describe('ENV_FILE', () => {
  function envFile(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-triage-env-'));
    const file = path.join(dir, 'test.env');
    fs.writeFileSync(file, text);
    return file;
  }

  test('reads the LLM variables from a file named by path; the real environment wins', () => {
    const file = envFile('LLM_NAME=file-model\nLLM_BASE_URL=http://127.0.0.1:9/v1\nLLM_API_KEY=file-key-value\n');
    const config = loadConfig({ ENV_FILE: file, LLM_NAME: 'env-model' });
    expect(config.llm).toEqual({ name: 'env-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'file-key-value', timeoutMs: 60000 });
  });

  test('names a file it cannot read, without printing anything from it', () => {
    expect(() => loadConfig({ ENV_FILE: path.join(os.tmpdir(), 'no-such-dir', 'x.env') })).toThrow(/could not be read \(ENOENT\)/);
  });
});

describe('the team name', () => {
  test('is one constant of letters, digits, "_" and "-" (no spaces) that builds the report file name', () => {
    expect(TEAM_NAME).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(REPORT_PDF).toBe(`${TEAM_NAME}_Report.pdf`);
  });

  test('is the only place the name is built in the source', () => {
    const src = path.join(__dirname, '..', 'src');
    const hits = fs
      .readdirSync(src, { recursive: true })
      .filter((file) => file.endsWith('.js'))
      .filter((file) => fs.readFileSync(path.join(src, file), 'utf8').includes('_Report.pdf'));
    expect(hits).toEqual(['config.js']);
  });
});
