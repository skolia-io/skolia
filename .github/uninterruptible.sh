#!/usr/bin/env bash
# Runs a command to the end even if its run is cancelled: a deploy step, which would leave
# Terraform's lock held or a deploy half done if stopped. A cancel signals the step's
# processes (SIGINT, then SIGTERM), so this ignores both and puts the command in a session
# of its own, where they don't reach it. GitHub still kills it 5 minutes after the cancel.
trap '' INT TERM
exec setsid --wait "$@"
