# make run   build the image and start the container, from a clean checkout (what the jury runs)
# make build only build the image
# make test  lint and the test suite, on the host (needs Node.js 24 or newer)
# make eval  the evaluation harness, on the host, against whichever endpoint LLM_* names
# make eval-docker  the same harness inside the pinned Node.js image, for a machine that has Docker
#            but not Node.js 24 (checkout mounted read-only, result written to EVAL_OUT)
#
# Written for GNU make 3.81 (the one macOS ships). Recipe lines start with a tab.

.PHONY: run build test eval eval-docker

IMAGE ?= hack-apertus-review-triage
PORT ?= 3000
BIND ?= 127.0.0.1
PUBLIC_ORIGIN ?= http://localhost:$(PORT)
ENV_FILE ?=
EVAL_ARGS ?=
EVAL_OUT ?= eval-out

# The image the Dockerfile pins (exact release and digest), read from it so the two cannot drift.
NODE_IMAGE := $(shell sed -n 's/^FROM //p' Dockerfile)

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

# `make eval-docker` runs scripts/eval.js inside the same Node.js image the Dockerfile pins, so a
# machine with only Docker and make can reproduce the numbers. The checkout is mounted read-only
# at /app (nothing in it can change); the result is written to EVAL_OUT (default ./eval-out) on
# this machine, from where it is moved to data/eval-results.json (or data/eval-results-70b.json)
# before `npm run report:fill`. The container runs as the invoking user with every capability
# dropped. LLM_NAME, LLM_BASE_URL, LLM_API_KEY and LLM_TIMEOUT_MS are passed by name, never as
# values, exactly as for `make run`, and ENV_FILE works the same way. A loopback LLM_BASE_URL
# is pointed at host.docker.internal by the same code as the app's. With none set it evaluates
# the offline fixture and the banner says so.
eval-docker:
	@sh scripts/preflight.sh check "$(ENV_FILE)" "make eval-docker"
	@sh scripts/preflight.sh banner "$(ENV_FILE)" "make eval-docker"
	@mkdir -p "$(EVAL_OUT)"
	docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user "$(shell id -u):$(shell id -g)" \
		--add-host host.docker.internal:host-gateway \
		-v "$(CURDIR):/app:ro" -v "$(abspath $(EVAL_OUT)):/out" -w /app \
		-e APERTUS_IN_CONTAINER=1 \
		$(if $(ENV_FILE),--env-file $(ENV_FILE)) \
		-e LLM_NAME -e LLM_BASE_URL -e LLM_API_KEY -e LLM_TIMEOUT_MS \
		$(NODE_IMAGE) node scripts/eval.js --out /out/eval-results.json $(EVAL_ARGS)
	@echo "make eval-docker: the result is $(abspath $(EVAL_OUT))/eval-results.json on this machine"
