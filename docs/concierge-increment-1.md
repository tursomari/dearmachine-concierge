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

## Available launcher and local shell

Run `machtiani-installer` or `machtiani-installer --concierge` in a terminal for
the local concierge. On a fresh machine, supply
`--concierge --source-root /absolute/path/to/machtiani` to enter the existing
installer. Without a source root, the fresh-machine shell explains that command;
source discovery is deferred. Existing `--install --source-root ...` and `--mock`
entry points remain available. Bare non-TTY invocation and `--help` print help
without loading the TUI, DSH, model wizard, or provider modules.

`machtiani-installer status|up|down|restart` and `/up`, `/down` use the same
control dispatcher. Exit code 0 means a successful observation or confirmed
operation (including an already-running/already-stopped no-op); 1 means invalid
arguments, missing prerequisites, failed status, or unconfirmed operation. Status
also returns 1 for failed/unreachable supervision, unknown daemon state, or
partial/unreadable installation. A stopped daemon alone is not an error.

The proposed endpoint is `$XDG_STATE_HOME/machtiani-installer/supervisor.sock`,
with `$HOME/.local/state` as the state-root fallback. These are installer-side
integration paths, not a claim about the native CLI's current socket location.
Without a compatible server, lifecycle requests fail with native CLI recovery
guidance. They never launch an unsupervised replacement or control the existing
native instance by a guessed PID.

`/help`, `/up`, `/down`, `/quit`, and `/detach` are intercepted locally, including
while a model choice or external sign-in is pending. Press Escape to return from
partially typed slash input to the pending menu. Masked credential input is never
interpreted as a command. Unknown slash commands and trailing arguments stay
local. Provider failures point to `/help`; management conversation is a future
integration, while this increment's management interface makes no model calls.

`/quit` and `/detach` serialize behind in-flight lifecycle commands. The shell's
attachment contract confirms independent ownership, unsubscribes logs, and only
then closes the interface. A failed handoff or unsubscribe keeps it open. The
current launcher does not own or attach to a daemon and has no log subscription,
so those callbacks are no-ops. Actual foreground-daemon transfer and log attachment
must be supplied by the future native integration; the fake attachment tests do
not prove a native transfer. PTY tests prove terminal restoration and that an
independently spawned disposable process survives interface exit.

The concierge and live installer use a two-second second-Ctrl+C window. Normal
input disarms it; expired windows cannot exit. The existing credential-specific
cancellation behavior is preserved. Lifecycle requests already sent are allowed
to settle (bounded by the control deadline); cancellation does not undo them.
The mock preview keeps its existing interrupt behavior.

Remaining user-story work includes native supervision and dispatch, agent-backed
management with saved profiles, actual attached ownership/log transfer, native
installation validation, service capability probing and persistence UI, and real
logout/reboot verification. The existing installation agent, wizard, credential
bridge, and guarded product operations are reused when fresh setup is requested.

## Verification

The maintained Vitest suite includes control socket fixtures, conservative entry
routing, provider-free command dispatch, shell lifecycle contracts, headless
terminal menu/credential boundaries, and real-PTY launch/exit checks. Every new
socket, home, state directory, and disposable process uses isolated test state.
No live provider, native daemon, systemd service, or credential is used. See
[the testing entrypoint](../TESTING.md) for commands.
