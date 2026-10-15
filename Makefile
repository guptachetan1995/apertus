# The project lives in track_2b/, which keeps the layout the organisers' template defines, and
# its own Makefile does the work, so `make run` works from either directory. An ENV_FILE given
# here is made absolute first, so it means the same file in both places.

.PHONY: run build test eval

ENV_FILE ?=

run build test eval:
	$(MAKE) --no-print-directory -C track_2b $@ $(if $(ENV_FILE),ENV_FILE=$(abspath $(ENV_FILE)))
