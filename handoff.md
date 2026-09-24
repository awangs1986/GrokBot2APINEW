# GrokBot2API handoff

## Goal

Make this sidecar work with a locally logged-in Grok Bot desktop client and use
it as a reliable Pi Coding Agent provider, including the eventual Pi tool loop.

Repository: `https://github.com/awangs1986/GrokBot2APINEW`
Branch: `arena/01a0c8c1-grokbot2apinew`
Base commit: `3333634` (`feat: add Pi agent Responses integration and contract tests`)

## September 24, 2026 update

- Session isolation is now implemented: `src/session-agents.mjs` maps a stable
  Pi session ID plus the authenticated desktop account to one dedicated
  temporal Grok Bot. The Bot is created on first request and preserved. The
  mapping is atomic, mode 0600, and survives sidecar restarts; a persisted
  pending creation is checked against the agent list before retrying. Session
  IDs and account IDs are hashed, not written in plaintext. A request without
  a stable session ID fails before any creation or message send.
- The normal 8793 user service has been switched off the formerly shared test
  Bot. Real Pi verification with three sequential text requests confirmed:
  session A creates one Bot, A's second request reuses it, session B creates a
  different Bot. All three received successful replies. The earlier shared
  Bot was not deleted; no automatic deletion is implemented.
- `npm test`: 71 pass, 2 pre-existing skips; `npm run test:pi`: 4 pass;
  `npm run check` and `git diff --check` pass. Only text-only Pi requests work;
  the Pi tool loop remains explicitly blocked.
- Local Pi is `@earendil-works/pi-coding-agent@0.87.1`; this repository now pins
  that same version for contract tests. Its existing `grokbot` provider points
  to a user-level sidecar service on loopback port 8793. The local `.env` link
  points to a private 0600 config outside the repository. Neither the ID nor
  any credential belongs in this handoff.
- A real Pi text-only `/skill:name` call succeeded against the authorized test
  Bot with one upstream send, no tools, and a response matching the skill's
  instruction. The new `test/pi_skill_contract.test.mjs` recreates the skill
  prompt path with fake RPCs. `npm run test:pi` includes this test.
- Explicit text-only skill instructions are included in the Pi user message
  and currently reach Grok Bot. Automatic skill selection is *not* supported:
  the adapter still ignores Pi's system prompt, and it does not implement
  Pi tool definitions/results or full chat history. Desktop tool-call and
  approval RPCs do not establish an arbitrary Pi tool-result round trip.
- The local uncommitted transcript safety fix now requires both an exact user
  nonce and the same nonempty `requestId` on the assistant row. The previous
  code could mistake another conversation's newer reply for this one's.
  `test/grok-bot-service.test.mjs` covers this. The local service was restarted
  while idle and is healthy.
- `grok-4.5` is only the Pi/sidecar-facing compatibility model name in the
  current `GrokBotService` path. Its send RPC carries no model selector; the
  target Bot decides which actual model runs.
- The real skill smoke is separate from the fake-upstream tests.

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
a stable Pi session ID. It creates a dedicated Bot for each session/account,
snapshots that Bot's transcript, sends a nonce-tagged user message, waits for
the matching user echo, and returns only a reply with the same request ID. It
does not log tokens, agent IDs, prompts, transcript bodies, or replies.

The reference project `cniu6/grok_bot_2api_temp` is useful evidence for the
overall product shape—an OpenAI-compatible sidecar in front of a Bot session—
but its old `desktop access token -> InferenceService/Stream` transport is not
the current working direction on this machine. We keep its gateway concept and
replace only the upstream adapter.

Pi tool calls are intentionally rejected in `grokbot-service` until the
GrokBot transcript tool-call/result/approval protocol is verified. Therefore a
successful metadata probe or offline Pi contract test is not evidence that
real Pi tools are connected.

On September 23, 2026, a controlled no-tool smoke reached the new
`GrokBotService` path but initially timed out with `grokbot_response_timeout`.
The timeout was caused by two decoder assumptions, not by an invalid agent:

- `GrokBotAgent.agent_id` is protobuf field 12 (field 2 is the legacy ID;
  field 1 is the server/display ID).
- In the current desktop transcript, completed assistant text is a
  `kind:"send-message"` row whose `message.type` is `text` and whose reply is
  in `message.content`. It is paired with the user row by `requestId`; the
  user row still carries the exact `clientNonce`.

The live transcript contains these rows and the fixed nonce correlator now
replays the latest real reply successfully without sending a new message.
Pi's default retry caused a second delivery attempt during the failed smoke,
so future live smoke runs must disable retry.

## Earlier implementation history (before the September 24 update)

The following files were part of the earlier implementation and are now tracked
in the repository. Preserve the separate local edits described above:

- `src/credentials.mjs`, `test/credentials.test.mjs`, `.env.example`, and
  `README.md`: Linux Grok Bot Safe Storage plus Secret Service credential
  reading. It reads on each request and does not write desktop credentials.
- `src/ai-service.mjs`: an explicit `ai-stream-chat` diagnostic transport.
  It implements the statically verified `GetChatRequest` /
  `StreamChatResponse` protobuf shape and rejects tool requests explicitly.
- `src/grok-bot-service.mjs`: the current desktop `GrokBotService` unary
  transport and nonce-correlated durable transcript reader. It accepts both
  legacy assistant message rows and current completed `send-message` text rows.
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

Most recent result on September 23, 2026: `npm test` had 63 passing tests and
2 pre-existing skipped real-Grok-CLI tests; `npm run test:pi` had 3 passing
tests; `npm run check` and `git diff --check` passed. The ordinary sandbox
cannot bind loopback test ports, so the full suite was run with local test
permission. The live transcript replay was read-only; no new Grok Bot message
was sent during the final verification.

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

Implement Pi's actual tool-call/result protocol only after finding a verified
way to advertise Pi tools to the current Grok Bot service. The existing
`SendGrokBotUserMessage` request has no tools field. Do not interpret desktop
tool activity as Pi tool calls or enable Pi's `read`/`bash` without a real
function-call round trip and explicit safety checks. Keep the local session
store private and run one sidecar instance per store.

## Suggested skills

- `diagnosing-bugs`: establish the live transport feedback loop before
  hypothesizing another endpoint.
- `code-review`: review the accumulated uncommitted changes before committing.
