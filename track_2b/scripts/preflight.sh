#!/bin/sh
# Runs on the host, from the Makefile's run target, around `docker run`.
#   preflight.sh check  [ENV_FILE] [TARGET]   stops early on a half-set LLM configuration
#   preflight.sh banner [ENV_FILE] [TARGET]   says, loudly, which kind of provider is about to start
# TARGET is the make target that calls it, named in the messages (default: make run).
# Plain POSIX sh: the machine that runs `make run` needs only make and Docker. It prints names
# and counts, never the value of an LLM_* variable, and never reads ENV_FILE.
set -eu

mode="${1:-}"
env_file="${2:-}"
target="${3:-make run}"

set_count=0
missing=""
if [ -n "${LLM_NAME:-}" ]; then set_count=$((set_count + 1)); else missing="$missing LLM_NAME"; fi
if [ -n "${LLM_BASE_URL:-}" ]; then set_count=$((set_count + 1)); else missing="$missing LLM_BASE_URL"; fi
if [ -n "${LLM_API_KEY:-}" ]; then set_count=$((set_count + 1)); else missing="$missing LLM_API_KEY"; fi

rule='============================================================================'

case "$mode" in
  check)
    if [ -n "$env_file" ]; then
      if [ ! -r "$env_file" ]; then
        echo "$target: ENV_FILE '$env_file' does not exist or cannot be read" >&2
        exit 2
      fi
    elif [ "$set_count" -ne 0 ] && [ "$set_count" -ne 3 ]; then
      echo "$target: LLM_NAME, LLM_BASE_URL and LLM_API_KEY must be set together or not at all; missing:$missing" >&2
      exit 2
    fi
    ;;
  banner)
    if [ -n "$env_file" ]; then
      echo "$target: LLM settings come from $env_file; the server's log line starting 'Provider:' says which model answers."
    elif [ "$set_count" -eq 3 ]; then
      echo "$target: LLM_NAME, LLM_BASE_URL and LLM_API_KEY are set; starting against that endpoint (the server's log line starting 'Provider:' names its host)."
    else
      echo "$rule"
      echo " NO MODEL ENDPOINT IS CONFIGURED (LLM_NAME, LLM_BASE_URL, LLM_API_KEY are all empty)."
      echo " Starting on the OFFLINE FIXTURE PROVIDER: canned answers, NOT Apertus output."
      echo " To use Apertus, set the three variables (or: $target ENV_FILE=.env) and run again."
      echo "$rule"
    fi
    ;;
  *)
    echo "usage: preflight.sh check|banner [ENV_FILE] [TARGET]" >&2
    exit 64
    ;;
esac
