'use strict';

const http = require('node:http');
const fixtures = require('../data/fake-provider-fixtures.json');

function completion(content) {
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

/**
 * A local stand-in for an OpenAI-compatible chat endpoint. `respond(request, n)` gets the
 * parsed request and its 1-based sequence number and returns one of:
 *   a string                        -> a 200 chat completion carrying that string
 *   { status, body }                -> that status with that body (an object is sent as JSON)
 *   { hang: true }                  -> never answers
 *   { raw }                         -> a 200 with that raw text as the body
 */
async function startStub(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const request = { method: req.method, url: req.url, headers: req.headers, text, body };
      requests.push(request);
      const answer = respond(request, requests.length);
      if (answer && answer.hang) return;
      if (typeof answer === 'string') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(completion(answer)));
      }
      if (answer && answer.raw !== undefined) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(answer.raw);
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      return res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// The text of the review inside a request's user message, and what the call is for.
function readRequest(request) {
  const [system, user] = request.body.messages;
  const review = /<<<REVIEW\n([\s\S]*?)\nREVIEW>>>/.exec(user.content);
  return {
    kind: system.content.includes('triage customer reviews') ? 'classify' : 'draft',
    text: review ? review[1] : '',
    user: user.content,
  };
}

// A well-behaved model: it answers the seeded reviews from the fixture file, as JSON.
function competentModel(request) {
  const { kind, text } = readRequest(request);
  const seeds = require('../data/seed-reviews.json');
  const seed = seeds.find((item) => item.originalText === text);
  const canned = seed && fixtures.byId[seed.id];
  if (!canned) return { status: 422, body: { error: { message: 'stub model only knows the seeded reviews' } } };
  return JSON.stringify(
    kind === 'classify'
      ? { language: canned.language, category: canned.category, rationale: canned.triageRationale }
      : { reply: canned.reply, rationale: canned.draftRationale },
  );
}

module.exports = { startStub, completion, readRequest, competentModel };
