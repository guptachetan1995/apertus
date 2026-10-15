#!/usr/bin/env bash
# Verification for the apertus entry: the repository layout the organisers' project template
# requires, the container and Makefile, the licences, the secret scan, then lint and the tests.
# Runs the same in a clean clone of the published repository and in the monorepo; the checks
# that read SPEC.md run only in the monorepo, because SPEC.md is never published.
# Kept compatible with the bash 3.2 that ships on macOS: no mapfile, no negative array indices.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail() { echo "ERROR: $1" >&2; exit 1; }

in_monorepo=false
[ -f ../../bin/publish.sh ] && [ -f ../../bin/verify.sh ] && in_monorepo=true

in_git=false
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then in_git=true; fi

P=track_2b

echo "== layout mirrors the organisers' project template, with only $P kept =="
for f in README.md LICENSE NOTICE .gitignore Makefile; do
  [ -f "$f" ] || fail "$f is missing from the repository root"
  echo "  ok: $f"
done
for f in README.md technical_report.md Makefile .gitignore Dockerfile .dockerignore .env.example package.json package-lock.json; do
  [ -f "$P/$f" ] || fail "$P/$f is missing"
  echo "  ok: $P/$f"
done
for d in src docs data; do
  [ -d "$P/$d" ] || fail "$P/$d/ is missing"
  echo "  ok: $P/$d/"
done
for f in .gitattributes "$P/.gitattributes"; do
  for line in '*.sh text eol=lf' 'Makefile text eol=lf' 'Dockerfile text eol=lf'; do
    grep -qxF -- "$line" "$f" || fail "$f does not keep line endings LF: missing '$line'"
  done
  echo "  ok: $f"
done
for d in track_1a track_1b track_2a; do
  [ ! -e "$d" ] || fail "$d/ must be deleted: only the track being entered is kept"
done

echo "== data/ stays under the 100 MB limit =="
data_kb="$(du -sk "$P/data" | cut -f1)"
[ "$data_kb" -lt 102400 ] || fail "$P/data is ${data_kb} KB, over the 100 MB limit"
echo "  ok: ${data_kb} KB"

echo "== make run: the Makefile's run target builds the image and starts the container =="
for target in run build test eval eval-docker; do
  grep -qE "^\.PHONY:.*[[:space:]]$target([[:space:]]|\$)" "$P/Makefile" || fail "$P/Makefile does not declare $target as .PHONY"
  grep -q "^$target:" "$P/Makefile" || fail "$P/Makefile has no $target target"
  grep -qE "^(run build test eval eval-docker|$target):" Makefile || fail "the root Makefile does not forward $target to $P"
done
grep -q 'docker run' "$P/Makefile" || fail "$P/Makefile's run target does not use docker run"
grep -q 'docker build' "$P/Makefile" || fail "$P/Makefile does not build the image"
if grep -nE '^ +[^ #]' Makefile "$P/Makefile" | grep -v ':[0-9]*:#'; then
  fail "a Makefile has a line indented with spaces; make recipes need a tab"
fi
grep -q -- '-C track_2b' Makefile || fail "the root Makefile does not run the targets in $P"
grep -qE -- '-v "\$\(CURDIR\):/app:ro"' "$P/Makefile" || fail "make eval-docker must mount the checkout read-only"
grep -q 'NODE_IMAGE' "$P/Makefile" || fail "make eval-docker must use the image the Dockerfile pins"
echo "  ok"

echo "== the Makefile never puts a secret on a command line, and the preflight script is sound =="
for var in LLM_NAME LLM_BASE_URL LLM_API_KEY; do
  grep -qE -- "-e $var( |\\\\|\$)" "$P/Makefile" || fail "make run does not pass $var through to the container by name"
done
if grep -nE '\$\((LLM_[A-Z_]+|OWNER_TOKEN|AGENT_TOKEN)\)|LLM_[A-Z_]+=' "$P/Makefile" Makefile; then
  fail "a Makefile expands or assigns a secret on a recipe line, where make would echo it"
fi
[ -f "$P/scripts/preflight.sh" ] || fail "$P/scripts/preflight.sh is missing"
sh -n "$P/scripts/preflight.sh" || fail "$P/scripts/preflight.sh has a syntax error"
grep -q 'preflight.sh banner' "$P/Makefile" || fail "make run does not print the offline-provider banner"
grep -q 'OFFLINE FIXTURE PROVIDER' "$P/src/server.js" || fail "the server does not print the offline-provider banner"
echo "  ok"

echo "== the container: pinned base image, non-root user, healthcheck, no secrets baked in =="
grep -qE '^FROM node:24\.[0-9]+\.[0-9]+-[a-z0-9.-]+@sha256:[0-9a-f]{64}$' "$P/Dockerfile" ||
  fail "$P/Dockerfile must pin an exact Node.js 24 release and its image digest"
grep -qx 'USER node' "$P/Dockerfile" || fail "$P/Dockerfile does not run as the unprivileged node user"
grep -q '^HEALTHCHECK' "$P/Dockerfile" || fail "$P/Dockerfile has no HEALTHCHECK"
grep -qE '^RUN npm ci --omit=dev' "$P/Dockerfile" || fail "$P/Dockerfile must install production dependencies from the lockfile (npm ci --omit=dev)"
if grep -qiE '^(ENV|ARG)[[:space:]].*(LLM_|API_KEY|TOKEN|SECRET|PASSWORD)' "$P/Dockerfile"; then
  fail "$P/Dockerfile sets a secret or an LLM variable"
fi
if grep -nE '^(COPY|ADD)([[:space:]]+--[a-z=]+)*[[:space:]]+\.([[:space:]]|$)|^(COPY|ADD)[[:space:]].*\.env' "$P/Dockerfile"; then
  fail "$P/Dockerfile copies the whole directory or an env file into the image"
fi
for entry in .env '.env.*' '!.env.example' node_modules tests .git; do
  grep -qxF -- "$entry" "$P/.dockerignore" || fail "$P/.dockerignore does not list $entry"
done
base_image="$(sed -n 's/^FROM \(node:[^@]*\)@.*/\1/p' "$P/Dockerfile")"
for doc in README.md technical_report.md; do
  grep -qF "$base_image" "$P/$doc" || fail "$P/$doc does not name the Dockerfile's base image $base_image"
done
echo "  ok: $base_image"

echo "== the labelled evaluation set, its recorded results, and the report tooling =="
for f in data/eval-set.json data/eval-results.json scripts/eval.js scripts/export-report.js scripts/pdf-pages.js docs/architecture.svg src/providers/openai-compatible-provider.js; do
  [ -f "$P/$f" ] || fail "$P/$f is missing"
  echo "  ok: $P/$f"
done
eval_items="$(grep -c '"goldCategory"' "$P/data/eval-set.json")"
[ "$eval_items" -ge 40 ] || fail "$P/data/eval-set.json has $eval_items labelled reviews; at least 40 are needed"
echo "  ok: $eval_items labelled reviews"
for field in providerKind model endpointHost modelNameSaysApertus date sha256; do
  grep -q "\"$field\"" "$P/data/eval-results.json" || fail "$P/data/eval-results.json records no \"$field\": every result must carry its provenance"
done
echo "  ok: results carry their provenance"

echo "== licences: code Apache-2.0, documentation CC-BY-4.0, datasets CDLA-Permissive-2.0 =="
grep -q 'Apache License' LICENSE && grep -q 'Version 2.0, January 2004' LICENSE || fail "LICENSE is not the Apache-2.0 text"
grep -q 'Copyright (c) 2026 Chetan Gupta' LICENSE || fail "LICENSE does not name the copyright holder as 'Copyright (c) 2026 Chetan Gupta'"
grep -q '"license": "Apache-2.0"' "$P/package.json" || fail "package.json does not declare Apache-2.0"
for term in Apache-2.0 CC-BY-4.0 CDLA-Permissive-2.0 'Chetan Gupta'; do
  grep -qF "$term" NOTICE || fail "NOTICE does not mention $term"
done
# The licence texts themselves, not only their names (NOTICE records where each was read).
[ -f LICENSES/CC-BY-4.0.txt ] && grep -q 'Creative Commons Attribution 4.0 International Public License' LICENSES/CC-BY-4.0.txt &&
  grep -q 'Section 6 -- Term and Termination' LICENSES/CC-BY-4.0.txt || fail "LICENSES/CC-BY-4.0.txt is missing or is not the CC BY 4.0 legal code"
[ -f "$P/data/LICENSE" ] && grep -q 'Community Data License Agreement' "$P/data/LICENSE" && grep -q 'Permissive' "$P/data/LICENSE" &&
  grep -q 'Version 2.0' "$P/data/LICENSE" && grep -q '5.4. ' "$P/data/LICENSE" || fail "$P/data/LICENSE is missing or is not the CDLA-Permissive-2.0 text"
for term in LICENSES/CC-BY-4.0.txt track_2b/data/LICENSE creativecommons.org/licenses/by/4.0/legalcode.txt cdla.dev/permissive-2-0 'read 16 Oct 2026'; do
  grep -qF "$term" NOTICE || fail "NOTICE does not mention $term"
done
grep -q 'CDLA-Permissive-2.0' "$P/data/README.md" || fail "$P/data/README.md does not state the dataset licence, CDLA-Permissive-2.0"
grep -q 'CC-BY-4.0' "$P/technical_report.md" || fail "$P/technical_report.md does not state CC-BY-4.0"
grep -q 'CC-BY-4.0' "$P/README.md" || fail "$P/README.md does not state CC-BY-4.0"
grep -q 'Apache-2.0' "$P/README.md" || fail "$P/README.md does not state Apache-2.0"
# This entry is not under the portfolio's usual licence: no published file may say so.
mit_hits="$(grep -rIlw 'MIT' --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json --exclude=verify.sh --exclude=SPEC.md . || true)"
[ -z "$mit_hits" ] || fail "the entry must be Apache-2.0, but these files mention the other licence: $mit_hits"
echo "  ok"

echo "== the team name is one constant; the README and the report carry it (npm run report:fill) =="
team_name="$(sed -n "s/^const TEAM_NAME = '\([^']*\)';\$/\1/p" "$P/src/config.js")"
[ -n "$team_name" ] || fail "$P/src/config.js has no TEAM_NAME constant"
printf '%s' "$team_name" | grep -qE '^[A-Za-z0-9][A-Za-z0-9_-]*$' ||
  fail "TEAM_NAME must be non-empty, start with a letter or digit and hold only letters, digits, '_' and '-' (no spaces): got '$team_name'"
[ "$(grep -c "${team_name}_Report\.pdf" "$P/README.md")" -eq 1 ] || fail "$P/README.md must mention ${team_name}_Report.pdf on exactly one line (run: npm run report:fill)"
grep -qF -- "- **Team:** Chetan Gupta (identifier <!-- generated:team:start -->\`${team_name}\`<!-- generated:team:end -->)" "$P/technical_report.md" ||
  fail "$P/technical_report.md does not carry the team name ${team_name} (run: npm run report:fill)"
echo "  ok: ${team_name}_Report.pdf"

echo "== the technical report keeps the template's sections =="
for h in "## 1. Summary" "## 2. Architecture" "### Target architecture (mandatory)" "## 3. Use of Apertus" "## 4. Data" "## 5. Evaluation" "## 6. Limitations" "## 7. Reproducibility" "## 8. Next steps" "## License"; do
  grep -qF "$h" "$P/technical_report.md" || fail "$P/technical_report.md lost the heading: $h"
done
echo "  ok"

echo "== no unresolved placeholders =="
placeholder_files="README.md NOTICE $P/README.md $P/technical_report.md $P/docs/architecture.md $P/data/README.md"
[ "$in_monorepo" = true ] && placeholder_files="$placeholder_files SPEC.md"
# shellcheck disable=SC2086
if grep -nE 'TODO|TBD' $placeholder_files; then
  fail "a document still contains a placeholder"
fi

echo "== the structural human-approval gate is named, not just described =="
grep -qi "never registered as a tool" "$P/README.md" ||
  fail "$P/README.md no longer states the publish/reject tool-registry exclusion"

echo "== no CI configuration =="
for ci in .github .gitlab-ci.yml .circleci .travis.yml Jenkinsfile azure-pipelines.yml bitbucket-pipelines.yml; do
  [ ! -e "$ci" ] || fail "$ci exists: this repository has no CI or GitHub Actions"
done
echo "  ok"

echo "== secrets: .env is ignored, .env.example is empty, no key-shaped string anywhere =="
for ignore_file in .gitignore "$P/.gitignore"; do
  grep -qxF '.env' "$ignore_file" && grep -qxF '.env.*' "$ignore_file" && grep -qxF '!.env.example' "$ignore_file" ||
    fail "$ignore_file must ignore .env and .env.* and keep .env.example"
done
if [ "$in_git" = true ]; then
  for probe in "$P/.env" "$P/.env.local" ".env"; do
    git check-ignore -q "$probe" || fail "git does not ignore $probe: a key could be committed"
  done
  ! git check-ignore -q "$P/.env.example" || fail "git ignores $P/.env.example, which must be committed"
  tracked_env="$(git ls-files -- . | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' || true)"
  [ -z "$tracked_env" ] || fail "an env file is tracked: $tracked_env"
fi
# Only empty KEY= lines may be in the example. Offending line numbers are reported, never the lines.
bad_lines="$(grep -nvE '^[[:space:]]*(#|$)' "$P/.env.example" | grep -vE '^[0-9]+:[A-Z_][A-Z0-9_]*=$' | cut -d: -f1 | tr '\n' ' ' || true)"
[ -z "$bad_lines" ] || fail "$P/.env.example must hold only empty KEY= lines; check line(s): $bad_lines"
for var in LLM_NAME LLM_BASE_URL LLM_API_KEY; do
  grep -qxF "$var=" "$P/.env.example" || fail "$P/.env.example does not list $var="
done

# The files to scan: what git would commit, or, outside git (a copy of the directory), every
# file but node_modules and local env files. An ignored .env is never opened.
scan_files() {
  if [ "$in_git" = true ]; then
    git ls-files -z -co --exclude-standard -- .
  else
    find . -name node_modules -prune -o -name .git -prune -o -type f ! -name '.env' ! -name '.env.*' -print0
  fi
}
# Prints the names of files that hold a key-shaped string, read from NUL-separated paths on
# stdin. Tests write throwaway fake values on purpose, and this file holds the patterns
# themselves, so the assigned-key pattern skips tests/ and verify.sh; the key-shaped patterns
# apply everywhere.
shaped='(^|[^A-Za-z0-9])(sk|pk|hf|rk)[-_][A-Za-z0-9][A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{35}'
assigned='(api[_-]?key|secret|passw(or)?d|token|authorization)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'](Bearer )?[A-Za-z0-9/+_.=-]{20,}["'"'"']|LLM_API_KEY=[^[:space:]]+'
secret_hits() {
  local list
  list="$(mktemp)"
  cat > "$list"
  xargs -0 grep -IlE "$shaped" /dev/null < "$list" || true
  grep -zvE '^(\./)?(track_2b/tests/|verify\.sh$)' "$list" | xargs -0 grep -IlE "$assigned" /dev/null || true
  rm -f "$list"
}
# The scan has to be able to fail: fabricate one of each shape at run time (so this file
# never holds a key-shaped literal) and require every one to be found, and a clean file not.
selfcheck="$(mktemp -d)"
printf '%s%s\n' 'sk-' 'abcdefghijklmnopqrstuvwx' > "$selfcheck/a"
printf '%s%s\n' 'hf_' 'abcdefghijklmnopqrstuvwx' > "$selfcheck/b"
printf '%s%s\n' 'AKIA' 'ABCDEFGHIJKLMNOP' > "$selfcheck/c"
printf '%s %s %s\n' '-----BEGIN' 'RSA PRIVATE' 'KEY-----' > "$selfcheck/d"
printf '%s%s\n' 'LLM_API_' 'KEY=somethingreal' > "$selfcheck/e"
printf '%s = "%s"\n' 'api_key' 'abcdefghijklmnopqrstuvwxyz0123' > "$selfcheck/f"
printf '%s%s\n' 'ghp_' 'abcdefghijklmnopqrstuvwxyz0123456789' > "$selfcheck/g"
printf 'a harmless line about sk and hf and tokens\nLLM_API_KEY=\n' > "$selfcheck/clean"
found="$(cd "$selfcheck" && find . -type f -print0 | secret_hits | sort | tr '\n' ' ')"
rm -rf "$selfcheck"
[ "$found" = "./a ./b ./c ./d ./e ./f ./g " ] || fail "the secret scan's self-check found: '$found' (it must find a to g, and not clean)"
hits="$(scan_files | secret_hits | sort -u | tr '\n' ' ')"
[ -z "$hits" ] || fail "something that looks like a key or an assigned secret is in: $hits"
echo "  ok: no key-shaped string in $(scan_files | tr -cd '\0' | wc -c | tr -d ' ') files; the scan's self-check passed"

if [ "$in_monorepo" = true ]; then
  echo "== the published tree never mentions the private spec =="
  leaks="$(grep -rInwE 'SPEC(\.md)?' --exclude-dir=node_modules --exclude-dir=.git --exclude=verify.sh --exclude=SPEC.md . || true)"
  [ -z "$leaks" ] || fail "published files mention the private spec: $leaks"
  echo "  ok"
fi

if [ "$in_monorepo" = true ]; then
  [ -f SPEC.md ] || fail "SPEC.md is missing from the entry root"
  echo "  ok: SPEC.md"

  echo "== SPEC.md sections, in the order the spec fixes =="
  expected=(
    "1. Customer Confusion"
    "2. Concept"
    "3. What the agent does, what only the human does"
    "4. Tool list"
    "5. Data model"
    "6. Demo script"
    "7. Stack pin"
    "8. File layout"
    "9. Test plan"
    "10. Submission checklist"
  )
  found=()
  while IFS= read -r line; do
    found+=("$line")
  done < <(grep -E '^## ' SPEC.md)

  [ "${#found[@]}" -eq "${#expected[@]}" ] ||
    fail "SPEC.md has ${#found[@]} top-level sections, expected ${#expected[@]}"

  i=0
  while [ "$i" -lt "${#expected[@]}" ]; do
    case "${found[$i]}" in
      "## ${expected[$i]}"*) echo "  ok: ${expected[$i]}" ;;
      *) fail "section $((i + 1)) is '${found[$i]}', expected to start with '## ${expected[$i]}'" ;;
    esac
    i=$((i + 1))
  done

  echo "== the submission checklist is the final section =="
  last="${found[$((${#found[@]} - 1))]}"
  [ "$last" = "## 10. Submission checklist" ] ||
    fail "the last section of SPEC.md is '$last', not the submission checklist"

  echo "== the spec records the live rules, and states what is still unverified =="
  items=(
    "Track 2B"
    "16 Oct 2026"
    "Purposeful use of AI"
    "Sovereign deployability"
    "project-template"
    "make run"
    "LLM_BASE_URL"
    "Apache-2.0"
    "CC-BY-4.0"
    "CDLA-Permissive-2.0"
    "read 7 Oct 2026"
  )
  # SPEC.md is the private plan: while the only result on record is the offline fixture's, it
  # must still say so. Once a real result exists, the generated documents carry the status.
  if grep -q '"providerKind": "fake"' "$P/data/eval-results.json"; then
    items+=("Not yet run against Apertus")
  fi
  for item in "${items[@]}"; do
    grep -qi -- "$item" SPEC.md || fail "SPEC.md does not mention: $item"
    echo "  ok: $item"
  done

  echo "== does NOT assert an unpublished submission requirement as fact =="
  # No Hack Apertus page publishes a diagram requirement; an edit that invents one fails here.
  if grep -qiE 'submission (must|requires) (an? )?(architecture )?diagram' SPEC.md; then
    fail "SPEC.md asserts a diagram requirement that Hack Apertus has not published"
  fi
fi

echo "== Node.js 24 or newer =="
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required, found $(node --version)"
echo "  ok: $(node --version)"

cd "$P"
if [ ! -d node_modules ]; then
  echo "== npm ci =="
  npm ci --no-audit --no-fund
fi

echo "== the README, the report and the repository README agree with data/eval-results.json and TEAM_NAME =="
npm run report:check --silent

echo "== lint =="
npm run lint --silent

echo "== tests =="
npm test --silent

echo "apertus: all checks passed."
