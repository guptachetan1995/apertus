'use strict';

// Just enough of JSON Schema to describe and enforce the tool arguments: a flat object with
// string / integer properties, enums, length bounds, required keys, and no extra keys.
// The same objects are served to agent clients as the tool input schemas, so what the
// model is told and what the server enforces cannot drift apart.

/**
 * Returns an array of problem strings; empty means the value satisfies the schema.
 * Extra keys are always a problem: a tool never silently ignores an argument it does not
 * define, because a silently ignored argument is how a smuggled field would slip through.
 */
function validate(schema, value) {
  const problems = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['arguments must be a JSON object'];
  }
  const properties = schema.properties || {};

  const hints = schema.argumentHints || {};
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      const hint = Object.prototype.hasOwnProperty.call(hints, key) ? ` (${hints[key]})` : '';
      problems.push(`unexpected argument "${key}"${hint}`);
    }
  }
  for (const key of schema.required || []) {
    if (value[key] === undefined) problems.push(`missing required argument "${key}"`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    const v = value[key];
    if (v === undefined) continue;
    if (spec.type === 'string') {
      if (typeof v !== 'string') {
        problems.push(`"${key}" must be a string`);
        continue;
      }
      const trimmed = v.trim();
      if (spec.minLength !== undefined && trimmed.length < spec.minLength) {
        problems.push(`"${key}" must be at least ${spec.minLength} characters`);
      }
      if (spec.maxLength !== undefined && v.length > spec.maxLength) {
        problems.push(`"${key}" must be at most ${spec.maxLength} characters`);
      }
      if (spec.enum && !spec.enum.includes(v)) {
        problems.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
      }
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(v)) {
        problems.push(`"${key}" must be an integer`);
      } else if (spec.minimum !== undefined && v < spec.minimum) {
        problems.push(`"${key}" must be at least ${spec.minimum}`);
      }
    }
  }
  return problems;
}

module.exports = { validate };
