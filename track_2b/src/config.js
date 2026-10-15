'use strict';

const fs = require('node:fs');
const { parseEnv } = require('node:util');

// The report PDF the organisers ask for is named <TeamName>_Report.pdf, and this constant is
// the one place that name is built. Letters, digits, "_" and "-" only (no spaces): the display
// name is "Chetan Gupta". After changing it, run `npm run report:fill`.
const TEAM_NAME = 'ChetanGupta';
const REPORT_PDF = `${TEAM_NAME}_Report.pdf`;

const LLM_VARS = ['LLM_NAME', 'LLM_BASE_URL', 'LLM_API_KEY'];
const DEFAULT_LLM_TIMEOUT_MS = 60000;

// Inside a container, "localhost" is the container itself. The Makefile maps this name to the
// host (--add-host host.docker.internal:host-gateway), so a model server on the host is
// reached through it.
const CONTAINER_HOST = 'host.docker.internal';

function readToken(name, raw) {
  if (raw === undefined || raw === '') return null;
  if (raw.length < 16) throw new Error(`${name} must be at least 16 characters`);
  return raw;
}

function readTimeoutMs(raw) {
  if (raw === undefined || raw === '') return DEFAULT_LLM_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 100 || ms > 600000) {
    throw new Error(`LLM_TIMEOUT_MS must be an integer between 100 and 600000, got "${raw}"`);
  }
  return ms;
}

// The endpoint is taken as given, but it has to be a plain http(s) address with no
// credentials in it: a key belongs in LLM_API_KEY, and an address with a password in it
// would end up in logs and provenance records. The message never echoes the value.
function checkBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LLM_BASE_URL is not a valid URL (expected something like https://host/v1)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('LLM_BASE_URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('LLM_BASE_URL must not contain a user name or password; use LLM_API_KEY for the key');
  }
  return raw;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    host === '[::]' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// The Dockerfile sets APERTUS_IN_CONTAINER=1; /.dockerenv (Docker) and /run/.containerenv
// (Podman) cover an image started some other way.
function detectContainer(env = process.env, exists = fs.existsSync) {
  return env.APERTUS_IN_CONTAINER === '1' || exists('/.dockerenv') || exists('/run/.containerenv');
}

// Inside a container, a loopback endpoint can never be the model server the person meant, so
// it is pointed at the host instead. Returns the new address and the host name it replaced.
function toContainerHost(baseUrl) {
  const url = new URL(baseUrl);
  if (!isLoopbackHost(url.hostname)) return { baseUrl, rewrittenFrom: null };
  const rewrittenFrom = url.hostname;
  url.hostname = CONTAINER_HOST;
  return { baseUrl: url.href, rewrittenFrom };
}

function rewriteNotice(rewrittenFrom) {
  return `LLM_BASE_URL names ${rewrittenFrom}, which inside a container is the container itself: using ${CONTAINER_HOST} to reach the host instead. If the host server cannot be reached, make it listen on 0.0.0.0 (on Linux a server bound only to 127.0.0.1 cannot be reached from a container).`;
}

function readPort(raw) {
  if (raw === undefined || raw === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

// Keys can arrive by path instead of by value: ENV_FILE names a file of KEY=value lines, which
// is read here and never copied anywhere else. Variables set in the real environment win.
function withEnvFile(env) {
  if (!env.ENV_FILE) return env;
  let text;
  try {
    text = fs.readFileSync(env.ENV_FILE, 'utf8');
  } catch (error) {
    throw new Error(`ENV_FILE "${env.ENV_FILE}" could not be read (${error.code})`, { cause: error });
  }
  return { ...parseEnv(text), ...env };
}

/**
 * Reads the environment once. The LLM trio is all-or-nothing: with none of it set the app
 * runs offline on the fixture provider; with all of it set it talks to that
 * OpenAI-compatible endpoint; a partial set is a mistake worth failing on at boot.
 * LLM_TIMEOUT_MS (optional) is the per-request timeout. The API key is held here and never
 * copied into anything that gets logged or served. With `inContainer` set (the server passes
 * detectContainer()), a loopback LLM_BASE_URL is rewritten to host.docker.internal and
 * `llm.rewrittenFrom` names the host it replaced.
 */
function loadConfig(rawEnv = process.env, { inContainer = false } = {}) {
  const env = withEnvFile(rawEnv);
  const present = LLM_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
  if (present.length !== 0 && present.length !== LLM_VARS.length) {
    const missing = LLM_VARS.filter((name) => !present.includes(name));
    throw new Error(
      `LLM_NAME, LLM_BASE_URL and LLM_API_KEY are set together or not at all; missing: ${missing.join(', ')}`,
    );
  }
  let llm = null;
  if (present.length !== 0) {
    llm = {
      name: env.LLM_NAME,
      baseUrl: checkBaseUrl(env.LLM_BASE_URL),
      apiKey: env.LLM_API_KEY,
      timeoutMs: readTimeoutMs(env.LLM_TIMEOUT_MS),
    };
    if (inContainer) {
      const { baseUrl, rewrittenFrom } = toContainerHost(llm.baseUrl);
      if (rewrittenFrom) llm = { ...llm, baseUrl, rewrittenFrom };
    }
  }

  return {
    host: env.HOST || '127.0.0.1',
    port: readPort(env.PORT),
    llm,
    publicOrigin: env.PUBLIC_ORIGIN || null,
    ownerToken: readToken('OWNER_TOKEN', env.OWNER_TOKEN),
    agentToken: readToken('AGENT_TOKEN', env.AGENT_TOKEN),
  };
}

module.exports = { TEAM_NAME, REPORT_PDF, LLM_VARS, CONTAINER_HOST, isLoopbackHost, detectContainer, rewriteNotice, loadConfig };
