# GrokBot2API handoff

## Goal

Make this sidecar work with a locally logged-in Grok Bot desktop client and use
it as a reliable Pi Coding Agent provider, including the eventual Pi tool loop.

Repository: `https://github.com/awangs1986/GrokBot2APINEW`
Branch: `arena/01a0c8c1-grokbot2apinew`
Base commit: `3333634` (`feat: add Pi agent Responses integration and contract tests`)

## Current result

The local HTTP sidecar, Pi provider configuration, and Linux desktop credential
reader are working independently. The live upstream protocol is the blocker:

- The original client in `src/upstream.mjs` calls
  `aiserver.v1.InferenceService/Stream`; the live upstream returns
  `unauthenticated`.
- The experimental text-only client in `src/ai-service.mjs` calls
  `aiserver.v1.AiService/StreamChat`; it reaches the authenticated upstream but
  ends with Connect error `unimplemented`.
- A one-off probe of `AiService/StreamChatTryReallyHard` also ended with
  `unimplemented`.

Therefore Pi cannot yet make a successful real text request, and Pi tools
cannot be considered connected. The temporary probe services were stopped; the
existing local sidecar on its normal port was not restarted or reconfigured.

## What changed, uncommitted

Do not overwrite the existing uncommitted work. The current worktree contains:

- `src/credentials.mjs`, `test/credentials.test.mjs`, `.env.example`, and
  `README.md`: Linux Grok Bot Safe Storage plus Secret Service credential
  reading. It reads on each request and does not write desktop credentials.
- `src/ai-service.mjs`: an explicit `ai-stream-chat` diagnostic transport.
  It implements the statically verified `GetChatRequest` /
  `StreamChatResponse` protobuf shape and rejects tool requests explicitly.
- `src/server.mjs`: selects the diagnostic transport only if
  `GROKBOT_UPSTREAM_MODE=ai-stream-chat`; default remains `inference`.
- `test/ai-service.test.mjs`: framing, protobuf encoding, text decoding,
  tool-rejection, and mode-selection coverage.
- `docs/pi-agent.md` and `.env.example`: document the Linux credential reader
  and that `ai-stream-chat` is a failing diagnostic mode, not a workaround.

Review the diff rather than duplicating it:

```sh
git diff -- .env.example README.md docs/pi-agent.md src/credentials.mjs src/server.mjs test/credentials.test.mjs
git diff --no-index /dev/null src/ai-service.mjs
git diff --no-index /dev/null test/ai-service.test.mjs
```

## Verified checks

Run from the repository root:

```sh
npm run check
npm test
git diff --check
```

Most recent result: 49 passing tests, 2 pre-existing skipped real-Grok-CLI
tests, no diff whitespace errors.

## Pi notes

- Pi is configured as a custom `grokbot` provider using the Responses API;
  see `docs/pi-agent.md` and `examples/pi/models.json`.
- The `picode` extension emits an unrelated stale Antigravity catalog-context
  error. Use `pi --no-extensions ...` while diagnosing the sidecar.
- `--no-extensions` removes that extension error but does not change the live
  upstream failure.

## Important safety constraints

- Never print, commit, or persist access tokens, refresh tokens, downstream API
  keys, Secret Service values, Authorization headers, or raw captured chat
  bodies.
- Do not overwrite the user's local Pi model configuration; merge provider
  entries only.
- Keep probes on loopback and use separate temporary ports. Do not restart a
  working desktop client or change its stored credentials.

## Suggested next step

Find the Grok Bot desktop client's actual current inference transport before
adding another sidecar mode. Static inspection shows newer unified chat and
remote-agent protobuf wrappers, but the two simple `AiService` text methods are
not live on this account. Earlier metadata-only network observation did not
capture a new request when the user sent three desktop messages, suggesting a
pre-existing long-lived connection or another isolated transport.

Build a narrow, secret-safe feedback loop first: capture only endpoint,
method/service name, status, frame sizes, and timing from the desktop client's
actual chat transport. Do not capture headers or body content. Once a concrete
live RPC is found, add a dedicated client with a fake-upstream regression test,
then do one non-tool live smoke before attempting Pi tools.

## Suggested skills

- `diagnosing-bugs`: establish the live transport feedback loop before
  hypothesizing another endpoint.
- `code-review`: review the accumulated uncommitted changes before committing.
