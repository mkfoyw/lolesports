.PHONY: publish

CODEX ?= $(shell command -v codex 2>/dev/null)
ifeq ($(CODEX),)
CODEX := /Applications/ChatGPT.app/Contents/Resources/codex
endif

# Publish the current project through the Sites connector.
publish:
	@test -x "$(CODEX)" || { echo "Codex CLI not found. Set CODEX=/path/to/codex." >&2; exit 1; }
	@"$(CODEX)" exec --approve-for-me -C "$(CURDIR)" 'Publish this existing project to Sites. Read .openai/hosting.json and use its exact project_id. Use the Sites hosting workflow and connector to prepare the current source, run the required checks and build, save a version, deploy it while preserving the current audience, wait for success, and print the live URL. Do not run make publish or start another Codex process. Preserve unrelated local changes.'
