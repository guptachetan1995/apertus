'use strict';

const crypto = require('node:crypto');

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Who is calling. There are exactly two kinds of caller and they have separate credentials:
 *
 *   owner  a browser session. It starts from a one-time link printed in the server log
 *          (GET /session?token=...), which trades the token for a random session cookie and
 *          cannot be used a second time. (A request that already carries a valid session
 *          cookie is sent on to the dashboard and trades nothing, so a reload or a second tab
 *          of the same browser does not need a new link.)
 *   agent  a bearer token for external agent clients. The built-in agent needs none: it
 *          calls invoke() inside the process.
 *
 * The caller's identity comes only from these credentials, never from anything the request
 * claims about itself.
 */
function createAuth({ ownerToken, agentToken } = {}) {
  const linkToken = ownerToken || randomToken();
  const bearer = agentToken || randomToken();
  const sessions = new Set();
  let linkUsed = false;

  return {
    linkToken,
    agentToken: bearer,

    // Trades the one-time link token for a session id, once. Returns null otherwise.
    exchange(token) {
      if (linkUsed || !safeEqual(token, linkToken)) return null;
      linkUsed = true;
      const session = randomToken();
      sessions.add(session);
      return session;
    },

    // True when this is the link's own token and the link has already been traded. A wrong
    // token is not "used": it was never the link.
    wasUsed(token) {
      return linkUsed && safeEqual(token, linkToken);
    },

    isOwnerSession(session) {
      return typeof session === 'string' && sessions.has(session);
    },

    isAgentToken(token) {
      return safeEqual(token, bearer);
    },
  };
}

module.exports = { createAuth };
