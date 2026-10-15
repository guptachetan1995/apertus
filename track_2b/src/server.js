'use strict';

const path = require('node:path');
const express = require('express');
const { loadConfig, detectContainer, rewriteNotice } = require('./config');
const { createStore } = require('./store');
const { createProvider } = require('./providers');
const { createInvoke } = require('./invoke');
const { createAuth } = require('./auth');
const { runAgent } = require('./agent');
const { PROBES, runProbe } = require('./probes');

const COOKIE = 'review_owner';

// Printed whenever no model endpoint is configured, so nobody mistakes the canned fixture
// for a model. It is the authority: the Makefile's banner cannot see inside ENV_FILE.
const OFFLINE_BANNER = [
  '============================================================================',
  ' OFFLINE FIXTURE PROVIDER: no model endpoint is configured.',
  ' Every classification and reply on this server is canned, NOT Apertus output.',
  ' To use Apertus, set LLM_NAME, LLM_BASE_URL and LLM_API_KEY and restart.',
  '============================================================================',
];
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUS_FOR = {
  invalid_arguments: 400,
  invalid_actor: 403,
  forbidden_actor: 403,
  forged_actor: 403,
  unknown_tool: 404,
  not_found: 404,
  not_triaged: 409,
  no_draft: 409,
  already_published: 409,
  stale_draft: 409,
  no_target: 409,
  busy: 409,
  wrong_language: 422,
  language_unsupported: 422,
  provider_error: 502,
  internal_error: 500,
};

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

// Chrome and Firefox mark speculative loads with Sec-Purpose (older ones with Purpose or
// X-moz); a person opening a link sends none of them.
function isSpeculative(req) {
  const marks = [req.headers['sec-purpose'], req.headers.purpose, req.headers['x-moz']].filter(Boolean).join(' ');
  return /prefetch|prerender|preview/i.test(marks);
}

function fail(res, code, message, status = STATUS_FOR[code] || 400) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

/**
 * The HTTP face of the one chokepoint. Identity comes from credentials alone: an owner
 * session cookie or an agent bearer token. A request that says it is someone else is refused.
 */
function createApp({ store, provider, auth, publicDir = PUBLIC_DIR }) {
  const { invoke, describeTools, recordRefusal } = createInvoke({ store, provider });
  const app = express();
  app.disable('x-powered-by');
  let agentRunning = false;

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    // A browser that is already the owner (a reload, a second tab, a link opened again) goes
    // straight on; nothing is traded, so nothing is used up. So does a request the browser
    // marks as a prefetch or prerender: it is not a person opening the link, and it must not
    // use the link up.
    if (auth.isOwnerSession(readCookie(req, COOKIE))) return res.redirect(303, '/');
    if (isSpeculative(req)) return res.status(204).end();
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const session = auth.exchange(token);
    if (!session) {
      const message = auth.wasUsed(token)
        ? 'This link was already used: it works once, for the first browser that opens it. Restart `make run` (or `npm start`) to get a new link.'
        : 'This link is not valid. Use the link printed in the server log, or restart `make run` (or `npm start`) to get a new one.';
      return res.status(403).type('text/plain').send(message);
    }
    res.set('Set-Cookie', `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`);
    return res.redirect(303, '/');
  });

  app.use(express.static(publicDir, { index: 'index.html' }));

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // A browser request that names an origin must name this one.
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && origin !== `${req.protocol}://${req.headers.host}`) {
      return fail(res, 'forbidden_actor', 'cross-origin requests are not accepted', 403);
    }

    const authorization = req.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer (.+)$/.exec(authorization);
      req.actor = match && auth.isAgentToken(match[1]) ? 'agent' : null;
    } else {
      req.actor = auth.isOwnerSession(readCookie(req, COOKIE)) ? 'owner' : null;
    }
    if (!req.actor) {
      return fail(res, 'unauthenticated', 'no valid owner session or agent token was presented', 401);
    }
    return next();
  });

  const needOwner = (req, res, next) =>
    req.actor === 'owner' ? next() : fail(res, 'forbidden_actor', 'this needs the owner session', 403);

  const needJson = (req, res, next) =>
    req.is('application/json') ? next() : fail(res, 'invalid_arguments', 'send a JSON body with Content-Type: application/json', 415);

  const json = express.json({ limit: '32kb' });

  function snapshot() {
    return { reviews: store.list(), log: store.log() };
  }

  app.get('/api/tools', (req, res) => res.json({ ok: true, tools: describeTools(req.actor) }));

  app.get('/api/state', needOwner, (_req, res) =>
    res.json({
      ok: true,
      ...snapshot(),
      provider: provider.describe(),
      tools: describeTools('owner'),
      probes: PROBES,
    }),
  );

  app.post('/api/invoke', needJson, json, async (req, res) => {
    const { tool, args, actor: claimed } = req.body || {};
    if (claimed !== undefined && claimed !== req.actor) {
      recordRefusal({
        actor: req.actor,
        tool,
        args,
        code: 'forged_actor',
        message: `this credential is the ${req.actor}; it cannot act as "${String(claimed).slice(0, 30)}"`,
      });
      return fail(res, 'forged_actor', `this credential is the ${req.actor}; it cannot act as "${String(claimed).slice(0, 30)}"`);
    }
    const outcome = await invoke(tool, args, req.actor);
    if (!outcome.ok) return res.status(STATUS_FOR[outcome.error.code] || 400).json(outcome);
    return res.json({ ok: true, result: outcome.result, ...snapshot() });
  });

  app.post('/api/agent/run', needOwner, async (_req, res) => {
    if (agentRunning) return fail(res, 'busy', 'the agent is already running');
    agentRunning = true;
    try {
      const summary = await runAgent({ invoke, provider });
      return res.json({ ok: true, summary, ...snapshot() });
    } finally {
      agentRunning = false;
    }
  });

  app.post('/api/probe/:kind', needOwner, async (req, res) => {
    const outcome = await runProbe(req.params.kind, { invoke, store });
    // A probe is expected to be refused; the refusal is the answer, not an HTTP failure.
    return res.json({ ...outcome, ...snapshot() });
  });

  app.use('/api', (_req, res) => fail(res, 'unknown_tool', 'no such API route', 404));

  app.use((error, _req, res, _next) => {
    if (error && error.type === 'entity.parse.failed') return fail(res, 'invalid_arguments', 'the body is not valid JSON', 400);
    if (error && error.type === 'entity.too.large') return fail(res, 'invalid_arguments', 'the body is too large', 413);
    console.error('server error:', error);
    return fail(res, 'internal_error', 'the server hit an unexpected error', 500);
  });

  return app;
}

function displayHost(host) {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

async function start({ env = process.env, log = console.log, inContainer = detectContainer(env) } = {}) {
  const config = loadConfig(env, { inContainer });
  const provider = createProvider(config);
  const store = createStore();
  const auth = createAuth({ ownerToken: config.ownerToken, agentToken: config.agentToken });
  const server = await listen(createApp({ store, provider, auth }), config.port, config.host);

  const origin = config.publicOrigin || `http://${displayHost(config.host)}:${server.address().port}`;
  const about = provider.describe();
  log(`Review triage is listening on ${origin}`);
  if (config.llm && config.llm.rewrittenFrom) {
    log(rewriteNotice(config.llm.rewrittenFrom));
  }
  log(`Provider: ${about.endpointHost ? `${about.model} via ${about.endpointHost}` : `${about.model}. Offline, and not Apertus output.`}`);
  if (!about.endpointHost) for (const line of OFFLINE_BANNER) log(line);
  log(`Open the dashboard as the owner (single-use link): ${origin}/session?token=${auth.linkToken}`);
  log(`Agent bearer token for external clients: ${auth.agentToken}`);
  return { server, auth, store };
}

if (require.main === module) {
  start().then(({ server }) => {
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((error) => {
    console.error(`could not start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createApp, start, COOKIE };
