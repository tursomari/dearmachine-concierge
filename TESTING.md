# Testing Machtiani Installer

This is the canonical entrypoint for Machtiani Installer testing. It owns the
maintained TypeScript suites, build checks, terminal exercises, DSH smoke test,
and the containerized Installation Experience Evaluation (IXE) and Quality
Scenario Evaluation (QSE).

Run commands from the repository root. Use the pinned Node and pnpm toolchain
through Nix rather than a globally installed package manager.

## Recommended starting checks

Prepare dependencies once in a new worktree, then run the deterministic checks:

```console
nix develop -c pnpm install --frozen-lockfile
nix develop -c pnpm typecheck
nix develop -c pnpm test
```

Before landing, also prove that the isolated runtime closure builds:

```console
nix build
```

For a change that affects installation composition, source transfer, the
terminal lifecycle, or product installation, run the uncredentialed QSE
self-test after the deterministic checks:

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani --self-test
```

The credentialed live QSE is a release gate, not a routine inner-loop test.

## macOS build targets

The flake exposes `x86_64-darwin` and `aarch64-darwin`. Intel macOS uses a
separate pinned Nixpkgs 26.05 input because the main unstable input no longer
supports that platform. Linux and Apple Silicon keep the existing input.
Evaluating either derivation on Linux checks packaging expressions only; run
`nix build` and the tests on the corresponding Mac before claiming support.
The macOS wizard offers Nix and Standard; Standard uses a native build
through the umbrella builder. The umbrella macOS guide tracks runtime verification
and the remaining lifecycle limitations.

Run `nix flake check` on the target Mac as well. Its Node worker file test
catches the file-descriptor tracking corruption in older Darwin Node 24
builds that can abort pnpm installation (NixOS/nixpkgs#536039). The Intel
input includes the upstream fix; a successful evaluation alone cannot
verify this runtime behavior.

The dependency cache includes platform-specific optional binaries. Keep the
Intel and Apple Silicon cache hashes separate from the Linux hash when
updating the lockfile.

On Intel macOS, `nix develop` can try to acquire Bash from the main unstable
input before entering the selected development environment. If that fails
and falls back to Apple's older Bash, use the packaged tool environment:

```console
nix shell .#build-dependencies -c pnpm install --frozen-lockfile \
  --network-concurrency=1 --child-concurrency=1
nix shell .#build-dependencies -c pnpm typecheck
nix shell .#build-dependencies -c pnpm test
```

## Maintained TypeScript suites

| Entrypoint | Coverage | Safety and cost |
| --- | --- | --- |
| `nix develop -c pnpm typecheck` | Repository-wide TypeScript interfaces and package boundaries | Credential-free; no product mutation |
| `nix develop -c pnpm test` | Builds every workspace package, then runs the maintained Vitest suites | Credential-free; creates build and test artifacts only |
| `nix develop -c pnpm build` | Compiles all workspace packages without running Vitest | Credential-free |
| `nix build` | Reproducible Nix package and isolated runtime closure | Credential-free; may download/build dependencies |

The active Vitest configuration collects `packages/*/tests/**/*.spec.ts` and
`packages/*/tests/**/*.snapshot.ts`. Those suites cover:

- application locking, source-root validation, headless composition, model
  wizard behavior, credential bridging, and real-PTY lifecycle handling;
- DSH adaptation, model-host and subscription drivers, backend discovery,
  environment diagnosis, credential storage, and guarded product operations;
- canonical workflow stage ordering and prompt contracts; and
- terminal snapshots, layouts, secure input, interruption, rendering, and
  restoration.

Use Vitest's normal file or name filters after `pnpm build` for focused work;
the full `pnpm test` remains the maintained aggregate suite.

## Standard build wizard and handoff

The existing `installation-method.spec.ts` and `installation-wizard.spec.ts`
suites cover Nix/Standard selection, back navigation, build failure,
and exit before provider setup. Other Linux hosts and macOS offer two choices with Nix selected by default. NixOS skips the method menu; Back and prerequisite failures return to consent. The suites reject the retired third container selection. `nix-prerequisites.spec.ts` covers missing features, absent Nix, and private diagnostic handling. `container-build.spec.ts` exercises the real
subprocess handoff with a fixture builder: validated manifest, paths containing
spaces, retained diagnostics and cancellation. They run through `pnpm test`.

The umbrella owns the actual Docker recipe, source isolation and activation
tests. Its shared runtime smoke gate and IXE VM acquisition exercise use the
same production builder. Do not duplicate them in this component or treat a
mocked command runner as proof that a Docker-built runtime works.

## Concierge increment checks

### Empty model responses

After building, `nix develop -c node tests/empty-response.mjs "$PWD"` runs the
real installer and concierge against a credential-free loopback provider. It
checks recovery from reasoning-only completions before and after a tool,
without replaying that tool, and failure after the bounded retry budget.
It also verifies that the shared and mode-specific system instructions reach
every provider request, including retries. This proves prompt delivery, not live
model compliance with those instructions.
It accepts a packaged runtime root as well. No product or external service is used.

### Credential security boundary

`packages/dsh-adapter/tests/credential-boundary.spec.ts` tests trusted credential
discovery, alias denial, whole-result inspection, mid-session key changes,
fail-closed errors, and the independent model-egress check with counterfeit
values. No actual provider keys are needed.

After building, run the real DSH regression in a disposable test process:

```console
nix develop -c node tests/credential-boundary.mjs "$PWD"
```

Alternatively pass an absolute packaged `libexec/machtiani-installer` root.
The gate creates and removes its own HOME, uses a loopback-only fake provider,
and tests both concierge and installer. It reproduces direct credential reads,
symlink/hardlink aliases, copied keys, shell stdout/stderr and encoding, and
credentials saved during a session. Every model request and decoded session
artifact is checked. Ordinary backend configuration must remain readable.
Do not substitute real keys or a real home; a deliberately unsafe old runtime
is expected to fail this gate. See [the security contract](docs/credential-security.md).

### Lifecycle and configuration

`concierge-shell.spec.ts` checks that `/uninstall` only displays the terminal
command and confirmation instructions, without a model request, daemon operation
or interface shutdown. The shared prompt directs natural-language uninstall
requests to the same human-run native command. Actual destructive removal is
covered by the umbrella `tests/uninstall/run.py` container gate and DearMachine's
native tests; see the umbrella `tests/uninstall/README.md` for isolation and
coverage limits.

`packages/app/tests/assistant-model.spec.ts` covers private selection commits,
cancellation, failed catalogues, old-profile migration, and subscription account
reuse. `model-switch-pty.spec.ts` drives `/model` through the real concierge TUI
against a loopback provider, verifies preserved conversation history, and cancels
from the provider menu. Both belong to `pnpm test` and use disposable homes.

After building, `nix develop -c node tests/model-switch.mjs "$PWD"` verifies both
real installer and management DSH sessions: interrupt a hung loopback request,
switch provider endpoint and model, clear an old reasoning level, and continue
with the previous conversation intact. It also accepts a packaged runtime root.
It uses no credentials or external service and does not install products.

`packages/app/tests/launch-environment.spec.ts` checks minimal-PATH child
discovery, caller precedence, idempotence, and the real CLI-to-native bootstrap
boundary. `packages/app/tests/credential-context.spec.ts` verifies that secure
entry remains generic while preparation metadata is scoped to Forge 2.13.21.
These tests use fake executables/credentials and do not make provider requests.

The concierge tests are part of the maintained aggregate suite. After `pnpm build`,
run the focused contracts and terminal exercises with:

```console
nix develop -c pnpm exec vitest run packages/app/tests/concierge-control.spec.ts packages/app/tests/concierge-entry.spec.ts packages/app/tests/concierge-shell.spec.ts packages/app/tests/concierge-cli.spec.ts packages/tui/tests/concierge.spec.ts packages/app/tests/concierge-bootstrap.spec.ts packages/app/tests/concierge-consent.spec.ts packages/app/tests/concierge-agent.spec.ts packages/dsh-adapter/tests/adapter.spec.ts
```

They use temporary homes/state/socket paths and disposable processes, with no
provider requests or native Dear Machine control. The socket server and attachment
handoff are fixtures; these tests do not verify a native supervisor implementation.
See [the increment split and contract](docs/concierge-increment-1.md).

For the optional cross-repository gate, build the companion Go CLI and supply
its absolute binary path (the suite skips when it is unset):

```console
DEARMACHINE_TEST_BIN=/absolute/path/to/test-dearmachine nix develop -c pnpm exec vitest run packages/app/tests/concierge-native.spec.ts
```

Increment 3 adds bootstrap/race/deadline, separate consent, lazy management agent,
and failed-provider fallback coverage. Mock systemctl/loginctl runners never
configure a real service. See [increment 3](docs/concierge-increment-3.md).

`packages/app/tests/concierge-credentials.spec.ts` exercises a reopened
management session with the real private socket and credential helper process:
lazy setup, masked-entry delegation, owner-only storage, preserving independent
provider entries, reuse after reopening, and cleanup after provider startup
failure. The agent and key are fixtures, not live credentials. Shared bridge
tests cover cancellation and shutdown while a secure field is pending.

All gates must be launched with disposable HOME, XDG state/config/data/runtime
directories and DEARMACHINE_SUPERVISOR_SOCKET. Individual fixtures further isolate
state. With existing pnpm dependencies and a disposable HOME,
`pnpm --config.verify-deps-before-run=false ...` skips pnpm's store relocation
check without reinstalling dependencies.

`packages/app/tests/interface-preferences.spec.ts` covers private, atomic
command-display preference persistence and safe defaults for absent/invalid
files. The concierge credential composition suite also checks that both
visibility choices reach newly opened management agents. Command-display
redaction stays covered by the DSH adapter suite. The preference lives in
`~/.config/dearmachine/interface.json`, separate from model and credential files.

The concierge native CLI gate runs the actual native foreground launcher and
supervisor with a disposable HOME, socket, registry, and dummy daemon. It
exercises fresh-install consent, all lifecycle slash commands, terminal
restoration, and two-press Ctrl+C with the built TS entry. It never starts the
real provider-backed daemon.

### Forge custom-provider wire gate

After building the backend package, `tests/forge-custom-provider.mjs` exercises
the real pinned Forge 2.13.21 executable against a loopback Chat Completions
server. It verifies exact endpoint, authentication, model, preserved provider
definitions, private-store migration, cleanup, and a fresh process reusing the
credential without an environment key. It uses only a fake key and creates and
removes its own temporary homes. Closed stdin matters: Forge otherwise waits
for piped input even for some CLI commands.

Run it in a fresh container with a cached image, no network, and read-only
mounts of the build outputs and fixture binary. This is a component integration
test, not the mount-free natural-language IXE. Example (substitute existing
paths; no builds or pulls are performed by this command):

```bash
docker run --rm --network none --entrypoint /nix/store/EXISTING-NODE/bin/node \
  -e PATH=/usr/local/bin:/usr/bin:/bin:/nix/store/EXISTING-GIT/bin \
  -v /nix/store:/nix/store:ro \
  -v /absolute/cached/forge-2.13.21:/usr/local/bin/forge:ro \
  -v "$PWD/packages/backend-adapter/dist:/helper:ro" \
  -v "$PWD/packages/credential-adapter/dist:/credentials:ro" \
  -v "$PWD/tests/forge-custom-provider.mjs:/test.mjs:ro" \
  machtiani-ixe-standard:local /test.mjs
```

The pinned Forge transport drops explicit reasoning effort for arbitrary
custom provider IDs, despite accepting its configuration setting. The adapter
therefore rejects a requested level before mutation and requires a human choice
about provider defaults; do not weaken this assertion or silently run an
approved high-reasoning external test at a provider default. The loopback gate
uses provider defaults deliberately. Named-provider reasoning tests remain in
the maintained backend adapter suite. This gate is not a credentialed DeepInfra
availability test or a full installer experience pass.

## Manual terminal exercises

These are interactive product exercises, not substitutes for automated tests:

| Exercise | Command | Boundary |
| --- | --- | --- |
| No-mutation preview | `nix run '.#' -- --mock` | Uses the real TUI but installs no products or credentials |
| Guided local composition | `nix run '.#' -- --install --source-root /absolute/path/to/machtiani` | Can collect credentials and change product state; use only in an expressly disposable or authorized environment |

Both commands require a real TTY. Ctrl+C and terminal restoration behavior are
also covered by the automated PTY suite; manual success alone is not the gate.

## Live DSH recursion smoke

```console
nix develop -c ./scripts/dsh-smoke
```

This opt-in test requires a disposable or expressly authorized OpenRouter
credential in the documented environment. It verifies one model route,
reasoning configuration, a harmless shell-tool call/result round trip, exact
final response, clean exit, and absence of the credential from the isolated
runtime tree. It makes a provider request and can incur charges. It does not
exercise product installation or email.

## Subscription runtime handoff

`nix develop -c bash tests/subscription-runtime-smoke.sh` exercises the focused
smoke harness with fake executables and disposable profiles. It checks both
provider paths, reuse of installer-created state, and two four-role verification
runs without reading live credentials or contacting a provider.

For the human-assisted runtime gate, use `scripts/subscription-runtime-smoke`
with `openai-codex` or `anthropic-claude`, an explicitly selected model, and
absolute `MACHTIANI_BIN` and `MACHTIANI_MODEL_HOST_BIN` paths from the candidate
builds. The [README's subscription instructions](README.md) document profile
selection and the complete invocations. Run once per provider with its
installer-created profile/configuration. This gate uses provider-owned sign-in,
verifies planner, shell-agent, answer, and file-discovery across fresh processes,
and stops before Dear Machine installation or email. The fake harness test does
not establish live subscription readiness.

## Containerized IXE/QSE

The canonical harness is `tests/e2e/run.sh`; its detailed operational contract
is in [`tests/e2e/README.md`](tests/e2e/README.md).

### Uncredentialed self-test

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani --self-test
```

The self-test validates context contracts, exact recursive Git fixtures and
cleanup machinery. It does not require Docker or run the snapshot/PTY suite,
read live credentials, provision inboxes, send email, or invoke a remote model.
The live runner builds the image and runs the snapshot/PTY suite before loading
credentials.

### Live QSE

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani
```

Run the live form only with the approved OpenRouter and AgentMail credentials
in their documented private locations. It provisions and journals exactly two
disposable AgentMail inboxes, conducts the installer path in an isolated
container with freshly reconstructed local Git origins, verifies the installed native client receives a real email, invokes
Forge, replies successfully, and restores the pre-run remote baseline. It
makes provider requests, sends mail, mutates disposable remote resources, and
can incur charges. It must never delete or modify the permanent AgentMail
inbox.

## Historical and supporting material

- `packages/tui/upstream/` preserves the last official DeepSeek TUI source and
  tests as attributed porting references. Its tests are deliberately outside
  the active Vitest include pattern and are not a runnable project gate. Any
  behavior carried into the maintained derivative must have coverage under
  `packages/tui/tests/` before it is claimed here.
- `tests/e2e/container-run.sh` is the container-side implementation of
  `tests/e2e/run.sh`, not a separate public test entrypoint. Invoke the host
  runner so source isolation, credentials, journaling, and cleanup are applied.
- The `--mock` preview is maintained for visual and conversational inspection,
  but it does not prove live model interpretation or product installation.

## Maintaining this entrypoint

Add every new independently runnable suite here in the same change that adds
it. Keep harness-specific operating detail beside the harness and link it from
this root document. Do not turn historical imported tests or internal helper
scripts into implied release gates without first adopting and maintaining them.

## Coordinated Nix installation and update container

After `nix develop -c pnpm build`, build the candidate Dear Machine package on
the host and pass its exact executable:

```bash
DEARMACHINE_TEST_BINARY=/nix/store/<candidate-package>/bin/dearmachine \
  bash tests/managed-nix/run.sh
```

The runner copies compiled application files and the pinned Node/native runtime
closures into a disposable container. It mounts no repository, Git metadata,
host home, credentials, socket, profile, or Nix daemon. The container has no
network. Git remote queries and package construction are fixture boundaries;
archive extraction, recursive source snapshots, filesystem activation,
launchers, metadata and rollback execute normally. Production Nix package
builds are covered separately by the host build gates.

The suite covers missing `~/.local`, custom `XDG_DATA_HOME`, nested components,
credential-file exclusion, moved checkout independence, read-only checks,
stopped/running client policy, failed builds, failed startup, interrupted
rollback/recovery, unrelated launcher preservation, unsafe directory rejection,
and the real native CLI's noninteractive handoff to the installer entry point.
No live provider, inbox, or host service is touched.

The native update regression retains the production Nix wrapper's PATH additions
and verifies that an already-current update emits no competing-installation warning.

The managed Nix container suite also uses a real, container-local Nix store and
profile to test explicit migration: exact-entry removal, mixed-package refusal,
unchanged unrelated entries, retained-generation recovery, and fresh POSIX sh,
bash and zsh lookup. Startup files are preserved byte-for-byte. The container
receives copied Nix runtime files; it has no host store database or daemon socket.
Reinstall tests exercise the shared update activation path and config preservation.

### Guest management command contract

`packages/dsh-adapter/tests/system-prompts.spec.ts` checks the actual management
system section delivered to Concierge for native guest allow/list/revoke syntax,
explicit user authorization, authenticated automatic To/CC invitations, independent
private approvals, owner-only continuations, removal commands, explicit
reinvitation, unsupported-provider rejection, and pending provider sync.
The native command implementation and guest lifecycle proofs belong to the
sibling DearMachine repository's root `TESTING.md`.

### Concierge update checks and consent

`packages/app/tests/concierge-update.spec.ts` covers startup checks, unavailable
channels, check failures, explicit installation consent and relaunch choices.
`native-update.spec.ts` validates the structured native handoff, and the real
PTY cases in `concierge-cli.spec.ts` exercise startup availability and decline.
The full suite also retains the guest management prompt contract. Use the
managed Nix container gate above for real native JSON handoff and activation,
and the optional native Concierge gate for the combined Go/TypeScript launcher.

### Machtiani-first installation

The managed Nix container suite also starts with the default standalone
Machtiani launcher, installs DearMachine, and updates the combined release.
It verifies preserved configuration and standalone files, coordinated launcher
ownership, suppressed standalone automatic updating, and restoration of the
original launcher when activation fails after takeover.


### Credential replacement and Machtiani targeting

The credential bridge tests cover explicit reuse, masked replacement despite
an existing credential, cancellation, missing saved credentials, target failure,
and non-secret receipts. `credential-machtiani.spec.ts` verifies native command
arguments, preserved configuration, and rejection of model-host providers.
Set `MACHTIANI_TEST_BINARY` to an absolute, already-built Machtiani executable
to also run the native configuration-writer case against a disposable HOME.
It checks that only the requested provider credential changes and needs no key
or network. The credential CLI tests exercise the packaged socket client with both actions.
Run them through `pnpm test`; no real home, credentials, client, or provider is
used. A configuration receipt is not evidence of live authentication.

### Separate native and DearMachine configurations

For configuration or credential integration changes, the real native tests must
run rather than skip. Build the changed harness and supply its absolute binary:

```console
MACHTIANI_TEST_BINARY=/absolute/path/to/test-machtiani nix develop -c pnpm test
```

`credential-machtiani.spec.ts` verifies the native writer against separate personal
and managed configurations. `machtiani-config.spec.ts` checks one-time legacy
import and independent credentials. The product-adapter and concierge-entry tests
cover installation after standalone Machtiani; the managed Nix lifecycle suite
checks preservation across takeover, update, and failed activation. The real
credential-boundary gate also exercises the private Machtiani credential store.

## Claude Code backend sign-in

`packages/app/tests/backend-auth.spec.ts` exercises the trusted browser-link
and masked-code interface with a fixture executable and real pipes/terminal.
It also verifies that the enclosing installer progress resumes after success,
failure, or cancellation, stays hidden during secure code entry, and stays idle
when the installer stops during sign-in. The installer shares the concierge
activity indicator and TUI glyph; activity and TUI tests cover stream speeds,
interaction handoffs, styling, and reduced/no-motion rendering.
The bridge and client suites cover disconnect/cancellation and safe results.
This does not authenticate a real subscription account. Live human sign-in
remains a separate IXE check; no host subscription session is copied.
