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
- `auth/status`, `auth/login`, and `auth/logout`
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

OpenAI Codex subscription support is pinned to `@openai/codex` 0.153.2 and
uses app-server device-code authentication, model discovery, streaming,
cancellation, and dynamic tools. GitHub Copilot subscription support is pinned
to `@github/copilot` 1.0.83 and `@github/copilot-sdk` 1.0.11 and runs SDK
sessions in `empty` mode with only caller-declared tools. Either integration
can be removed from the wizard with `MACHTIANI_DISABLE_OPENAI_CODEX=1` or
`MACHTIANI_DISABLE_GITHUB_COPILOT=1`.

Canonical integration references are the OpenAI
[Codex app-server](https://developers.openai.com/codex/app-server) and
[authentication](https://developers.openai.com/codex/auth) documentation and
GitHub's [Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)
documentation.

Claude Pro/Max subscription support is deliberately not advertised or
activated. As of 2026-09-04, Anthropic's official Agent SDK authentication
documentation does not explicitly authorize a third-party installer to use a
consumer subscription. Agent SDK 0.3.260 is the reviewed integration candidate
and the provider has a separate policy-and-environment gate, but the SDK is not
shipped and that gate must remain closed until a reviewed Anthropic source
permits the use.
