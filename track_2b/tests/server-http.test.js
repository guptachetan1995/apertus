'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp, start } = require('../src/server');
const { createStore } = require('../src/store');
const { createAuth } = require('../src/auth');
const { FakeApertusProvider } = require('../src/providers/fake-apertus-provider');
const { steppingClock } = require('./helpers');

const OWNER_TOKEN = 'o'.repeat(32);
const AGENT_TOKEN = 'a'.repeat(32);

let server;
let base;
let store;

async function boot() {
  store = createStore({ now: steppingClock() });
  const app = createApp({ store, provider: new FakeApertusProvider(), auth: createAuth({ ownerToken: OWNER_TOKEN, agentToken: AGENT_TOKEN }) });
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function request(method, route, { cookie, bearer, body, headers = {}, raw } = {}) {
  const init = { method, redirect: 'manual', headers: { ...headers } };
  if (cookie) init.headers.Cookie = cookie;
  if (bearer) init.headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined || raw !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = raw !== undefined ? raw : JSON.stringify(body);
  }
  const response = await fetch(base + route, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function ownerCookie() {
  const response = await request('GET', `/session?token=${OWNER_TOKEN}`);
  expect(response.status).toBe(303);
  return response.headers.getSetCookie()[0].split(';')[0];
}

const invoke = (credential, tool, args, extra = {}) =>
  request('POST', '/api/invoke', { ...credential, body: { tool, args, ...extra } });

beforeEach(boot);
afterEach(() => new Promise((resolve) => server.close(resolve)));

describe('who is calling', () => {
  test('binds to loopback only by default', () => {
    expect(server.address().address).toBe('127.0.0.1');
  });

  test('refuses every API call that carries no credential, and changes nothing', async () => {
    for (const [method, route, body] of [
      ['GET', '/api/state'],
      ['GET', '/api/tools'],
      ['POST', '/api/invoke', { tool: 'triage_reviews', args: {} }],
      ['POST', '/api/invoke', { tool: 'publish_reply', args: { id: 'rev_001' }, actor: 'owner' }],
      ['POST', '/api/agent/run', {}],
      ['POST', '/api/probe/smuggle-status', {}],
    ]) {
      const response = await request(method, route, { body });
      expect({ route, status: response.status }).toEqual({ route, status: 401 });
    }
    expect(store.list().every((r) => r.triagedAt === null)).toBe(true);
    expect(store.log()).toEqual([]);
  });

  test('the owner link works once and only once', async () => {
    expect((await request('GET', '/session?token=wrong')).status).toBe(403);
    const first = await request('GET', `/session?token=${OWNER_TOKEN}`);
    expect(first.status).toBe(303);
    expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(first.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    expect((await request('GET', `/session?token=${OWNER_TOKEN}`)).status).toBe(403);
  });

  describe('opening the link again', () => {
    test('with the owner cookie goes on to the dashboard and uses nothing up', async () => {
      const cookie = await ownerCookie();
      for (let i = 0; i < 3; i += 1) {
        const again = await request('GET', `/session?token=${OWNER_TOKEN}`, { cookie });
        expect(again.status).toBe(303);
        expect(again.headers.get('location')).toBe('/');
        expect(again.headers.get('set-cookie')).toBeNull();
      }
      expect((await request('GET', '/api/state', { cookie })).status).toBe(200);
    });

    test('with the owner cookie works even without the token in the address', async () => {
      const cookie = await ownerCookie();
      const again = await request('GET', '/session', { cookie });
      expect(again.status).toBe(303);
      expect(again.headers.get('location')).toBe('/');
    });

    test('without the cookie is still refused, and says the link was already used and to restart make run', async () => {
      await ownerCookie();
      const replay = await request('GET', `/session?token=${OWNER_TOKEN}`);
      expect(replay.status).toBe(403);
      expect(replay.headers.get('set-cookie')).toBeNull();
      expect(replay.text).toMatch(/already used/);
      expect(replay.text).toMatch(/Restart `make run`/);
      expect((await request('GET', '/api/state', { cookie: 'review_owner=nope' })).status).toBe(401);
    });

    test('with a made-up cookie is not rescued by it', async () => {
      await ownerCookie();
      const replay = await request('GET', `/session?token=${OWNER_TOKEN}`, { cookie: 'review_owner=made-up' });
      expect(replay.status).toBe(403);
    });

    test('a wrong token is "not valid", not "already used", before and after the real one is traded', async () => {
      const before = await request('GET', '/session?token=wrong');
      expect(before.status).toBe(403);
      expect(before.text).toMatch(/not valid/);
      await ownerCookie();
      const after = await request('GET', '/session?token=wrong');
      expect(after.status).toBe(403);
      expect(after.text).toMatch(/not valid/);
      expect(after.text).not.toMatch(/already used/);
    });

    test('a browser prefetch does not use the link up', async () => {
      for (const headers of [{ 'Sec-Purpose': 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' }, { 'X-moz': 'prefetch' }]) {
        const speculative = await request('GET', `/session?token=${OWNER_TOKEN}`, { headers });
        expect(speculative.status).toBe(204);
        expect(speculative.headers.get('set-cookie')).toBeNull();
      }
      const real = await request('GET', `/session?token=${OWNER_TOKEN}`);
      expect(real.status).toBe(303);
      expect(real.headers.get('set-cookie')).toMatch(/review_owner=/);
    });
  });

  test('a made-up cookie or token is not a credential', async () => {
    expect((await request('GET', '/api/state', { cookie: 'review_owner=nope' })).status).toBe(401);
    expect((await request('GET', '/api/tools', { bearer: 'nope' })).status).toBe(401);
  });

  test('a wrong bearer token is not rescued by a valid owner cookie', async () => {
    const cookie = await ownerCookie();
    expect((await request('GET', '/api/tools', { cookie, bearer: 'nope' })).status).toBe(401);
  });
});

describe('a forged actor is refused', () => {
  test('an agent that says it is the owner cannot publish, and the attempt is logged', async () => {
    await invoke({ bearer: AGENT_TOKEN }, 'triage_reviews', {});
    const response = await invoke({ bearer: AGENT_TOKEN }, 'publish_reply', { id: 'rev_002' }, { actor: 'owner' });
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe('forged_actor');
    expect(store.list().some((r) => r.replyStatus === 'published')).toBe(false);
    expect(store.log().at(-1)).toMatchObject({ actor: 'agent', tool: 'publish_reply', outcome: 'refused', result: 'refused: forged_actor' });
  });

  test('the owner cannot be made to act as the agent either', async () => {
    const cookie = await ownerCookie();
    const response = await invoke({ cookie }, 'triage_reviews', {}, { actor: 'agent' });
    expect(response.status).toBe(403);
    expect(response.json.error.code).toBe('forged_actor');
    expect(store.list().every((r) => r.triagedAt === null)).toBe(true);
  });

  test('saying who you are is fine when it is true', async () => {
    const response = await invoke({ bearer: AGENT_TOKEN }, 'list_reviews', {}, { actor: 'agent' });
    expect(response.status).toBe(200);
  });

  test('an actor named in the request with no credential is not believed', async () => {
    const response = await invoke({}, 'publish_reply', { id: 'rev_001' }, { actor: 'owner' });
    expect(response.status).toBe(401);
  });

  test('even with the agent token, publish_reply and reject_reply are refused as owner-only', async () => {
    await invoke({ bearer: AGENT_TOKEN }, 'triage_reviews', {});
    const publish = await invoke({ bearer: AGENT_TOKEN }, 'publish_reply', { id: 'rev_002' });
    expect(publish.status).toBe(403);
    expect(publish.json.error.code).toBe('forbidden_actor');
    const reject = await invoke({ bearer: AGENT_TOKEN }, 'reject_reply', { id: 'rev_002', reason: 'nope nope' });
    expect(reject.status).toBe(403);
  });

  test('the agent token cannot use the owner-only routes', async () => {
    for (const [method, route] of [['GET', '/api/state'], ['POST', '/api/agent/run'], ['POST', '/api/probe/smuggle-status']]) {
      const response = await request(method, route, { bearer: AGENT_TOKEN, body: method === 'POST' ? {} : undefined });
      expect({ route, status: response.status }).toEqual({ route, status: 403 });
    }
  });
});

describe('the agent over HTTP', () => {
  test('is shown only its four tools', async () => {
    const response = await request('GET', '/api/tools', { bearer: AGENT_TOKEN });
    expect(response.json.tools.map((t) => t.name).sort()).toEqual(['draft_reply', 'get_review', 'list_reviews', 'triage_reviews']);
    expect(response.text).not.toMatch(/publish_reply|reject_reply/);
  });

  test('can triage and draft, but a smuggled replyStatus is a 400 and changes nothing', async () => {
    await invoke({ bearer: AGENT_TOKEN }, 'triage_reviews', {});
    const review = store.get('rev_001');
    const smuggled = await invoke({ bearer: AGENT_TOKEN }, 'draft_reply', {
      id: review.id,
      category: 'complaint',
      reply: 'Vielen Dank für Ihre Rückmeldung, wir haben sie an das ganze Team weitergegeben.',
      rationale: 'A valid draft that also tries to set the status.',
      replyStatus: 'published',
    });
    expect(smuggled.status).toBe(400);
    expect(store.get('rev_001').replyStatus).toBe('unreviewed');
  });

  test('a wrong-language reply is a 422', async () => {
    await invoke({ bearer: AGENT_TOKEN }, 'triage_reviews', {});
    const response = await invoke({ bearer: AGENT_TOKEN }, 'draft_reply', {
      id: 'rev_001',
      category: 'complaint',
      reply: 'Thank you very much for your feedback, we are sorry that the breakfast was cold.',
      rationale: 'The reply is in the wrong language on purpose.',
    });
    expect(response.status).toBe(422);
    expect(response.json.error.code).toBe('wrong_language');
  });
});

describe('request handling', () => {
  test('a request from another origin is refused even with a valid session', async () => {
    const cookie = await ownerCookie();
    const response = await request('POST', '/api/invoke', {
      cookie,
      body: { tool: 'triage_reviews', args: {} },
      headers: { Origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(store.list().every((r) => r.triagedAt === null)).toBe(true);
  });

  test('a body that is not JSON is refused', async () => {
    const cookie = await ownerCookie();
    expect((await request('POST', '/api/invoke', { cookie, raw: 'tool=triage_reviews', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await request('POST', '/api/invoke', { cookie, raw: '{not json' })).status).toBe(400);
    const big = await request('POST', '/api/invoke', { cookie, raw: JSON.stringify({ tool: 'x', args: { pad: 'x'.repeat(40000) } }) });
    expect(big.status).toBe(413);
  });

  test('unknown API routes and unknown tools are 404s', async () => {
    const cookie = await ownerCookie();
    expect((await request('GET', '/api/nothing', { cookie })).status).toBe(404);
    expect((await invoke({ cookie }, 'no_such_tool', {})).status).toBe(404);
  });

  test('serves the dashboard with a locked-down content policy', async () => {
    const page = await request('GET', '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Review reply desk');
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await request('GET', '/app.js')).status).toBe(200);
    expect((await request('GET', '/style.css')).status).toBe(200);
  });

  test('the dashboard script never builds HTML from data', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'app.js'), 'utf8');
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(script).not.toContain(banned);
    }
    expect(fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8')).not.toMatch(/<script>|onclick=/i);
  });
});

describe('the demo script', () => {
  test('six reviews, triage, a draft, one Approve, separate attributed log entries, a refused smuggle', async () => {
    const cookie = await ownerCookie();

    // 1. The dashboard loads six reviews in four languages.
    const initial = await request('GET', '/api/state', { cookie });
    expect(initial.json.reviews).toHaveLength(6);
    expect(initial.json.provider).toMatchObject({ kind: 'fake', apertus: false });

    // 2. The agent runs: every review is triaged, the urgent one first, nothing published.
    const run = await request('POST', '/api/agent/run', { cookie, body: {} });
    expect(run.json.ok).toBe(true);
    expect(run.json.summary).toMatchObject({ triaged: 6, drafted: 6, refused: [], skipped: [] });
    const urgent = run.json.reviews.find((r) => r.id === 'rev_002');
    expect(urgent).toMatchObject({ detectedLanguage: 'fr', triageCategory: 'urgent', replyStatus: 'drafted' });
    expect(new Set(run.json.reviews.map((r) => r.detectedLanguage))).toEqual(new Set(['de', 'fr', 'it', 'en']));
    expect(run.json.reviews.some((r) => r.replyStatus === 'published')).toBe(false);

    // 3-4. The draft is in the review's own language, with an English reason beside it.
    expect(urgent.draftReply).toMatch(/réaction allergique/);
    expect(urgent.draftRationale).toMatch(/owner/);

    // 5. The owner approves: published, and the log shows the draft and the publish apart.
    const approve = await invoke({ cookie }, 'publish_reply', { id: 'rev_002', draftVersion: urgent.draftVersion });
    expect(approve.json.ok).toBe(true);
    expect(approve.json.reviews.find((r) => r.id === 'rev_002')).toMatchObject({ replyStatus: 'published', publishedReply: urgent.draftReply });
    const forReview = approve.json.log.filter((e) => e.args && e.args.id === 'rev_002').map((e) => [e.actor, e.tool, e.result]);
    expect(forReview).toEqual([
      ['agent', 'draft_reply', 'drafted'],
      ['owner', 'publish_reply', 'published'],
    ]);
    expect(approve.json.reviews.filter((r) => r.replyStatus === 'published')).toHaveLength(1);

    // 6. A smuggled replyStatus is refused, logged, and changes nothing.
    const probe = await request('POST', '/api/probe/smuggle-status', { cookie, body: {} });
    expect(probe.json.ok).toBe(false);
    expect(probe.json.error.code).toBe('invalid_arguments');
    expect(probe.json.reviews.filter((r) => r.replyStatus === 'published')).toHaveLength(1);
    expect(probe.json.log.at(-1)).toMatchObject({ actor: 'agent', tool: 'draft_reply', outcome: 'refused' });

    const publishProbe = await request('POST', '/api/probe/publish-as-agent', { cookie, body: {} });
    expect(publishProbe.json.error.code).toBe('forbidden_actor');
    expect(publishProbe.json.reviews.filter((r) => r.replyStatus === 'published')).toHaveLength(1);
  });

  test('the owner can reject a draft over HTTP and the agent drafts again', async () => {
    const cookie = await ownerCookie();
    await request('POST', '/api/agent/run', { cookie, body: {} });
    const rejected = await invoke({ cookie }, 'reject_reply', { id: 'rev_001', reason: 'Too long for a short complaint' });
    expect(rejected.json.reviews.find((r) => r.id === 'rev_001').replyStatus).toBe('rejected');
    const again = await request('POST', '/api/agent/run', { cookie, body: {} });
    expect(again.json.summary.drafted).toBe(1);
  });

  test('a probe before triage says what to do first', async () => {
    const cookie = await ownerCookie();
    const probe = await request('POST', '/api/probe/smuggle-status', { cookie, body: {} });
    expect(probe.json.error.code).toBe('no_target');
  });
});

describe('start()', () => {
  test('boots on a free loopback port and prints a link that does not contain any LLM variable', async () => {
    const lines = [];
    const running = await start({ env: { PORT: '0' }, log: (line) => lines.push(line) });
    try {
      expect(running.server.address().address).toBe('127.0.0.1');
      expect(lines.join('\n')).toMatch(/\/session\?token=[0-9a-f]{48}/);
      expect(lines.join('\n')).toMatch(/not Apertus output/);
      expect(lines.join('\n')).toMatch(/OFFLINE FIXTURE PROVIDER/);
    } finally {
      await new Promise((resolve) => running.server.close(resolve));
    }
  });

  test('refuses to boot with a partial LLM configuration', async () => {
    await expect(start({ env: { LLM_API_KEY: 'k' }, log: () => {} })).rejects.toThrow(/set together or not at all/);
  });
});
