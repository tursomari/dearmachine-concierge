# Concierge increment 1 in the installer repository

See [increment 3](concierge-increment-3.md) for current bootstrap, discovery,
systemd consent, and conversational management behavior. The notes below record
the earlier increments.

This checkout has no Dear Machine Go source or populated submodule. The native
supervisor, singleton lock, child ownership, backoff, and `dearmachine` dispatch
are implemented in the companion Go repository. This increment does not replace
the native supervisor with an interface-owned process.

## Control boundary

`SocketDaemonControl` is the client half of the version 1 local Unix socket
contract. The native supervisor implements and secures the server side
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
- optional `retryInMs` (nonnegative integer) and `lastExit` (string);
- optional `externalOwner` (boolean), a native CLI observation of another
  foreground or service owner. The concierge preserves its recovery explanation
  and refuses lifecycle mutations through a different supervisor. This field
  grants no authority to signal a PID or take ownership.

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
Existing `.dearmachine` state prevents automatic fresh installation; a
standalone `.machtiani` alone does not. File or symlink substitution, unreadable metadata, conflicting
control reports produce recovery guidance. Directory presence alone cannot prove
a healthy installation. The native `status --json` probe validates installation
state independently of supervisor availability. A stopped installation still
opens management and receives the startup update check. When native inspection
itself is unavailable, health is unknown, not partial; existing state is preserved.
Custom endpoints retain socket-only observations. The client does not parse
credentials or infer installation from whether a daemon happens to be running.

An observed installed-but-stopped daemon opens management without starting it.
Only absent state routes to the existing installer with its consent and model
wizard. After setup returns, detection runs again before a management handoff;
declining setup is not treated as success. The native bare `dearmachine` entry
now launches this executable as described below; its explicit rescue dispatch remains available in the Go checkout.

## Available launcher and local shell

Run `machtiani-installer` or `machtiani-installer --concierge` in a terminal for
the local concierge. On a fresh machine, supply
`--concierge --source-root /absolute/path/to/machtiani` to enter the existing
installer. Without a source root, the fresh-machine shell explains that command;
source discovery is deferred. Existing `--install --source-root ...` and `--mock`
entry points remain available. Bare non-TTY invocation and `--help` print help
without loading the TUI, DSH, model wizard, or provider modules.

`machtiani-installer status|up|down|restart` and `/up`, `/down`, `/restart`, `/status` use the same
control dispatcher. Exit code 0 means a successful observation or confirmed
operation (including an already-running/already-stopped no-op); 1 means invalid
arguments, missing prerequisites, failed status, or unconfirmed operation. Status
also returns 1 for failed/unreachable supervision, unknown daemon state, or
partial/unreadable installation. A stopped daemon alone is not an error.

Increment 2 aligns all TS control clients with the native endpoint contract:
`<dearmachine-state-dir>/run/supervisor.sock`. The default is
`$HOME/.dearmachine/run/supervisor.sock`, regardless of `XDG_STATE_HOME`.
On Linux the native `os.UserHomeDir` dependency requires nonempty HOME and has
no passwd/XDG fallback; the shared default resolver requires an absolute HOME.
TS follows the same rule. Go exports `supervisor.DefaultSocketPath` alongside
`SocketPath` for explicit state roots. Version 1 framing is unchanged.

TS accepts an absolute `DEARMACHINE_SUPERVISOR_SOCKET` override or an explicit
`SocketDaemonControl` constructor path for tests and non-default state roots.
The old `$XDG_STATE_HOME/machtiani-installer/supervisor.sock` location is usable
only by explicitly supplying that path; XDG still controls installer data.
This override does not redirect native state: it must point to the socket of
an owner configured for the intended state root. An absent owner must still be
bootstrapped with native `dearmachine up`; the TS client does not spawn owners.
Without an available owner, commands report unknown state and native recovery
guidance. They never launch an unsupervised replacement or signal a guessed PID.

`/help`, `/up`, `/down`, `/restart`, `/status`, `/quit`, and `/detach` are intercepted locally, including
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

Remaining user-story work includes agent-backed management with saved profiles,
actual attached ownership/log transfer, service capability probing and
persistence UI, and real logout/reboot verification. The existing installation agent, wizard, credential
bridge, and guarded product operations are reused when fresh setup is requested.

## Increment 2: foreground concierge handoff

Bare native invocation probes both stdin and stdout. `--help` always prints help;
explicit subcommands retain their scriptable/rescue behavior.

| stdin and stdout | Installation detection | Result |
| --- | --- | --- |
| Either is not a TTY | Not performed | Help, exit 0 |
| Both TTY | Absent | Launch `machtiani-installer --concierge`, adding `--source-root` when configured; TS selects fresh setup |
| Both TTY | Installed, including stopped | Launch `machtiani-installer --concierge` for management |
| Both TTY | Partial, unreadable, invalid, or substituted state | Recovery guidance, exit 1; no launch |

Discovery uses `DEARMACHINE_CONCIERGE_BIN` (one absolute executable path or PATH
name). When unset it resolves the exact name `machtiani-installer` on PATH.
Relative paths, shell command strings, and guessed checkout locations are not
supported. Missing/unexecutable binaries print the honest installer or management
guidance plus discovery instructions and exit 1. The override is not silently
replaced by another binary when discovery fails.

Set `DEARMACHINE_SOURCE_ROOT` to an absolute Machtiani umbrella source checkout
for fresh setup. Native absence routing passes it as `--source-root`; the TS
entry also accepts it for bare/`--concierge` launch. Explicit source arguments
win. This reuses the existing detection, installation consent, model wizard,
and post-install re-detection flow; opening the interface authorizes no product
changes. If no source root is configured, the TS fresh-machine shell retains
its exact setup command and local help. Source discovery/bundling remains a
prerequisite for a zero-configuration IXE launch.

The child inherits stdin, stdout, stderr, and environment and owns the foreground
terminal process group. The native parent waits and restores the original
foreground group. It installs no SIGINT handler and does not forward SIGINT:
terminal interrupts reach TS directly, preserving its two-second second-press
window. There is no daemonization or parent-death kill policy for the concierge;
normal terminal/session semantics apply. SIGTTOU is ignored only during foreground
restoration after the child exits.

Child exit codes propagate unchanged, including nonzero codes without duplicate
native error logging. Signal termination maps to `128 + signal` (e.g. SIGTERM
143). Discovery/launch failures exit 1; successful help and ordinary child exit
are 0. Merely opening or exiting the interface never starts/stops a daemon.
An unavailable owner remains an unconfirmed control outcome; explicitly bootstrap
it with native `dearmachine up`. The TS management interface provides local
commands; agent-backed conversation remains deferred.

## Verification

The maintained Vitest suite includes control socket fixtures, conservative entry
routing, provider-free command dispatch, shell lifecycle contracts, headless
terminal menu/credential boundaries, and real-PTY launch/exit checks. Every new
socket, home, state directory, and disposable process uses isolated test state.
No live provider, native daemon, systemd service, or credential is used. See
[the testing entrypoint](../TESTING.md) for commands.

Increment 2 verification: the app and TUI suites passed 145 tests across 13
files, including the opt-in native handoff gate with a supplied native binary.
The workspace build and repository typecheck passed. These tests exercise the
existing consent screen without contacting a provider or performing installation.
