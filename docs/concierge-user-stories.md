# Concierge user stories

This is a first-increment draft of the intended concierge behavior. It does
not claim that the commands or supervision described here are implemented.
Running `dearmachine` with no arguments opens the concierge. The concierge
reuses the installer's DSH agent session setup, model-host profile, credential
bridge, and TUI. A deterministic CLI remains available for scripts and rescue.

The interface and daemon have separate lifetimes. Opening or leaving the
interface does not change daemon state. Starting, stopping, restarting, and
enabling persistence require an explicit user request or consent.

## 1. Install on a fresh machine

As a new user, I want `dearmachine` to guide me through setup without needing
to know a separate installer command.

Acceptance criteria:

- With no installation detected, the concierge enters the existing installer
  flow: welcome, model wizard, and guided installation.
- Installation detection distinguishes an absent installation from a stopped
  daemon. Partial, unreadable, or inconsistent state produces a diagnosis and
  recovery guidance; it does not trigger an overwrite or a second installation.
- The existing provider, sign-in, model, and reasoning choices remain in the
  model wizard. Credentials use the existing masked credential bridge and
  never enter the agent conversation or transcript.
- Existing installation consent and guarded product operations still apply.
  Merely launching the concierge does not authorize product changes.
- After successful installation, the interface reports the observed daemon
  state and offers management in the same concierge experience.

Test-driven coverage: Vitest unit and contract tests for detection, routing,
wizard composition, consent, and the management handoff. Headless fixtures
cover absent, installed-but-stopped, partial, and unreadable installations.
Reuse the existing installer test boundaries in [TESTING.md](../TESTING.md).

## 2. Manage an existing installation through conversation

As an installed user, I want to chat with the concierge about Dear Machine
and ask it to manage the daemon.

Acceptance criteria:

- An existing installation opens management without repeating installation.
  The concierge reuses the saved model-host profile and installer session,
  credential, and TUI boundaries.
- The agent can answer questions and invoke deterministic start, stop,
  restart, and status operations. Its reports reflect operation results;
  issuing a command is not evidence that it succeeded.
- A status question is read-only. A clear request such as “stop Dear Machine”
  authorizes that operation. Ambiguous requests require clarification before
  changing daemon state.
- The agent may ask “Should Dear Machine stay up after reboot?” It explains
  the proposed persistence change and waits for explicit consent. Silence,
  opening the interface, and consent to start once do not authorize persistence.
- Provider errors leave local help and deterministic controls usable.
- An explicit request to add or configure another backend can use the same
  masked credential helper after reopening the concierge. No key enters chat,
  prompts, or tool receipts. Existing backends and the shared model selection
  remain unchanged unless the user explicitly requests otherwise. The bridge
  is lazy and closes with the conversation; local controls do not depend on it.

Test-driven coverage: Vitest workflow and tool contract tests with a fake
agent and daemon adapter. Headless conversations verify result reporting,
read-only questions, explicit requests, and unanswered consent prompts.

## 3. Find help and recover without an LLM provider

As a user whose provider is unavailable, I want local help and commands that
let me inspect and control Dear Machine myself.

Acceptance criteria:

- `/help` is handled locally and lists the interface commands, their effects,
  and the deterministic commands below. It works before provider setup and
  when authentication fails, requests time out, or the provider is offline.
- The proposed CLI contract is:

  | Command | Effect |
  | --- | --- |
  | `dearmachine --help` | Show local command help without starting the concierge. |
  | `dearmachine status` | Report installation, supervisor, daemon, and persistence state. |
  | `dearmachine up` | Start Dear Machine through the selected supervisor. |
  | `dearmachine down` | Stop Dear Machine and cancel pending automatic restarts. |
  | `dearmachine restart` | Stop and start Dear Machine through the same supervisor. |

- `/help` also explains `/up`, `/down`, `/quit`, `/detach`, and Ctrl+C.
- These CLI commands run without a TUI, agent session, or provider request.
  They return documented exit codes and actionable errors. Status distinguishes
  a stopped daemon from a failed status query.
- Noninteractive invocations do not wait for conversational consent. A change
  requiring consent that has not been supplied fails with instructions.
- A provider failure displays how to reach local help; the user is never
  stranded behind a failed model request.

Test-driven coverage: Vitest command-dispatch and CLI contract tests. Headless
tests use a provider stub that fails if called and check help, lifecycle
commands, exit codes, and unavailable-control-endpoint errors.

## 4. Start and stop with `/up` and `/down`

As a user, I want short, predictable commands to start and stop Dear Machine.

Acceptance criteria:

- `/up` and `/down` execute locally through the same control boundary as
  `dearmachine up` and `dearmachine down`; neither depends on model availability.
- `/up` starts the daemon through supervisor-lite. If a usable systemd user
  manager is available and its use was explicitly consented to, it uses that
  integration. Otherwise, supervisor-lite runs independently of the interface.
- `/up` reports success only when startup is confirmed. If already running,
  it reports that state without creating another daemon.
- `/down` explicitly requests a stop, cancels pending restart attempts, and
  waits for confirmation. It reports a stop failure instead of claiming success.
  An already-stopped daemon is a successful no-op.
- Neither command silently changes reboot persistence. A missing installation
  produces installer guidance rather than silently installing.

Test-driven coverage: Vitest adapter contract tests for both supervision
paths, repeated commands, missing installations, and failed starts or stops.
Headless tests verify that slash commands and CLI commands have the same effects.

## 5. Leave with `/quit` or `/detach`

As a user, I want to leave the terminal interface while Dear Machine keeps
running.

Acceptance criteria:

- `/quit` closes the concierge session and restores the terminal. A running
  daemon keeps running; a stopped daemon stays stopped.
- `/detach` closes an interface attached to a foreground daemon or streaming
  logs while leaving the daemon up. It ends the interface's log subscription.
- A foreground attachment must establish independent supervisor ownership
  before the interface exits. If that cannot be done, the interface reports
  the failure and stays open; it does not kill or silently restart the daemon.
- `/quit` provides the same daemon-preserving handoff when needed. When the
  daemon is already independent, `/quit` and `/detach` are equivalent.
- Interface cleanup never invokes daemon stop. Help points users who want
  Dear Machine stopped to `/down` before they leave.

Test-driven coverage: Vitest lifecycle contracts for independent, attached,
and stopped states, including failed handoff. Headless terminal and real-PTY
tests verify terminal restoration and that a disposable daemon survives exit.

## 6. Interrupt without accidentally stopping Dear Machine

As a user, I want Ctrl+C to cancel current work without taking down the daemon.

Acceptance criteria:

- The first Ctrl+C cancels the running concierge operation. At an idle prompt,
  it displays a hint to use `/quit`. Both paths explain that a second Ctrl+C
  within a short window exits the interface only.
- The second Ctrl+C within that window follows the daemon-preserving exit
  behavior in story 5. The window has one documented duration; expiry or new
  ordinary input disarms it.
- Cancelling a model request, credential entry, or log stream does not send a
  stop signal to the daemon or supervisor.
- If an explicitly requested lifecycle operation has already committed,
  cancellation does not undo it or imply that it was undone. The interface
  reports the observed state or directs the user to `dearmachine status`.
- Signals and interface cleanup do not propagate to the independent daemon.

Test-driven coverage: Vitest fake-timer tests for the two-press window,
expiry, and disarming; headless tests for cancellation and state reporting;
real-PTY tests for idle, busy, and attached exits using disposable children.

## 7. Keep one supervised daemon running

As a user, I want a small supervisor to keep Dear Machine running and expose
its actual state without requiring an agent session.

Acceptance criteria:

- Supervisor-lite is a small non-agent process. It holds a singleton lock
  for the installation and runs the daemon as its child.
- Start, stop, restart, and status share one control contract. Concurrent
  starts, including starts through different interfaces, cannot create two
  supervisors or daemons for the same installation.
- Unexpected daemon exits trigger restart with bounded, increasing backoff.
  The initial delay, cap, and healthy-run reset rule are documented and
  deterministic. Status reports a pending retry and the last exit reason.
- An explicit stop cancels backoff and suppresses automatic restart. An
  explicit restart serializes stop and start so child processes never overlap.
- Status distinguishes starting, running, backing off, stopping, stopped,
  and failed or unreachable supervision. It exposes enough detail to diagnose
  startup and control failures without an LLM.
- Lock contention and stale state produce safe recovery or actionable errors.
  Recovery verifies ownership before acting on a process; a stale PID alone
  does not authorize signalling it.
- Closing the concierge does not release the supervisor's lock or end its child.

Test-driven coverage: Vitest unit tests with fake clocks and process adapters
for backoff and transitions; contract tests for lock ownership and control
errors; headless integration tests with disposable child processes for
concurrent starts, restart ordering, and stop during backoff.

## 8. Choose systemd and reboot persistence explicitly

As a user, I want to choose whether Dear Machine uses systemd and stays up
across logout or reboot.

Acceptance criteria:

- The concierge checks for a usable `systemd --user` manager. Systemd being
  installed alone does not make the integration available or authorize its use.
- Before configuring systemd, the concierge explains the change and obtains
  explicit consent. Declining leaves supervisor-lite available.
- Consent to use systemd for the current run is separate from consent to
  enable reboot persistence. Any required lingering change is explained and
  explicitly approved before it is applied.
- A saved, explicitly approved choice can be reused. Status reports the actual
  service and persistence configuration, including incomplete or failed setup.
- The integration defines which layer owns restart policy and ensures one
  daemon and one effective restart loop. Switching supervision cannot create
  duplicate children or discard an existing running daemon.
- `/down` stops the current daemon even when persistence is enabled. Help
  explains that a later login or reboot may start it again and lists the exact
  deterministic commands for inspecting and disabling the configured service
  and persistence settings. Those commands require no LLM.
- If persistence cannot be configured, the concierge reports the limitation
  and offers the available supervisor-lite behavior without claiming that
  reboot persistence is active.

Test-driven coverage: Vitest systemd adapter and consent contracts with fake
capability probes and command runners. Headless tests cover unavailable user
managers, declined consent, existing consent, lingering, and partial failures.
Real logout and reboot behavior needs a disposable systemd environment as a
later integration gate; mocked success alone does not prove persistence.

## Test workflow for the first increment

All stories have deterministic behavior suitable for test-first development.
Start with Vitest units and adapter contracts, then exercise the same workflows
through headless command and conversation drivers. Use the existing headless
installer patterns; the concierge headless controls described here are proposed
coverage, not existing public entry points. Terminal behavior also needs the
maintained headless terminal and real-PTY suites.

Tests use disposable installation roots, fake providers, and disposable child
processes. They do not read live credentials, control a native Dear Machine
instance, or enable services or lingering on the developer's account. Follow
[TESTING.md](../TESTING.md) when implementing these stories. This draft adds no
runtime behavior, test suite, or new test entry point.
