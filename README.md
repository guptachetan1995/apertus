# Multilingual Review-Reply Triage

An agent reads customer reviews in German, French, Italian and English, classifies them and
drafts a reply in each review's own language. Only the business owner can publish a reply:
`publish_reply` is never registered as a tool an agent can call.

Hack Apertus, Track 2B (Own Project). Everything is in [`track_2b/`](track_2b/), which keeps
the layout the organisers' project template defines.

```bash
make run        # builds and starts the Docker container; the log prints the owner link
```

With no model configured it runs on an offline fixture and says so in a banner. To point it at an
Apertus v1.5 endpoint, set `LLM_NAME`, `LLM_BASE_URL` and `LLM_API_KEY` (or `make run
ENV_FILE=path`); [`track_2b/README.md`](track_2b/README.md) has the details. <!-- generated:status-root:start -->Nothing in this
repository has been produced by Apertus yet, and the documents say so.<!-- generated:status-root:end -->

- [`track_2b/README.md`](track_2b/README.md): how to run, test and use it, how to use an Apertus
  endpoint, the target architecture, and how the approval gate works
- [`track_2b/technical_report.md`](track_2b/technical_report.md): the technical report
- [`track_2b/docs/architecture.md`](track_2b/docs/architecture.md): architecture and data flow

Licences: code under [Apache-2.0](LICENSE); documentation, designs and text under CC-BY-4.0;
the datasets in `track_2b/data/` under CDLA-Permissive-2.0. [`NOTICE`](NOTICE) says which part
falls under which. Copyright (c) 2026 Chetan Gupta.
