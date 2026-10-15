# Multilingual Review-Reply Triage

Hack Apertus, Track 2B (Own Project). Everything is in [`track_2b/`](track_2b/), which keeps
the layout the organisers' project template defines.

## For the jury

**What it is.** An agent reads customer reviews in German, French, Italian and English,
classifies each as praise, a complaint or urgent, and drafts a public reply in the review's own
language with a reason in English. Only the owner can publish: `publish_reply` is never
registered as a tool an agent can call. One container and one model endpoint you choose, built
for Apertus v1.5.

**Run it on an Apertus endpoint** (needs `make` and Docker). Put `LLM_NAME`, `LLM_BASE_URL` and
`LLM_API_KEY` in a file outside the repository (a copy of `track_2b/.env.example`, one
`KEY=value` per line) and name it:

```bash
make run ENV_FILE=$HOME/apertus.env   # builds and starts the container; the log prints the owner link
```

Open the owner link and press **Run the agent**; the dashboard banner names the model and the
endpoint host that answered. On the Public AI Gateway (`LLM_BASE_URL=https://api.publicai.co/v1`)
the model ids are `swiss-ai/apertus-v1.5-8b` and `swiss-ai/apertus-v1.5-70b`. With no model
configured, `make run` runs on an offline fixture and says so in a banner.

**Get evaluation numbers on your own endpoint.** With Node.js 24 or newer,
`make eval ENV_FILE=$HOME/apertus.env` writes `track_2b/data/eval-results.json`; with only Docker,
`make eval-docker ENV_FILE=$HOME/apertus.env` runs the same harness in the pinned Node.js image and
writes `track_2b/eval-out/eval-results.json` (not run yet). Either runs the 53-review labelled set
and records the model, endpoint host and date. [`track_2b/README.md`](track_2b/README.md) has the
details.

**Demo video (2 minutes):** <!-- generated:video:start -->see the submission form<!-- generated:video:end -->

**What this repository's own results are.** <!-- generated:status-root:start -->Nothing in this
repository has been produced by Apertus yet, and the documents say so.<!-- generated:status-root:end -->

- [`track_2b/README.md`](track_2b/README.md): how to run, test and use it, how to use an Apertus
  endpoint, the target architecture, and how the approval gate works
- [`track_2b/technical_report.md`](track_2b/technical_report.md): the technical report
- [`track_2b/docs/architecture.md`](track_2b/docs/architecture.md): architecture and data flow

Licences: code under [Apache-2.0](LICENSE); documentation, designs and text under CC-BY-4.0;
the datasets in `track_2b/data/` under CDLA-Permissive-2.0. [`NOTICE`](NOTICE) says which part
falls under which; the full texts are [`LICENSE`](LICENSE),
[`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt) and
[`track_2b/data/LICENSE`](track_2b/data/LICENSE). Copyright (c) 2026 Chetan Gupta.
