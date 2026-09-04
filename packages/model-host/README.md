# Machtiani model host

This package is the private, versioned provider boundary shared by the
Machtiani Installer and installed Machtiani. It preserves provider-native
protocol and authentication behavior; neither caller assumes that a selected
model implements OpenAI Chat Completions.

Protocol version 1 uses newline-delimited JSON over private stdio. Every
request carries `v`, `id`, `method`, and optional `params`; every response
carries the matching `id` and exactly one `event`, `result`, or structured
`error`. Supported methods are:

- `initialize`
- `models/list`
- `auth/status`, `auth/login`, and `auth/logout` (`auth/login` accepts an optional
  `mode` of `browser` or `device_code`)
- `generation/start` and `generation/cancel`

Generation requires explicit `caller` and `sessionId` values. Messages and
stream events never cross sessions. Events cover text, reasoning, tool calls,
usage, and finish reasons. Stable errors distinguish missing or expired
authentication, throttling, exhausted quota, unavailable models, unsupported
capabilities, cancellation, upstream incompatibility, invalid requests, and
internal failure.

API-key profiles support the pinned pi-ai catalogue entries for OpenRouter,
DeepSeek, and OpenAI. Keys live only in an owned mode-0600
environment file referenced by the mode-0600 model profile. The profile and
protocol contain a credential reference, never a credential value. API-key
login is performed by the installer’s masked field; protocol `auth/login`
therefore returns an actionable unsupported-capability response. Subscription
drivers use the official runtime's existing profile and refresh behavior; the
installer never reads or copies subscription tokens.
Official runtime subprocesses receive a small locale/certificate environment
rather than the installer's ambient provider credentials.

Custom OpenAI-compatible profiles deliberately use a separate driver and
profile shape. They store a display name, the exact model ID, and a complete
`/chat/completions` endpoint. Remote endpoints must use HTTPS and may not point
at a literal loopback host. Local endpoints may use HTTP or HTTPS but must use
`localhost`, `127.0.0.1`, or `[::1]`. Redirects are not followed. API keys are
optional; when omitted, the client explicitly omits the Authorization header.
When present, the key uses the same private credential-file boundary as the
built-in providers. An optional reasoning level is sent only when the user
selects one.

The installer validates a custom profile with two streamed Chat Completions
requests before it is selected: a required function call, followed by a normal
assistant continuation after the function result. The selection is retained
only after this live test passes. The protocol behavior follows the official
[OpenAI Chat Completions reference](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions).

OpenAI Codex subscription support is pinned to `@openai/codex` 0.153.2 and
uses app-server browser-callback or device-code authentication, model discovery,
streaming, cancellation, and dynamic tools. Browser sign-in is intended for a
local desktop; device codes remain available for SSH, containers, and headless
installs. GitHub Copilot subscription support is pinned
to `@github/copilot` 1.0.83 and `@github/copilot-sdk` 1.0.11 and runs SDK
sessions in `empty` mode with only caller-declared tools. Either integration
can be removed from the wizard with `MACHTIANI_DISABLE_OPENAI_CODEX=1` or
`MACHTIANI_DISABLE_GITHUB_COPILOT=1`.

Anthropic Claude Pro/Max subscription support is pinned to Claude Agent SDK
0.3.260, including its Claude Code 2.1.260 runtime. The wizard runs the official
`claude auth login --claudeai` browser flow in an isolated
`CLAUDE_CONFIG_DIR`, asks the SDK for the signed-in account's current model and
effort catalogue, and uses a one-turn SDK session with only caller-declared MCP
tools. Built-in Claude Code tools, settings, plugins, and session transcripts
are disabled. The authorization code is written directly to Claude Code and is
never added to the installer transcript. Set
`MACHTIANI_DISABLE_ANTHROPIC_CLAUDE=1` to remove this route from the wizard.

Canonical integration references are the OpenAI
[Codex app-server](https://developers.openai.com/codex/app-server) and
[authentication](https://developers.openai.com/codex/auth) documentation and
GitHub's [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
documentation. The Claude route follows Anthropic's official
[Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started),
[Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), and
[model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)
documentation.
