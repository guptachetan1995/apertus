'use strict';

// The owner's dashboard. Plain DOM, no build step. Review text is untrusted input from
// strangers, so everything is written with textContent; nothing here builds HTML from data.

const LANGUAGE_NAMES = { de: 'German', fr: 'French', it: 'Italian', en: 'English', und: 'Not confirmed' };
const RANK = { urgent: 0, complaint: 1, praise: 2 };

let state = null;
let rejecting = null;
let busy = false;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function badge(text, kind = '') {
  return el('span', { class: `badge ${kind}`.trim() }, text);
}

function time(iso) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '';
}

function setMessage(text, isError = false) {
  const node = document.getElementById('message');
  node.textContent = text;
  node.className = isError ? 'message error' : 'message';
}

async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({ ok: false, error: { code: 'bad_response', message: 'the server sent something unreadable' } }));
  return { status: response.status, data };
}

function absorb(data) {
  if (data && data.reviews) {
    state = { ...state, reviews: data.reviews, log: data.log };
  }
}

function sortedReviews() {
  const key = (review) => {
    if (review.replyStatus === 'published') return 10;
    const category = review.draftCategory || review.triageCategory;
    return category in RANK ? RANK[category] : 5;
  };
  return state.reviews
    .slice()
    .sort((a, b) => key(a) - key(b) || a.receivedAt.localeCompare(b.receivedAt));
}

function reviewColumn(review) {
  const category = review.triageCategory;
  return el(
    'div',
    { class: 'col' },
    el('h3', {}, 'Guest review'),
    el(
      'div',
      { class: 'meta' },
      el('span', {}, `${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} ${review.rating}/5`),
      review.detectedLanguage ? badge(LANGUAGE_NAMES[review.detectedLanguage] || review.detectedLanguage) : badge('Not triaged yet'),
      category ? badge(category, category) : null,
      el('span', {}, `${review.source}, ${time(review.receivedAt)}`),
    ),
    el('blockquote', { lang: review.detectedLanguage && review.detectedLanguage !== 'und' ? review.detectedLanguage : undefined }, review.originalText),
    review.triageRationale ? el('p', { class: 'why' }, el('strong', {}, 'Triage: '), review.triageRationale) : null,
  );
}

async function publish(review) {
  await act('publish_reply', { id: review.id, draftVersion: review.draftVersion }, 'Published.');
}

async function reject(review, reason) {
  rejecting = null;
  await act('reject_reply', { id: review.id, reason }, 'Draft rejected. Run the agent for a new one.');
}

function replyColumn(review) {
  const children = [el('h3', {}, 'Proposed reply')];

  if (review.replyStatus === 'published') {
    children.push(
      badge('Published', 'ok'),
      el('p', { class: 'reply', lang: review.detectedLanguage }, review.publishedReply),
      el('p', { class: 'why' }, `Published ${time(review.publishedAt)}.`),
    );
  } else if (review.replyStatus === 'drafted') {
    children.push(
      el('div', { class: 'meta' }, badge(`Draft ${review.draftVersion}`), badge(review.draftCategory, review.draftCategory), el('span', {}, `drafted ${time(review.draftedAt)}`)),
      el('p', { class: 'reply', lang: review.detectedLanguage }, review.draftReply),
      el('p', { class: 'why' }, el('strong', {}, 'Why (English): '), review.draftRationale),
    );
    if (rejecting === review.id) {
      const input = el('input', { type: 'text', 'aria-label': 'Reason for rejecting this draft', placeholder: 'Reason for rejecting', maxlength: '300' });
      children.push(
        el(
          'div',
          { class: 'actions' },
          input,
          el('button', { type: 'button', on: { click: () => (input.value.trim().length >= 3 ? reject(review, input.value) : setMessage('Give a reason of at least three characters.', true)) } }, 'Confirm reject'),
          el('button', { type: 'button', on: { click: () => { rejecting = null; render(); } } }, 'Cancel'),
        ),
      );
    } else {
      children.push(
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'button', class: 'primary', on: { click: () => publish(review) } }, 'Approve and publish'),
          el('button', { type: 'button', on: { click: () => { rejecting = review.id; render(); } } }, 'Reject'),
        ),
      );
    }
  } else if (review.replyStatus === 'rejected') {
    children.push(
      el('p', { class: 'empty' }, 'Draft rejected. Waiting for a new one.'),
      review.rejectionReason ? el('p', { class: 'why' }, el('strong', {}, 'Your reason: '), review.rejectionReason) : null,
    );
  } else if (review.triagedAt === null) {
    children.push(el('p', { class: 'empty' }, 'Waiting for the agent to triage this review.'));
  } else if (review.detectedLanguage === 'und') {
    children.push(el('p', { class: 'empty' }, 'The language could not be confirmed, so no reply is drafted. This one is yours to answer.'));
  } else {
    children.push(el('p', { class: 'empty' }, 'Triaged. Waiting for the agent to draft a reply.'));
  }
  return el('div', { class: 'col' }, children);
}

function renderReviews() {
  const container = document.getElementById('reviews');
  container.replaceChildren(
    ...sortedReviews().map((review) =>
      el(
        'article',
        { class: `card ${review.triageCategory === 'urgent' && review.replyStatus !== 'published' ? 'urgent' : ''}`.trim(), 'aria-label': `Review ${review.id}` },
        el('div', { class: 'card-grid' }, reviewColumn(review), replyColumn(review)),
      ),
    ),
  );
}

function logDetails(entry) {
  const parts = [];
  const { args } = entry;
  if (args && typeof args.id === 'string') parts.push(args.id);
  if (args && typeof args.reason === 'string') parts.push(`reason: ${args.reason}`);
  if (args && args.replyStatus !== undefined) parts.push(`tried replyStatus: ${String(args.replyStatus)}`);
  if (entry.claimedActor) parts.push(`claimed to be "${entry.claimedActor}"`);
  if (entry.error) parts.push(entry.error.message);
  if (entry.provider) parts.push(`via ${entry.provider.model}`);
  return parts.join(' | ');
}

function renderLog() {
  const body = document.getElementById('log');
  body.replaceChildren(
    ...state.log
      .slice()
      .reverse()
      .map((entry) =>
        el(
          'tr',
          {},
          el('td', { class: 'nowrap' }, time(entry.timestamp)),
          el('td', {}, badge(entry.actor)),
          el('td', {}, el('code', {}, entry.tool)),
          el('td', {}, badge(entry.result, entry.outcome)),
          el('td', { class: 'details' }, logDetails(entry)),
        ),
      ),
  );
}

function renderProvider() {
  const node = document.getElementById('provider');
  const { provider } = state;
  if (provider.kind === 'fake') {
    node.textContent = 'Offline fixture provider: canned output, not Apertus.';
  } else if (provider.apertus) {
    node.textContent = `Model: ${provider.model} via ${provider.endpointHost}`;
  } else {
    node.textContent = `Model: ${provider.model} via ${provider.endpointHost}. The model name does not say Apertus.`;
  }
  node.className = provider.apertus ? 'provider' : 'provider offline';
}

function render() {
  renderProvider();
  renderReviews();
  renderLog();
  for (const button of document.querySelectorAll('button[data-probe], #run-agent')) button.disabled = busy;
}

async function act(tool, args, successText) {
  if (busy) return;
  busy = true;
  render();
  const { data } = await call('POST', '/api/invoke', { tool, args });
  busy = false;
  if (data.ok) {
    absorb(data);
    setMessage(successText);
  } else {
    setMessage(`Refused (${data.error.code}): ${data.error.message}`, true);
    await refresh();
  }
  render();
}

async function runAgent() {
  if (busy) return;
  busy = true;
  setMessage('The agent is working...');
  render();
  const { data } = await call('POST', '/api/agent/run');
  busy = false;
  if (data.ok) {
    absorb(data);
    const { summary } = data;
    const refusals = summary.refused.length ? `, ${summary.refused.length} draft(s) refused by the server` : '';
    const skips = summary.skipped.length ? `, ${summary.skipped.length} left for you` : '';
    setMessage(`Triaged ${summary.triaged}, drafted ${summary.drafted}${refusals}${skips}. Nothing is published.`);
  } else {
    setMessage(`The agent could not run (${data.error.code}): ${data.error.message}`, true);
  }
  render();
}

async function probe(kind) {
  if (busy) return;
  busy = true;
  render();
  const { data } = await call('POST', `/api/probe/${kind}`);
  busy = false;
  absorb(data);
  setMessage(
    data.ok
      ? 'Unexpected: the probe was not refused.'
      : `Refused as it should be (${data.error.code}): ${data.error.message}`,
    data.ok,
  );
  render();
}

async function refresh() {
  const { status, data } = await call('GET', '/api/state');
  if (status === 401 || status === 403) {
    document.getElementById('signin').hidden = false;
    document.getElementById('desk').hidden = true;
    return false;
  }
  state = data;
  document.getElementById('signin').hidden = true;
  document.getElementById('desk').hidden = false;
  return true;
}

async function main() {
  document.getElementById('run-agent').addEventListener('click', runAgent);
  for (const button of document.querySelectorAll('button[data-probe]')) {
    button.addEventListener('click', () => probe(button.dataset.probe));
  }
  if (await refresh()) render();
}

main();
