# make run   build the image and start the container, from a clean checkout (what the jury runs)
# make build only build the image
# make test  lint and the test suite, on the host (needs Node.js 24 or newer)
# make eval  the evaluation harness, on the host, against whichever endpoint LLM_* names
#
# Written for GNU make 3.81 (the one macOS ships). Recipe lines start with a tab.

.PHONY: run build test eval

IMAGE ?= hack-apertus-review-triage
PORT ?= 3000
BIND ?= 127.0.0.1
PUBLIC_ORIGIN ?= http://localhost:$(PORT)
ENV_FILE ?=
EVAL_ARGS ?=

DOCKER_BUILD = docker build -t $(IMAGE) .

# Starts the project in a Docker container. The three settings the jury sets, LLM_NAME,
# LLM_BASE_URL and LLM_API_KEY (and the optional LLM_TIMEOUT_MS), are passed through from the
# environment by name, so a key is never written into this file, the image or the command
# line. `make run ENV_FILE=path` reads them from a file of KEY=value lines instead (the path is
# relative to this directory). With none set, the app runs on its offline fixture provider and
# says so in a banner here and in the server's log. The port is published on the host's
# loopback only (BIND=0.0.0.0 to change that). host.docker.internal is added so that a model
# server running on the host machine can be reached from the container. The log prints the
# single-use owner link.
run:
	@sh scripts/preflight.sh check "$(ENV_FILE)"
	$(DOCKER_BUILD)
	@sh scripts/preflight.sh banner "$(ENV_FILE)"
	docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges \
		--add-host host.docker.internal:host-gateway \
		-p $(BIND):$(PORT):3000 -e PORT=3000 -e PUBLIC_ORIGIN=$(PUBLIC_ORIGIN) \
		$(if $(ENV_FILE),--env-file $(ENV_FILE)) \
		-e LLM_NAME -e LLM_BASE_URL -e LLM_API_KEY -e LLM_TIMEOUT_MS \
		$(IMAGE)

build:
	$(DOCKER_BUILD)

# Host-side development targets. node_modules is rebuilt from the lockfile only when the
# lockfile or package.json is newer.
node_modules: package.json package-lock.json
	npm ci --no-audit --no-fund
	@touch node_modules

test: node_modules
	npm run lint
	npm test

# `make eval` uses the fixture unless LLM_* (or ENV_FILE) are set. Results land in
# data/eval-results.json with their provenance; EVAL_ARGS="--limit 5 --out /tmp/try.json" runs
# a quick smoke test that leaves the committed result alone.
eval: node_modules
	ENV_FILE="$(ENV_FILE)" npm run eval -- $(EVAL_ARGS)
