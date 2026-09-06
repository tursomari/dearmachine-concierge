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

## Concierge increment checks

The concierge tests are part of the maintained aggregate suite. After `pnpm build`,
run the focused contracts and terminal exercises with:

```console
nix develop -c pnpm exec vitest run packages/app/tests/concierge-control.spec.ts packages/app/tests/concierge-entry.spec.ts packages/app/tests/concierge-shell.spec.ts packages/app/tests/concierge-cli.spec.ts packages/tui/tests/concierge.spec.ts
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

This gate runs the actual native foreground launcher and supervisor with a
disposable HOME, socket, registry, and dummy daemon. It exercises fresh-install
consent, all lifecycle slash commands, terminal restoration, and two-press
Ctrl+C with the built TS entry. It never starts the real provider-backed daemon.

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

## Containerized IXE/QSE

The canonical harness is `tests/e2e/run.sh`; its detailed operational contract
is in [`tests/e2e/README.md`](tests/e2e/README.md).

### Uncredentialed self-test

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani --self-test
```

The self-test validates the sparse source-only container, installer snapshot
and PTY coverage, harness contracts, and cleanup machinery. It requires Docker
but does not read live credentials, provision inboxes, send email, or invoke a
remote model.

### Live QSE

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani
```

Run the live form only with the approved OpenRouter and AgentMail credentials
in their documented private locations. It provisions and journals exactly two
disposable AgentMail inboxes, conducts the installer path in a source-only
container, verifies the installed native client receives a real email, invokes
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
