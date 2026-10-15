'use strict';

const { Refusal } = require('./errors');
const { validate } = require('./schema');
const { agentTools } = require('./tools');
const { ownerVerbs } = require('./owner-verbs');

const ACTORS = ['agent', 'owner'];
const MAX_LOGGED_STRING = 600;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// What goes in the activity log: the arguments as received, with long strings cut short so
// one oversized call cannot fill the log.
function loggableArgs(args) {
  if (args === undefined) return {};
  try {
    return JSON.parse(
      JSON.stringify(args, (_key, value) =>
        typeof value === 'string' && value.length > MAX_LOGGED_STRING
          ? `${value.slice(0, MAX_LOGGED_STRING)}…`
          : value,
      ),
    );
  } catch {
    return { _unloggable: true };
  }
}

/**
 * The one door. The dashboard, the HTTP API, the built-in agent and every test call this and
 * nothing else; there is no second path that changes a review.
 *
 * invoke(tool, args, actor) -> { ok: true, result } | { ok: false, error: { code, message } }
 *
 * The gate is here and in two other places that do not trust it:
 *   1. Resolution. A tool name is looked up in the agent registry first. The owner verbs are
 *      looked up only for the owner; to anyone else they are refused.
 *   2. Each owner verb checks the actor again inside its own handler.
 *   3. The store owns the reply-status state machine, so 'published' is unreachable except
 *      through its publish().
 * Every call, allowed or refused, is written to the activity log with its actor.
 */
function createInvoke({
  store,
  provider,
  tools = agentTools,
  verbs = ownerVerbs,
}) {
  function resolve(tool, actor) {
    if (!ACTORS.includes(actor)) {
      throw new Refusal('invalid_actor', 'the actor must be "agent" or "owner"');
    }
    if (typeof tool !== 'string') throw new Refusal('unknown_tool', 'the tool name must be a string');
    if (hasOwn(tools, tool)) return tools[tool];
    if (hasOwn(verbs, tool)) {
      if (actor !== 'owner') {
        throw new Refusal('forbidden_actor', `"${tool}" is not an agent tool; only the business owner can do it`);
      }
      return verbs[tool];
    }
    throw new Refusal('unknown_tool', `there is no tool called "${String(tool).slice(0, 60)}"`);
  }

  function record({ actor, tool, args, outcome, result, error, provider: via }) {
    const known = ACTORS.includes(actor);
    store.appendLog({
      actor: known ? actor : 'unknown',
      ...(known ? {} : { claimedActor: String(actor).slice(0, 40) }),
      tool: typeof tool === 'string' ? tool.slice(0, 60) : '(invalid)',
      args: loggableArgs(args),
      outcome,
      result,
      ...(error ? { error } : {}),
      ...(via ? { provider: via } : {}),
    });
  }

  async function invoke(tool, args, actor) {
    const callArgs = args === undefined ? {} : args;
    try {
      const entry = resolve(tool, actor);
      const problems = validate(entry.inputSchema, callArgs);
      if (problems.length > 0) {
        throw new Refusal('invalid_arguments', problems.join('; '));
      }
      const { result, summary } = await entry.handler(callArgs, { store, provider, actor });
      record({
        actor,
        tool,
        args: callArgs,
        outcome: 'ok',
        result: summary,
        provider: result && result.provider,
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof Refusal) {
        record({
          actor,
          tool,
          args: callArgs,
          outcome: 'refused',
          result: `refused: ${error.code}`,
          error: { code: error.code, message: error.message },
        });
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      console.error(`invoke: "${String(tool).slice(0, 60)}" failed inside the server:`, error);
      record({
        actor,
        tool,
        args: callArgs,
        outcome: 'error',
        result: 'error: internal_error',
        error: { code: 'internal_error', message: 'the call failed inside the server' },
      });
      return { ok: false, error: { code: 'internal_error', message: 'the call failed inside the server' } };
    }
  }

  // What a client is shown. An agent is shown only the agent registry; the owner verbs are
  // not listed to it, because to an agent they do not exist.
  function describeTools(actor) {
    const entries = [...Object.values(tools)];
    if (actor === 'owner') entries.push(...Object.values(verbs));
    return entries.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  // For refusals decided before a call ever reaches invoke (a forged actor at the HTTP edge).
  function recordRefusal({ actor, tool, args, code, message }) {
    record({
      actor,
      tool,
      args,
      outcome: 'refused',
      result: `refused: ${code}`,
      error: { code, message },
    });
  }

  return { invoke, describeTools, recordRefusal };
}

module.exports = { createInvoke, ACTORS };
