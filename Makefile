# The project lives in track_2b/, which keeps the layout the organisers' template defines, and
# its own Makefile does the work, so `make run` works from either directory. An ENV_FILE or
# EVAL_OUT given here is made absolute first, so it means the same place in both directories.

.PHONY: run build test eval eval-docker

ENV_FILE ?=
EVAL_OUT ?=

run build test eval eval-docker:
	$(MAKE) --no-print-directory -C track_2b $@ $(if $(ENV_FILE),ENV_FILE=$(abspath $(ENV_FILE))) $(if $(EVAL_OUT),EVAL_OUT=$(abspath $(EVAL_OUT)))
