'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Refusal } = require('./errors');

const CATEGORIES = ['praise', 'complaint', 'urgent'];
const REPLY_STATUSES = ['unreviewed', 'drafted', 'rejected', 'published'];
const DEFAULT_SEED_PATH = path.join(__dirname, '..', 'data', 'seed-reviews.json');

// The fields a seed review must have. The README's "Try your own reviews" lists the same ones.
const SEED_FIELDS = ['id', 'source', 'originalText', 'rating', 'receivedAt'];

// The seed file is the one place reviews come from, and the README invites editing it, so a
// mistake in it is named here (file, item and field) rather than surfacing later as a crash.
function checkSeedReviews(items, file) {
  const name = path.basename(file);
  if (!Array.isArray(items) || items.length === 0) throw new Error(`${name} must be a JSON array with at least one review`);
  items.forEach((item, index) => {
    const where = `${name}, review ${index + 1}${item && typeof item.id === 'string' ? ` ("${item.id}")` : ''}`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where}: must be an object`);
    for (const field of ['id', 'source', 'originalText']) {
      if (typeof item[field] !== 'string' || item[field].trim() === '') throw new Error(`${where}: "${field}" must be a non-empty string`);
    }
    if (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5) throw new Error(`${where}: "rating" must be a whole number from 1 to 5`);
    if (typeof item.receivedAt !== 'string' || Number.isNaN(Date.parse(item.receivedAt))) {
      throw new Error(`${where}: "receivedAt" must be a date-time string such as 2026-10-03T08:12:00Z`);
    }
  });
  return items;
}

function loadSeedReviews(file = DEFAULT_SEED_PATH) {
  return checkSeedReviews(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}

function freshReview(seed) {
  return {
    id: seed.id,
    source: seed.source,
    originalText: seed.originalText,
    rating: seed.rating,
    receivedAt: seed.receivedAt,
    detectedLanguage: null,
    triageCategory: null,
    triageRationale: null,
    triagedAt: null,
    triageProvider: null,
    replyStatus: 'unreviewed',
    draftCategory: null,
    draftReply: null,
    draftRationale: null,
    draftedAt: null,
    draftVersion: 0,
    rejectionReason: null,
    publishedReply: null,
    publishedAt: null,
  };
}

/**
 * The in-memory review and activity store.
 *
 * It owns the reply-status state machine, so the rules hold no matter who calls it:
 *   unreviewed -> drafted -> published        (publish is the only way to 'published')
 *   drafted -> rejected -> drafted            (a rejected review can be drafted again)
 * Nothing outside this module assigns replyStatus. The tool handlers call these methods and
 * nothing else.
 */
function createStore({ seed = loadSeedReviews(), now = () => new Date().toISOString() } = {}) {
  const reviews = new Map();
  for (const item of seed) {
    if (reviews.has(item.id)) throw new Error(`duplicate review id in seed: ${item.id}`);
    reviews.set(item.id, freshReview(item));
  }
  const activity = [];

  function mustFind(id) {
    const review = reviews.get(id);
    if (!review) throw new Refusal('not_found', `no review with id "${id}"`);
    return review;
  }

  return {
    list({ replyStatus } = {}) {
      const all = [...reviews.values()];
      const selected = replyStatus ? all.filter((r) => r.replyStatus === replyStatus) : all;
      return structuredClone(selected);
    },

    get(id) {
      return structuredClone(mustFind(id));
    },

    // Records what triage found. Leaves replyStatus alone: a triaged review is still
    // waiting for a reply. Returns false if the review was already triaged, so two
    // overlapping triage runs cannot overwrite each other.
    applyTriage(id, { language, category, rationale, provider }) {
      const review = mustFind(id);
      if (review.triagedAt !== null) return false;
      review.detectedLanguage = language;
      review.triageCategory = category;
      review.triageRationale = rationale;
      review.triagedAt = now();
      review.triageProvider = provider;
      return true;
    },

    // Saves a proposed reply. The caller never chooses the status: a draft always lands on
    // 'drafted', and a published review cannot be drafted over.
    writeDraft(id, { category, reply, rationale }) {
      const review = mustFind(id);
      if (review.replyStatus === 'published') {
        throw new Refusal('already_published', `review "${id}" already has a published reply`);
      }
      review.draftCategory = category;
      review.draftReply = reply;
      review.draftRationale = rationale;
      review.draftedAt = now();
      review.draftVersion += 1;
      review.rejectionReason = null;
      review.replyStatus = 'drafted';
      return structuredClone(review);
    },

    // The one and only path to replyStatus 'published'. If `draftVersion` is given it must
    // match the current draft, so the owner publishes exactly the text they read.
    publish(id, { draftVersion } = {}) {
      const review = mustFind(id);
      if (review.replyStatus !== 'drafted' || review.draftReply === null) {
        throw new Refusal('no_draft', `review "${id}" has no draft waiting to be published`);
      }
      if (draftVersion !== undefined && draftVersion !== review.draftVersion) {
        throw new Refusal(
          'stale_draft',
          `the draft for "${id}" changed since it was read (now version ${review.draftVersion}); read it again before publishing`,
        );
      }
      review.publishedReply = review.draftReply;
      review.publishedAt = now();
      review.draftCategory = null;
      review.draftReply = null;
      review.draftRationale = null;
      review.draftedAt = null;
      review.replyStatus = 'published';
      return structuredClone(review);
    },

    reject(id, reason) {
      const review = mustFind(id);
      if (review.replyStatus !== 'drafted' || review.draftReply === null) {
        throw new Refusal('no_draft', `review "${id}" has no draft to reject`);
      }
      review.draftCategory = null;
      review.draftReply = null;
      review.draftRationale = null;
      review.draftedAt = null;
      review.rejectionReason = reason;
      review.replyStatus = 'rejected';
      return structuredClone(review);
    },

    appendLog(entry) {
      const stored = { seq: activity.length + 1, timestamp: now(), ...entry };
      activity.push(stored);
      return structuredClone(stored);
    },

    log() {
      return structuredClone(activity);
    },
  };
}

module.exports = { createStore, loadSeedReviews, SEED_FIELDS, CATEGORIES, REPLY_STATUSES };
