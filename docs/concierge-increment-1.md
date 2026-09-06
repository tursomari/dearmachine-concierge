# Concierge increment 1 in the installer repository

This checkout has no Dear Machine Go source or populated submodule. The native
supervisor, singleton lock, child ownership, backoff, and `dearmachine` dispatch
are deferred to that repository. This increment does not replace the native
supervisor with an interface-owned process.

## Control boundary

`SocketDaemonControl` is the client half of a proposed local Unix socket
contract. A future native supervisor must implement and secure the server side
in an owned private state directory. Each connection carries one newline-delimited
JSON request, `{ "version": 1, "command": "status" }`, where command is `status`,
`up`, `down`, or `restart`. No credentials or provider settings are transmitted.

A successful response is `{ "version": 1, "ok": true, "status": ... }` followed
by a newline. Status contains:

- `installation`: `absent`, `installed`, `partial`, or `unreadable`;
- `supervisor`: `starting`, `running`, `backing-off`, `stopping`, `stopped`,
  `failed`, or `unreachable`;
- `daemon`: `running`, `stopped`, or `unknown`;
- `persistence`: `enabled`, `disabled`, or `unknown`;
- optional `retryInMs` (nonnegative integer) and `lastExit` (string).

A mutation response must reflect observed state. An explicit stop must cancel
pending automatic restarts before reporting `supervisor: stopped`. An `ok`
response alone does not prove startup or shutdown. Errors use `ok: false`.
Arbitrary server error text is not shown in the interface.

The client caps responses at 64 KiB and applies a total five-second deadline.
It does not retry operations. Timeout, malformed response, and connection failure
mean unknown outcome, with instructions to inspect `dearmachine status`. An
unavailable endpoint never means that the daemon is stopped. The client neither
starts a supervisor nor falls back to signalling a PID.

`selectSupervision` is a policy seam only. It selects systemd only with a usable
user manager and explicit consent. Persistence needs its own explicit consent.
Capability probing, service creation, switching ownership, saved consent, and
lingering are deferred. No systemd commands run in this increment.

## Entry routing

The TypeScript entry seam checks both input and output TTYs before detection.
Existing `.dearmachine` or `.machtiani` directories prevent automatic fresh
installation. File or symlink substitution, unreadable metadata, conflicting
control reports, and an unavailable endpoint produce recovery guidance. Directory
presence alone cannot prove a healthy installation. A compatible control owner
must validate native state; this client does not parse credentials or infer
installation from whether a daemon process happens to be running.

An observed installed-but-stopped daemon opens management without starting it.
Only absent state routes to the existing installer with its consent and model
wizard. After setup returns, detection runs again before a management handoff;
declining setup is not treated as success. The actual native bare `dearmachine`
entry and its explicit rescue dispatch remain deferred to the Go checkout.
