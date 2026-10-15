# data/

Everything here is fictional, written for this project, and contains no personal data: no real
customer, business or person is described, and no scraped or third-party review text is included.
The whole directory is far below the organisers' 100 MB limit.

**Licence: Community Data License Agreement, Permissive, Version 2.0 (CDLA-Permissive-2.0),**
<https://cdla.dev/permissive-2-0/>. This is the licence Section 6 of the Hack Apertus Terms and
Conditions assigns to submitted datasets. Copyright (c) 2026 Chetan Gupta. (Code is Apache-2.0
and documentation is CC-BY-4.0; see `../../NOTICE`.)

| File | What it is | Used by |
|---|---|---|
| `seed-reviews.json` | Six fictional reviews (German, French, Italian, English) the dashboard starts with | the app, in the image |
| `fake-provider-fixtures.json` | The offline fixture provider's canned classifications and replies. Not produced by any model | the app when no endpoint is configured, in the image |
| `eval-set.json` | 53 labelled fictional reviews: `originalText`, `rating`, `goldCategory` (`praise`, `complaint`, `urgent`), `goldLanguage` (`de`, `fr`, `it`, `en`, `und`) and `tags`. The labelling rules are in the file's `note` | `npm run eval` (not in the image) |
| `eval-results.json` | The last evaluation run: its provenance (provider kind, model name, endpoint host, date, SHA-256 of the evaluation set), the metrics and one record per review. **The committed file is the offline fixture's. It is not an Apertus result** | written by `npm run eval` |

How the evaluation set was made: drafted with a coding assistant (Claude Code) under the author's
direction, labelled by one person with no second annotator, and the Romansh reviews were not
checked by a native speaker. The technical report's Data section has the counts and the limits.
