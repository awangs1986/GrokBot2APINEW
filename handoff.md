# GrokBot2API handoff

## Goal

Make this sidecar work with a locally logged-in Grok Bot desktop client and use
it as a reliable Pi Coding Agent provider, including the eventual Pi tool loop.

Repository: `https://github.com/awangs1986/GrokBot2APINEW`
Branch: `arena/01a0c8c1-grokbot2apinew`
Base commit: `3333634` (`feat: add Pi agent Responses integration and contract tests`)

## Current result

The project now has a third, explicitly opt-in transport for the current Grok
Bot desktop release (`0.30.0`):

- `src/upstream.mjs` remains the original `aiserver.v1.InferenceService/Stream`
  implementation. On this machine its live response was `unauthenticated`.
- `src/ai-service.mjs` remains a text-only diagnostic client for
  `aiserver.v1.AiService/StreamChat`. It reached the authenticated upstream but
  returned Connect `unimplemented` on September 22, 2026.
- `src/grok-bot-service.mjs` implements the current unary
  `aiserver.v1.GrokBotService` route used by the desktop app:
  `SendGrokBotUserMessage`, `GetGrokBotSendStatus`, and
  `ListGrokBotTranscriptEntries`. A metadata-only probe returned HTTP 200 with
  the desktop session credentials.

The new `GROKBOT_UPSTREAM_MODE=grokbot-service` path is text-only and requires
an explicitly supplied `GROKBOT_AGENT_ID`. It snapshots the transcript, sends a
nonce-tagged user message, waits for the matching user echo, and returns only a
newer assistant message. It never auto-selects a Bot and does not log tokens,
agent IDs, prompts, transcript bodies, or replies.

The reference project `cniu6/grok_bot_2api_temp` is useful evidence for the
overall product shape—an OpenAI-compatible sidecar in front of a Bot session—
but its old `desktop access token -> InferenceService/Stream` transport is not
the current working direction on this machine. We keep its gateway concept and
replace only the upstream adapter.

Pi tool calls are intentionally rejected in `grokbot-service` until the
GrokBot transcript tool-call/result/approval protocol is verified. Therefore a
successful metadata probe or offline Pi contract test is not evidence that
real Pi tools are connected.

## What changed, currently uncommitted

Do not overwrite the existing uncommitted work. The current worktree contains:

- `src/credentials.mjs`, `test/credentials.test.mjs`, `.env.example`, and
  `README.md`: Linux Grok Bot Safe Storage plus Secret Service credential
  reading. It reads on each request and does not write desktop credentials.
- `src/ai-service.mjs`: an explicit `ai-stream-chat` diagnostic transport.
  It implements the statically verified `GetChatRequest` /
  `StreamChatResponse` protobuf shape and rejects tool requests explicitly.
- `src/grok-bot-service.mjs`: the current desktop `GrokBotService` unary
  transport and nonce-correlated durable transcript reader. Text only.
- `src/server.mjs`: selects the diagnostic transport only if
  `GROKBOT_UPSTREAM_MODE=ai-stream-chat` or
  `GROKBOT_UPSTREAM_MODE=grokbot-service`; default remains `inference`.
- `test/ai-service.test.mjs`: framing, protobuf encoding, text decoding,
  tool-rejection, and mode-selection coverage.
- `test/grok-bot-service.test.mjs`: protobuf request/response coverage,
  transcript nonce correlation, stable legacy rows, generation checks,
  explicit-agent enforcement, and tool rejection.
- `docs/pi-agent.md` and `.env.example`: document the Linux credential reader
  and both diagnostic/current service modes.

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
npm run test:pi
git diff --check
```

Most recent result on September 23, 2026: `npm test` had 61 passing tests and
2 pre-existing skipped real-Grok-CLI tests; `npm run test:pi` had 3 passing
tests; `npm run check` and `git diff --check` passed. The ordinary sandbox
cannot bind loopback test ports, so the full suite was run with local test
permission. No live Grok Bot message was sent.

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

Perform one controlled live text smoke only after the user supplies a
throwaway/test Bot's agent ID or explicitly authorizes a test Bot:

```sh
GROKBOT_UPSTREAM_MODE=grokbot-service
GROKBOT_AGENT_ID=<user-authorized-test-agent-id>
node --env-file=.env bin/grokbot2api.mjs
pi --provider grokbot --model grok-4.5 --thinking off --no-tools -p "只回复 OK"
```

The smoke report must contain only delivery status, whether the nonce echo and
assistant reply arrived, elapsed time, and reply size. Do not print the agent
ID, prompt, reply, transcript, authorization header, or any token.

If text succeeds, statically and then safely inspect the Grok Bot transcript
tool-call/result/approval entries. Add a separate fake-upstream regression
test for each discovered entry before enabling any Pi tool. Do not silently
drop tool definitions or pretend the old `InferenceService` path is valid.

## Suggested skills

- `diagnosing-bugs`: establish the live transport feedback loop before
  hypothesizing another endpoint.
- `code-review`: review the accumulated uncommitted changes before committing.
