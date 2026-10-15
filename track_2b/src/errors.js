'use strict';

// A refusal is an expected, explained "no" (bad arguments, wrong actor, a state that does
// not allow the move). It is logged and returned to the caller; it is never a crash.
class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
  }
}

module.exports = { Refusal };
