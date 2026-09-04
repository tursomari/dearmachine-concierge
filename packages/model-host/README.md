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

API-key profiles currently support the pinned pi-ai catalogue entries for
OpenRouter, DeepSeek, and OpenAI. Keys live only in an owned mode-0600
environment file referenced by the mode-0600 model profile. The profile and
protocol contain a credential reference, never a credential value. API-key
login is performed by the installer’s masked field; protocol `auth/login`
therefore returns an actionable unsupported-capability response. Subscription
drivers own and refresh their official runtime profiles and are gated
independently.
