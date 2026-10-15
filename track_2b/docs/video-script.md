# Demo video script

Source for the narrated demo video (the hackathon asks for at most 2 minutes). Every picture in it
is the real running app or a real command's output, captured when the video is rendered; nothing
is a mock-up. The narration is macOS text-to-speech, with no face on screen. The words below are
the words that are spoken, and the video's subtitles are cut from them.

## Runtime budget

The limit is 2:00 (120.0 s). The target is 1:45 to 1:55 (105 to 115 s), so that a slower
text-to-speech voice cannot push the video past the limit.

| Beat | Seconds |
|---|---|
| 1 intro | 12.4 |
| 2 triage | 12.4 |
| 3 draft | 10.4 |
| 4 refuse-http | 8.8 |
| 5 refuse-log | 8.8 |
| 6 approve | 12.4 |
| 7 log-both | 7.6 |
| 8 provider | 8.0 |
| 9 sovereign | 12.0 |
| 10 evaluation | 12.4 |
| 11 close | 6.0 |
| **Total** | **111.2** |

12.4 + 12.4 + 10.4 + 8.8 + 8.8 + 12.4 + 7.6 + 8.0 + 12.0 + 12.4 + 6.0 = 111.2 s, which is 1:51.2: 8.8 s
under the limit and inside the target. Each beat is sized from a measured dry run of the voice:
a beat's narration, spoken one sentence at a time, must end at least 0.3 s before the beat does,
and starts 0.4 s after it begins (measured speech per beat: 11.0, 11.2, 9.3, 7.7, 7.1, 11.1, 6.2,
6.9, 10.9, 10.8 and 4.2 s). The render stops if a beat's words do not fit, and stops again if the
finished file runs over 120.0 s, which `ffprobe` measures. The Apertus cut says more in three beats
(the table below), so those beats grow to fit; the render refuses a cut that would pass 118 s.

## Two cuts, one script

The video is rendered in one of two modes, and which one is stated in the narration of the cut
itself.

- **Fixture cut.** The app runs with none of `LLM_NAME`, `LLM_BASE_URL` and `LLM_API_KEY` set, so
  it answers from the offline fixture provider (canned output, no model). The narration says so
  in the provider beat and no beat shows a result as Apertus output. This is the cut that exists
  today, because no Apertus endpoint has been run yet.
- **Apertus cut.** The same script, rendered with the three variables set (by an env file named on
  the command line, never typed into a shell). The provider beat and the evaluation beat change
  their words (the table at the end of this file), and a result may be called Apertus's only when
  the dashboard's own banner shows a model name that says Apertus and an endpoint host.

## Setup

Run from `track_2b/` with Node.js 24 or newer:

```bash
npm ci
PORT=0 HOST=127.0.0.1 npm start     # fixture cut; PORT=0 picks a free port
```

The log prints the address, the provider, a single-use owner link and an agent bearer token:

```
Review triage is listening on http://127.0.0.1:<port>
Provider: fixture provider (canned output, not a model). Offline, and not Apertus output.
Open the dashboard as the owner (single-use link): http://127.0.0.1:<port>/session?token=<token>
Agent bearer token for external clients: <token>
```

For the Apertus cut add `ENV_FILE=<path to a file of the three variables>` to the command. The video
is recorded from a freshly started server (the activity log is in memory and starts empty), and
the owner link is single-use, so a recording pass takes a new server.

Starting data: the six fictional reviews in `data/seed-reviews.json`, in this order on the
dashboard before the agent runs: a German complaint (`rev_001`), a French review about an allergic
reaction (`rev_002`), an Italian praise (`rev_003`), an English praise (`rev_004`), a German
praise (`rev_005`) and an Italian complaint (`rev_006`). The seed has no German urgent review: the
one urgent review is the French allergy, so that is the one the video shows being flagged, and the
German review it shows is a complaint.

## Shot table

Times are the start of each beat. Every beat's picture is a still of the real page, held for the
beat's length. "Outlined" means a blue outline drawn around an element the app itself rendered, to
point at it; it does not change what the app shows. The `on screen` and `action` columns say
what is captured; the last column is the narration, word for word, for the fixture cut.

| # | id | time | ms | on screen | action | narration |
|---|---|---|---|---|---|---|
| 1 | `intro` | 0:00 | 12400 | The dashboard just after the owner link: six reviews, "Not triaged yet", the provider banner top right | Open the owner link | A hotel or café gets reviews in German, French, Italian and English, and the owner cannot read them all. An agent does the reading; the owner decides what goes public. |
| 2 | `triage` | 0:12 | 12400 | The French allergy review first, flagged urgent, with its English triage reason; the message "Triaged 6, drafted 6. Nothing is published." | Click "Run the agent: triage and draft" | One click runs the agent. It names each review's language and sorts it: praise, complaint or urgent. The French allergy review is flagged urgent and goes first. |
| 3 | `draft` | 0:24 | 10400 | The French draft and its "Why (English)" line, outlined; then the German complaint's draft and reason | Scroll to the German complaint | It drafts each reply in the guest's own language, with its reason in English for the owner. French for the allergy, German for the breakfast complaint. |
| 4 | `refuse-http` | 0:35 | 8800 | A terminal: the tools the agent is offered (four, none of them publish), then the agent's publish call and the server's answer, HTTP 403 forbidden_actor | Real curl output from a second freshly started copy of the server | The agent has no publish tool. If it tries anyway with its own token, the server answers 403, forbidden actor. |
| 5 | `refuse-log` | 0:44 | 8800 | The refusal message under the button, then the activity log with the top row: agent, publish_reply, refused: forbidden_actor | Click "Agent tries to call publish_reply" in Gate probes, then scroll to the log | The dashboard's gate probe does the same. The log records the agent, the tool and the refusal. Nothing was published. |
| 6 | `approve` | 0:52 | 12400 | The French card, outlined: original, draft and reason side by side; then the card marked Published | Click "Approve and publish" on the French card | Only the owner can publish. They read the original, the draft and the reason side by side, then click Approve and publish. That click is the only way a reply goes public. |
| 7 | `log-both` | 1:05 | 7600 | The activity log: the owner's publish_reply, then the agent's drafts and triage | Scroll to the log | The log shows both actors: the agent's triage and drafts, and the owner's one publish. |
| 8 | `provider` | 1:12 | 8000 | The top of the dashboard with the provider banner outlined: "Offline fixture provider: canned output, not Apertus." | Scroll to the top | This cut ran on the offline fixture provider, and the banner says so. No Apertus result is shown in this video. |
| 9 | `sovereign` | 1:20 | 12000 | The architecture diagram from `docs/architecture.svg` | None | One container, one model endpoint you choose, nothing else contacted. The declared target is on-premise or air-gapped, with Apertus as the model behind that endpoint. |
| 10 | `evaluation` | 1:32 | 12400 | The evaluation result from `data/eval-results.json`, its label and provenance line first, as `npm run eval` prints them | None | The evaluation table carries its provenance: model, endpoint host and date. This one reads fixture provider, no endpoint: a baseline, not Apertus. |
| 11 | `close` | 1:45 | 6000 | A closing card with the repository address and the licences | None | The code is open source under Apache 2.0; the link is in the description. |

The closing card carries the repository address as `REPO_URL` until the render is given the real
one; a render for upload must be given it.

## Wording that changes in the Apertus cut

These replace the fixture wording above, beat by beat. In the provider beat `{model}` and `{host}`
are the model name and endpoint host the dashboard's banner shows. The evaluation line is chosen by
what `data/eval-results.json` says, not by the cut: with a result file that came from a real
endpoint the table shows that file and the second wording is used, and there `{model}` and `{host}`
are the file's own provenance fields. The provider and sovereign lines are used only when the
banner shows an endpoint host and a model name that says Apertus; otherwise the cut is not rendered.

| id | narration |
|---|---|
| real:provider | The banner shows the model and the endpoint: {model} via {host}. The dashboard's answers came from there. |
| real:sovereign | One container, one model endpoint you choose, nothing else contacted. The declared setup points that endpoint at your own server, on-premise or air-gapped. |
| real:evaluation | The evaluation table carries its provenance: model, endpoint host and date. This one reads {model} at {host}, as the table shows. |

## Claims in the narration

Every factual statement in the narration, and where the video or the repository shows it.

| Claim | Shown by |
|---|---|
| Reviews in German, French, Italian and English | Beat 1 (the six seeded reviews); `data/seed-reviews.json`; README "Demo walkthrough" |
| The owner cannot read them all | The use case, stated in the README's opening paragraph; not a measured claim |
| An agent does the reading; the owner decides what goes public | Beats 2 to 6; README table "What the agent does, and what only the owner does" |
| The agent names the language and sorts into praise, complaint or urgent | Beat 2 (language and category badges); `tests/agent.test.js` |
| The French allergy review is flagged urgent and goes first | Beat 2 (it is the first card); `src/public/app.js` sorts urgent first; the fixture's canned answer for `rev_002` |
| A reply is drafted in the guest's own language with a reason in English | Beat 3; `draft_reply` refuses a reply that is not in the review's language (`tests/invoke.test.js`) |
| The agent has no publish tool | Beat 4 (the agent is offered four tools); `src/tools.js` registers four; `tests/approval-gate.test.js` |
| An agent's publish attempt is answered 403 forbidden_actor | Beat 4 (HTTP 403 and the code in the response); `tests/server-http.test.js` |
| The log records the agent, the tool and the refusal | Beat 5 (activity log row); `tests/store.test.js` |
| Nothing was published by the probe | Beat 5 (no card is marked Published until beat 6) |
| The owner reads original, draft and reason side by side and clicks Approve and publish | Beat 6 |
| That click is the only way a reply goes public | `src/store.js` allows `published` only through `publish()`; `tests/gate-contract.js`; README "Why an agent cannot publish" |
| The log shows both actors | Beat 7 |
| Every call is recorded, allowed or refused | README "Why an agent cannot publish"; `tests/invoke.test.js` |
| This cut ran on the offline fixture provider; no Apertus result is shown | Beat 8 (the banner, outlined), the banner at the top of the frames of beats 1, 2, 3, 5, 6 and 8, beat 10 (the file's own label) |
| One container, one model endpoint, nothing else contacted | Beat 9; README "Target architecture"; `tests/server-http.test.js` (the content security policy), `tests/packaging.test.js` (the container settings) |
| The declared target is on-premise or air-gapped, with Apertus on your own hardware | README "Target architecture" (a declared design; no real Apertus server has been run) |
| The evaluation table carries model, endpoint host and date | Beat 10 (the provenance line); `scripts/eval.js`, `data/eval-results.json` |
| This evaluation result is the fixture's, a baseline, not Apertus | Beat 10, read from the file's own label and provenance (provider fake, no endpoint host) |
| The code is open source under Apache 2.0 | `LICENSE`; README "Licences" |

## Findings from the dry run

Run on 16 Oct 2026 against the real app, before the script was written.

- The seeded urgent review is French (`rev_002`), not German. The German review is a complaint.
  The script says what the app does.
- After "Run the agent" the page shows "Triaged 6, drafted 6. Nothing is published." and the
  urgent card is first.
- The "Agent tries to call publish_reply" probe answers over `POST /api/probe/...` with HTTP 200 and
  the refusal as its body, so it shows `forbidden_actor` but not the number 403. The 403 comes from
  the same call made as an external agent with a bearer token to `POST /api/invoke`, which is what
  beat 4 shows.
- A published review moves to the bottom of the list, so beat 6's second picture scrolls to it.
- The dashboard is taller than one screen; the log is at the bottom, so beats 5 and 7 scroll to it.
- The banner is at the top of the page, so it is on screen in the frames of beats 1, 2, 3 (first
  picture), 5 (first picture), 6 (first picture) and 8, and scrolled out of view in the others. The
  render checks the banner on the page for every dashboard frame, so a frame cannot be captured
  from a server that is running a different provider than the cut says.
- The first draft of the narration ran 128 s of speech alone, 8 s over the whole limit. The
  voice speaks about 2.9 words a second inside a sentence even slowed to 0.9 of its natural speed,
  so every line was cut to what a beat can hold and the beats were sized from the measurement.
- Reloading the dashboard after the terminal beat keeps the owner session (it is a cookie) and the
  server's state, so the drafts are still there; the owner link is not used twice.
- The first outline on the whole review card was clipped by the card's own edge; it is drawn
  inside the card.

## Beats that need the owner

None. The video has no face and no live external call. The owner uploads the rendered file to
YouTube as Public, with the subtitle file, and pastes the link into the submission.

## Submission checklist (video)

- Length at most 2:00, checked with `ffprobe`.
- States plainly, in the video itself, which provider ran.
- Shows the real running app only.
- Uploaded as a public YouTube video; link in the submission form.
