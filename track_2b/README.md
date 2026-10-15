# Multilingual Review-Reply Triage

A public reply to a customer review is the business talking, in its own name, to a stranger, in
whatever language the review was written in, and it stays visible indefinitely. This project
treats that as a decision a model does not get to make alone. An agent reads each review in
German, French, Italian or English, classifies it as praise, a complaint or urgent, and drafts a
reply in that same language with a rationale in English for the owner. Nothing is posted until
the owner reads the original, the draft and the rationale side by side and clicks **Approve**.
Drafting is free; publishing is the one action that is never registered as a tool an agent can
call.

Built for [Hack Apertus](https://hackapertus.ch/online-hack), Track 2B (Own Project), for
[Apertus v1.5](https://huggingface.co/swiss-ai/Apertus-v1.5-8B), Switzerland's open-weight model.
The whole thing is one container that talks to one model endpoint you choose, so it can run on
your own hardware with nothing leaving the building.

<!-- generated:status:start -->
**Status: a proof of concept, built and tested, not yet run against Apertus.** The core, the
approval gate, the dashboard, a client for any OpenAI-compatible endpoint (tested against a local
stub server) and an evaluation harness with a 53-review labelled set are in place. No result in
this repository has been produced by Apertus yet: the only evaluation result is the offline
fixture's, and its file says so. Every result records the model, endpoint host and date that
produced it, and the dashboard says which provider is answering.
<!-- generated:status:end -->

The Docker image was built and
run on 15 Oct 2026 (Docker Desktop, Apple silicon) by running the Makefile's own `docker build` and
`docker run` commands by hand, from a clean copy of the repository, on the offline fixture
provider: it became healthy and served the whole demo flow as an unprivileged user on a read-only
filesystem. On 16 Oct 2026 GNU Make 3.81 works on the author's machine: `make -n run` printed the
expected commands, `make test` (lint and the tests) passed from this directory and from the
repository root, and **`make run` was run on 16 Oct 2026 from a clean copy (`git archive` of the
branch) on the fixture provider**: the image built, became healthy as the `node` user on a
read-only filesystem with every capability dropped, and served the demo flow over HTTP on
127.0.0.1 (owner link, run the agent, publish by the owner, the agent's publish refused as
`forbidden_actor`, a forged owner refused as `forged_actor`). A second `make run` with
`LLM_BASE_URL=http://localhost:<port>/v1` pointing at a stub model server on the host logged the
rewrite to `host.docker.internal` and got all 6 reviews triaged and drafted from the stub.

## Quick start

Needs `make` and Docker. Nothing else is installed on the host.

```bash
make run        # from the repository root or from this directory
```

It builds the image (the only step that uses the network: the base image and Express from npm),
then starts the container. With no model configured it runs on an **offline fixture provider**
(canned answers, no network) and prints a banner saying so. The log then prints a single-use
owner link, such as `http://localhost:3000/session?token=...`. Open it in a browser: it trades
the token for an owner session cookie, and only the first browser to open it gets one. Opening the
link again in the browser that holds the cookie (a reload, a second tab) just goes to the
dashboard; a browser without the cookie is refused with "already used", and `make run` again
prints a new link. Press **Run the agent**, read a draft beside its original, and approve one. The
log also prints a bearer token for external agent clients.

Without Docker (Node.js 24 or newer): `npm ci && npm start`.

`make run` options: `PORT=3100` for another port; `BIND=0.0.0.0` to publish on every interface
(the default is the host's loopback only); `ENV_FILE=path` to read the model settings from a file.

Two things to know when you point it at a model:

- **A model server on the same machine.** Inside the container `localhost` is the container
  itself. If `LLM_BASE_URL` names `localhost`, `127.0.0.1` or `[::1]`, the server notices it is in
  a container (the image sets `APERTUS_IN_CONTAINER=1`), uses `host.docker.internal` (which `make
  run` maps to the host) in its place and prints one startup line saying so. On Docker Desktop for
  Mac (Apple silicon, 16 Oct 2026) this reached a stub server on the host that listened only on
  `127.0.0.1`. On Linux a host server bound only to `127.0.0.1` is not reachable from a
  container (not run here): make it listen on `0.0.0.0`; the error text says so. Outside Docker
  (`npm start`) nothing is rewritten.
- **Slow hardware.** `LLM_TIMEOUT_MS` defaults to 60000 (60 s per request, one retry). An 8B model
  on a CPU can need longer, so set for example `LLM_TIMEOUT_MS=300000`.

## What the agent does, and what only the owner does

| | Agent | Owner (dashboard) |
|---|---|---|
| Read reviews | yes | yes |
| Detect the language, classify as praise, complaint or urgent | yes | yes |
| Draft a reply in the review's own language | yes | yes |
| Publish a reply publicly | **never** | `publish_reply`, one review at a time |
| Reject a draft, with a reason | **never** | `reject_reply` |

Every call, from the dashboard, the HTTP API or the built-in agent, goes through one function,
`invoke(tool, args, actor)` in `src/invoke.js`. There is no second path that changes a review.

| Tool | Who | What it does |
|---|---|---|
| `list_reviews` | agent, owner | Returns the reviews, optionally filtered by reply status |
| `triage_reviews` | agent, owner | Detects the language of, and classifies, every review not yet triaged. Writes no reply |
| `draft_reply` | agent, owner | Saves a draft. Refuses a reply that is not in the review's own language, an unknown id, an untriaged or already-published review, and any extra argument, including `replyStatus` |
| `get_review` | agent, owner | Returns one full record |
| `publish_reply` | **owner only** | Publishes the current draft of one review. Takes the draft version the owner read, so it publishes exactly that text |
| `reject_reply` | **owner only** | Throws the draft away and records why |

The full descriptions, written for a client that cannot see the screen, are in `src/tools.js`
and `src/owner-verbs.js`, and are served at `GET /api/tools`.

### Why an agent cannot publish

1. **`publish_reply` and `reject_reply` are never registered as a tool.** The agent registry
   (`src/tools.js`) holds four tools. The two owner verbs live in a different module and are
   resolved by `invoke()` for the owner alone; an agent is not even shown them.
2. **Each owner verb checks the actor again** inside its own handler.
3. **The store owns the reply-status state machine** (`src/store.js`):
   `unreviewed -> drafted -> published`, and `drafted -> rejected -> drafted`. `published` is
   reachable only through its `publish()`, so no handler can set it by accident.

Identity is never taken from what a request says about itself. The owner is a browser session
cookie; an agent is a bearer token; a request that names a different actor than its credential
proves is refused as `forged_actor`, logged, and changes nothing. Every call, allowed or refused,
is written to the activity log with its actor. `tests/gate-contract.js` states the gate once and
runs it against the real chokepoint and against a deliberately broken one, so the check itself is
shown to fail when the gate is removed.

### HTTP API

`GET /api/tools` lists the tools a credential may use, with their descriptions and input
schemas. `POST /api/invoke` takes `{ "tool": "...", "args": { ... } }` and returns the result
with the updated reviews and log. For an external agent client:

```bash
curl -s -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"tool":"list_reviews","args":{}}' http://localhost:3000/api/invoke
```

## Run it against Apertus

The app needs an OpenAI-compatible chat endpoint serving Apertus v1.5 (8B or 70B), named by three
environment variables, which are the ones the organisers' template defines:

| Variable | Meaning |
|---|---|
| `LLM_NAME` | The model name exactly as the endpoint lists it for Apertus v1.5 (the Public AI Gateway lists `swiss-ai/apertus-v1.5-8b` and `swiss-ai/apertus-v1.5-70b`) |
| `LLM_BASE_URL` | Base URL of an OpenAI-compatible chat endpoint, such as `https://api.publicai.co/v1` |
| `LLM_API_KEY` | Its API key. Read from the environment only; never committed, logged or served. A server that needs no key still needs a non-empty placeholder |
| `LLM_TIMEOUT_MS` | Optional. Per-request timeout in milliseconds (default 60000, range 100 to 600000) |

The three are set together or not at all. Set none and the app runs offline on the fixture. Set
only some and `make run` stops before it builds, naming what is missing. There is no quiet
fallback from a configured endpoint to the fixture: a run that claims a model must have used one.
The dashboard banner and the server log name the provider, and each triaged review records which
one triaged it.

Where the key comes from is up to you; the code treats all of them the same:

- **The CSCS inference API**, with the team key the organisers issue.
- **The Public AI Gateway** (`https://api.publicai.co/v1`), with a key from that service. Its
  developer portal (platform.publicai.co, read 16 Oct 2026) requires a `User-Agent` header, which
  this client sends (`hack-apertus-review-triage/0.1`), lists the models `swiss-ai/apertus-v1.5-8b`
  and `swiss-ai/apertus-v1.5-70b` (and `-thinking` variants, which this client does not handle:
  it reads only the answer, not a reasoning trace), and gives new accounts a small starter credit.
  It is a third-party service: every review sent through it leaves your network.
- **Your own server**, which is the declared deployment: any server that serves
  `/chat/completions` with Apertus weights you host. The Apertus project's guide
  (`content/docs/guides/vllm.md` in <https://github.com/swiss-ai/www-apertus>, read 16 Oct 2026)
  says Apertus 1.5 is not yet in upstream vLLM or transformers: use the project's vLLM fork or its
  prebuilt image `ghcr.io/swiss-ai/vllm_apertus_1.5_release`, started as `vllm serve
  swiss-ai/Apertus-v1.5-8B --chat-template-content-format string --max-model-len ...`. That
  guide's `--enable-auto-tool-choice --tool-call-parser apertus` flags are for tool calling, which
  this client does not use (it asks for JSON in plain chat completions). I have not run that
  server; the instructions are the project's, not tested here. The weights are gated on Hugging
  Face (see the technical report), so an account with access is needed on the model host.
  If the server runs on the same machine as `make run`, use `http://host.docker.internal:8000/v1`
  or just `http://localhost:8000/v1` (see Quick start). The address rewrite is covered by tests and
  was run in the container against a stub on the host; no real model server has been reached from
  the container.

Keep the key out of the shell history and out of this directory: put the three lines in a file
outside the repository (a copy of `.env.example`, one `KEY=value` per line, no quotes) and name it:

```bash
make run ENV_FILE=$HOME/apertus.env     # the container
ENV_FILE=$HOME/apertus.env npm start    # without Docker
```

Variables exported in your shell work too: `make` passes `LLM_NAME`, `LLM_BASE_URL` and
`LLM_API_KEY` to the container by name, so the value is never written into a file, an image layer
or a command line.

The client asks for JSON, validates it, and retries once, with the problem spelled out, when the
answer is malformed, out of range, or a reply in the wrong language; a timeout, connection error,
429 or 5xx also gets one retry, other HTTP errors none. A reply that stays in the wrong language
is handed to `draft_reply`, which refuses it and logs the refusal, exactly as for the fixture. The
key is sent only in the `Authorization` header and is scrubbed from every error message.

| Other variable | Meaning |
|---|---|
| `HOST`, `PORT` | Listen address (default `127.0.0.1:3000`; the container listens on all interfaces but `make run` publishes the port on the host's loopback only) |
| `ENV_FILE` | A file of `KEY=value` lines read at start (see `.env.example`). Variables already in the environment win |
| `PUBLIC_ORIGIN` | The address printed in the log (`make run` sets it to the published port) |
| `OWNER_TOKEN`, `AGENT_TOKEN` | Optional fixed tokens (16 characters or more) instead of random ones |

## Target architecture

**Declared target: on-premise**, and **air-gapped** when the network the container and the model
server share has no route out. The organisation runs this container and a self-hosted Apertus
server on its own hardware; `LLM_BASE_URL` names that server, so review text never leaves the
organisation. A Swiss sovereign cloud is the same container with a different `LLM_BASE_URL`; it
is a configuration, and it is not what is declared here. The technical report separates build
time from runtime and lists every external service in full.

| Phase | Contacts | Data it carries |
|---|---|---|
| Build, image | Docker registry (base image `node:24.21.0-bookworm-slim`, pinned by digest); npm registry (`npm ci --omit=dev`) | Package downloads only |
| Build, model (on the model host, not in this image) | Wherever the weights are fetched from, once | The model weights |
| Runtime, no `LLM_*` set | Nothing | Nothing leaves the container |
| Runtime, self-hosted model | The model server on the deployment's own network | Review text, star rating, the classification and reply instructions |

**External services the running solution contacts: none**, as long as `LLM_BASE_URL` is a server
inside the deployment. No analytics, telemetry, CDN or font; the dashboard loads only its own
files, which a content security policy enforces. For an air-gapped site, build the image
elsewhere, move it with `docker save` and `docker load`, and copy the weights as files.

The container: one Node.js 24 process on a pinned Debian-slim image, run as the unprivileged
`node` user with a read-only filesystem, every Linux capability dropped, `no-new-privileges`, an
init process, a health check, and the port published on loopback only. It holds no secret: the
image sets no `LLM_*` variable, and its build context leaves out env files, tests and documents.
The image copies only `src/` and the two data files the server reads.

![Architecture](docs/architecture.svg)

## Evaluation

```bash
npm run eval                                    # the fixture, or whichever endpoint LLM_* / ENV_FILE names
ENV_FILE=$HOME/apertus.env npm run eval         # a real endpoint, key read from the file
npm run eval -- --limit 5 --out /tmp/try.json   # a quick smoke run that leaves the committed result alone
make eval ENV_FILE=$HOME/apertus.env            # the same, through make
```

The harness runs the app's own pipeline (triage, then draft, through `invoke()` as the agent) over
`data/eval-set.json`: 53 fictional reviews in German, French, Italian and English, plus Swiss
German, Romansh, code-switched, very short, mixed, rating-contradicting and instruction-bearing
ones, each with a gold category and language. It reports category accuracy, urgent recall,
language accuracy, reply-language compliance (as read by the server's own check) and latency per
call, and writes `data/eval-results.json` with provenance: provider kind, model name, endpoint
host, date, and the SHA-256 of the evaluation set. A fixture run will not overwrite a result that
came from a real endpoint.

<!-- generated:evaluation-note:start -->
The committed `data/eval-results.json` is the fixture's. It is labelled as not an Apertus result,
and it is not one.
<!-- generated:evaluation-note:end -->

## Demo walkthrough

1. The dashboard lists six fictional reviews in German, French, Italian and English.
2. **Run the agent**: every review gets a language and a category; the urgent one (an allergic
   reaction) is flagged first.
3. The agent drafts a reply for each, in the review's language, with a reason in English.
4. Read the original beside the draft and the reason; **Approve and publish** one. The log shows
   the draft (agent) and the publish (owner) as separate entries.
5. **Gate probes**: the agent tries to smuggle `replyStatus: published` into `draft_reply`, and
   tries to call `publish_reply`. Both are refused by the same chokepoint, logged, and the review
   stays unpublished.

## Try your own reviews

The dashboard starts from the six fictional reviews in `data/seed-reviews.json`. To use your
own, edit that file: a JSON array of objects with exactly these fields, `id` (unique text),
`source` (where the review came from, free text), `originalText` (the review),
`rating` (a whole number from 1 to 5) and `receivedAt` (a date-time such as
`2026-10-03T08:12:00Z`). A mistake is reported at start-up with the file, the review and the field.
The seed file is copied into the image, so run `make run` again to rebuild it (or `npm start`
without Docker). Do not edit `data/eval-set.json`: the evaluation results record its SHA-256, and
that is what ties a result to the exact set it ran on. Use real customer reviews only if you are
allowed to; this repository's data is fictional.

## Limitations

<!-- generated:limits:start -->
- Nothing in this repository has been produced by Apertus yet. The client is tested against a
  local stub server, and the evaluation harness is ready to run against a real endpoint.
<!-- generated:limits:end -->
- `make run` was run once, on 16 Oct 2026 from a clean copy, on the fixture provider and against a
  stub model server on the host (see Status). It has not been run with a real Apertus endpoint, or
  on Linux or Windows.
- **Reviews come only from the seed file, and nothing is posted to any platform.** The six
  reviews are read from `data/seed-reviews.json` at start-up; no review is fetched from Google,
  Tripadvisor, Booking.com or any other platform. "Publish" flips an in-memory status to
  `published` and keeps the approved text in that review's record in memory; it does not post
  the reply anywhere. A real integration is **not built**: the obvious path is the Google Business Profile
  API (import the location's reviews, post the approved reply with its reply call), with
  the same `invoke()` chokepoint in front of it, so the owner's click would call the platform's
  reply endpoint instead of only changing a status.
- The language check understands four languages. A review in another language, or one too short
  to call, is left for the owner, never answered by the agent (3 of the 53 evaluation reviews end
  up this way, and the two Romansh ones are misread as Italian).
- State is in memory: a restart starts from the seed again.
- There is one owner and no sign-in beyond the single-use link; this is a prototype for one
  person on one machine.
- A review is untrusted text. It cannot make the agent publish, because the agent cannot, but it
  can still try to steer a draft; the owner reads every draft before it goes out.

## Develop

```bash
npm ci               # install from the lockfile
npm test             # Jest, including the packaging tests (no Docker needed)
npm run lint         # ESLint
npm run eval         # evaluation harness (see above)
npm run report:fill  # after a new eval run or a TEAM_NAME change: rewrite the generated parts of the README and report
npm run report:pdf   # technical_report.md -> the report PDF, at most 6 pages
../verify.sh         # structure, container and licence checks, secret scan, lint, tests
make test            # lint and tests through make
```

`make` is used for `run`, `build`, `test` and `eval`; the commands above need Node.js 24 or newer
(and an installed Chrome for `report:pdf` only). Report PDF for submission: <!-- generated:team-pdf:start -->`ChetanGupta_Report.pdf`<!-- generated:team-pdf:end --> in this directory. The team name ("Chetan Gupta") is the one constant `TEAM_NAME` in `src/config.js`, in the file-safe form without a space; to change it, change that line and run `npm run report:fill`, which copies it into this README and the report.

```
Dockerfile, .dockerignore   the image: pinned base, non-root, health check, no secrets
Makefile                    run, build, test, eval
src/
  server.js                 Express app: dashboard, POST /api/invoke, owner and agent identities
  invoke.js                 invoke(tool, args, actor): the one door
  tools.js                  the four agent tools
  owner-verbs.js            publish_reply and reject_reply, kept out of the agent registry
  store.js                  in-memory reviews, activity log and the reply-status state machine
  agent.js                  the built-in agent: triage, then draft, through invoke()
  auth.js                   one-time owner link and session; agent bearer token
  config.js                 environment handling and the TEAM_NAME constant
  language.js               the server's own language check (de, fr, it, en)
  schema.js                 argument validation shared with the served tool schemas
  providers/                the model adapter: the offline fixture provider and the
                            OpenAI-compatible client
  public/                   the dashboard (plain HTML, CSS and JS, no build step)
scripts/                    eval.js, report-fill.js, export-report.js, preflight.sh (used by make run)
data/                       fictional seed reviews, the fixture's canned output, the labelled
                            evaluation set and its results (README.md describes them)
docs/                       architecture.md and architecture.svg
tests/                      Jest tests, including a local stub model endpoint
technical_report.md         the write-up for the jury
.env.example                the three settings, empty
```

## Licences

Code: [Apache-2.0](../LICENSE). Documentation, designs and text: CC-BY-4.0. Datasets (`data/`):
CDLA-Permissive-2.0, which is what the hackathon's terms assign to submitted datasets. Copyright
(c) 2026 Chetan Gupta; [`../NOTICE`](../NOTICE) says which part of the repository falls under
which licence. The seed reviews are fictional.
