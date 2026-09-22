# Machtiani Installer

Machtiani Installer is the first-party guided setup application for Dear
Machine. It presents one predictable terminal experience while keeping the
Dear Machine backend agent as a later, explicit user choice.

This repository implements the first risk-reduction slices and the guarded
native installation path:

- an exact DeepSeek Harness package and source pin;
- a narrow process adapter, isolated DSH profile, and reviewed runtime patch
  that adds session-preserving turn interruption to the pinned SDK protocol;
- a launch-time wizard backed by a narrow model-host boundary for choosing one
  provider, sign-in method, model, and reasoning level shared by the installer
  and installed Machtiani;
- a maintained, Machtiani-branded derivative of the last official DSH TUI;
- terminal snapshots, real-PTY lifecycle checks, and a single-process lock;
- the canonical consent, environment, LLM, and email workflow as a no-mutation
  preview;
- masked in-TUI credential entry that atomically writes private files without
  returning key material to the ordinary conversation or transcript;
- permission-gated discovery and functional health checks for Codex, Forge,
  and OMP, followed by an explicit human choice; provider credentials cross
  that boundary only for backend IDs whose installed behavior was explicitly
  validated as environment-compatible;
- a guarded, testable native product-install adapter whose command plan keeps
  credentials out of arguments, refuses pre-existing Dear Machine state, and
  journals safe restart behavior without risking a duplicate remote inbox;
- an interactive handoff from explicit backend selection through product
  installation, live-email progress, reply verification, and a concise outcome
  report; and
- a live DSH smoke test that requires one harmless shell-tool round trip.

The public bootstrap is deliberately not enabled yet. The local guided entry
point enables product changes only after the containerized IXE and live email
QSE gates pass.

The repository build exposes a separate
`packages/app/dist/headless-bin.mjs` entry point for those gates. It accepts a
private, credential-free selection file, derives all writable paths from the
disposable test `HOME`, acquires the ordinary installer lock, and invokes the
guarded product adapter. It is intentionally not wrapped into the public Nix
package. The live QSE may pass one exact pre-provisioned test inbox ID so its
host-side transaction can journal ownership before the container mutates the
resource; the normal installer still provisions a new inbox.

## Installation methods

The wizard offers **Nix** and **Standard** on Linux and macOS. Standard builds
with Docker on Linux x86-64 and directly with Apple's Command Line Tools on
macOS Intel/Apple Silicon. All products run on the host. The umbrella owns the
bootstrap and platform build recipes; see its `docs/standard-installation.md`.
Target availability and completed native/live verification are tracked separately.

## Development

Use Node 24 and pnpm through the pinned Nix shell. The canonical commands,
test boundaries, live-test safety rules, and QSE entrypoint are in
[`TESTING.md`](TESTING.md).

Prepare a new development worktree with:

```console
nix develop -c pnpm install --frozen-lockfile
```

Run the preview in a real terminal with:

```console
nix run '.#' -- --mock
```

Run the guided configuration against an umbrella checkout with:

```console
nix run '.#' -- --install --source-root /absolute/path/to/machtiani
```

After installation consent, choose whether to see shell commands as they run.
The default keeps the existing progress and tool summaries. Opting in adds
literal shell commands in subdued grey; recognizable credential-bearing
commands are withheld. Tool output is not added to this display. Escape from
this choice returns to installation consent.

The model wizard asks which AI service and model should conduct the
installation. It offers API-key access plus policy-approved subscription
sign-ins through pinned official runtimes, and asks only for reasoning levels
the selected runtime reports. That one private profile powers both the
installer and Machtiani after installation. Dear Machine's backend agent
remains a later, explicit choice in the guided conversation. No configuration
flag is required.

The same wizard also offers separate custom OpenAI-compatible choices. It
accepts a host or base URL and fills in the conventional Chat Completions path.
Remote providers require HTTPS. Local providers may use HTTP or HTTPS but are
restricted to `localhost`, `127.0.0.1`, or `[::1]`. Either choice can use a
masked API key or no key. The user supplies
the exact model name and may select a reasoning level or leave it entirely to
the provider. Before saving the choice, the installer sends a small live test
that must stream a tool call and then continue after the tool result. This is a
point-in-time compatibility check, not a promise that an external provider
will never change.

The TUI captures required API keys in masked fields and writes them directly to
private mode-`0600` storage; the values never enter the transcript or DSH event
stream. A key-entry field can be cancelled with Ctrl+C without exiting the
installer. Outside key entry, the first Ctrl+C stops current model or tool
activity and displays an exit warning; a second Ctrl+C exits. Typing again
disarms that warning. With permission, the installer
then runs isolated backend health probes, installs and starts Machtiani and
Dear Machine, asks for one live test email, follows that message through the
selected backend, and reports success only after the reply is sent.

The default terminal palette uses bright magenta for headings, choices, links,
and code, with subdued tool summaries and red failures. The named semantic
theme profiles remain available:
`MACHTIANI_THEME` accepts `terminal`, `machtiani-dark`, `machtiani-light`, or
`none`. The explicit dark and light profiles use their muted truecolor palettes
when the terminal advertises truecolor and otherwise fall back to the standard
terminal palette. `NO_COLOR` removes hue while retaining useful emphasis;
`TERM=dumb` and the `none` profile disable ANSI styling.
`MACHTIANI_MOTION` accepts `full`, `reduced`, or `none`; reduced motion uses a
static progress mark, while none and `TERM=dumb` retain the status text without
animation.

After installation, `dearmachine` opens the concierge and invites questions
and requests in ordinary language. It displays inspection and operation tool
activity. `/help` provides local controls; `/quit` closes the conversation
without stopping Dear Machine. A confirmed start or restart uses the native
supervisor to run the daemon in the background. Login and reboot persistence
remain separate settings.

Use `/model` during an installer or concierge conversation to manage a shared
Default provider, model, and reasoning level. Concierge (the thing you are looking
at right now), Machtiani planner, Machiani shell-agent, and Machtiani sync inherit
Default unless they have an override. Changing Default preserves overrides;
**Set all** changes Default and clears them. **Use Default** removes one override.
Existing sign-ins are reused, and the conversation history is preserved.

The separate configured-backend section is read-only and explains how to change
backend-owned defaults. It does not run verification or display activity or usage
statistics. Custom endpoint selections are saved without a live probe in `/model`;
the initial installation wizard retains its compatibility check.

Shared settings live in `~/.config/machtiani/model-profile.json`. Existing
`~/.config/dearmachine/assistant-model.json` choices migrate to a Concierge
override. Explicit per-run Machtiani CLI choices take precedence. See
[model settings and migration](docs/model-settings.md) for the schema, generated
configuration, legacy fallback, and handling of customized configurations.

Run the live DSH recursion smoke test only with a disposable or explicitly
authorized OpenRouter credential already present in the environment:

```console
nix develop -c ./scripts/dsh-smoke
```

The test never prints the credential or raw transcript. It verifies the model
route, reasoning setting, tool call/result, exact final response, clean exit,
and absence of the credential from the isolated runtime tree.

Before enabling Dear Machine or testing email, run the focused human-assisted
subscription IXE once for OpenAI Codex and once for Anthropic Claude. Point it
at the installer-created profile and Machtiani configuration to test the exact
handoff; omit those two variables only when intentionally testing a temporary
installer-format profile. The commands must come from the revisions under
test—Nix `--no-link --print-out-paths` builds can reuse the normal store cache:

```console
MACHTIANI_BIN=/nix/store/...-machtiani/bin/machtiani \
MACHTIANI_MODEL_HOST_BIN=/nix/store/...-machtiani-installer/bin/machtiani-model-host \
MACHTIANI_MODEL_PROFILE="$HOME/.config/machtiani/model-profile.json" \
MACHTIANI_CONFIG="$HOME/.machtiani/config.toml" \
  ./scripts/subscription-runtime-smoke openai-codex <codex-model> browser

MACHTIANI_BIN=/nix/store/...-machtiani/bin/machtiani \
MACHTIANI_MODEL_HOST_BIN=/nix/store/...-machtiani-installer/bin/machtiani-model-host \
MACHTIANI_MODEL_PROFILE="$HOME/.config/machtiani/model-profile.json" \
MACHTIANI_CONFIG="$HOME/.machtiani/config.toml" \
  ./scripts/subscription-runtime-smoke anthropic-claude <claude-model> browser
```

Each run uses the provider-owned interactive sign-in, invokes planner,
shell-agent, answer, and file-discovery twice through fresh Machtiani/model-host
processes, checks the private reports for credential-shaped material, and then
stops. It never installs Dear Machine, provisions an inbox, or sends email.

## Boundaries

Presentation lives in `packages/tui`, canonical state transitions in
`packages/workflow`, DSH construction and shutdown in `packages/dsh-adapter`,
and credential, environment, and backend operations behind their corresponding
adapter packages. The lock and launcher live in `packages/app`. The active TUI
does not import DSH internals. The historical source and tests are preserved under
`packages/tui/upstream` as porting references, not built application code.

Machtiani Installer is built on DeepSeek Harness. DeepSeek does not support or
endorse this derivative. See `THIRD_PARTY_NOTICES.md` and `LICENSES/`.

## Coordinated Nix software and source updates

The Nix product installation stage now installs Dear Machine, Agent Manager,
Machtiani, the concierge and model host as one release. For software-only
acquisition from a committed umbrella checkout, run this package with
`install --source-root /absolute/path/to/machtiani`. Existing unrelated public
launchers are not replaced automatically.

The release retains the umbrella source, pinned submodule contents and docs
under `${XDG_DATA_HOME:-$HOME/.local/share}/dearmachine/sources/<revision>/`.
The concierge receives this location through its saved source reference.
`dearmachine update --check` reports remote availability without activation;
`dearmachine update` prepares and activates matching binaries and source while
preserving configuration. `dearmachine update --recover` restores an interrupted
activation's previous release. Standard installations keep their own release
channel. See the umbrella's `docs/managed-nix-installation.md` for the complete
ownership and recovery contract.

Managed commands live in `~/.local/bin`; installation never edits shell startup
files. Reinstalling from a newer committed checkout of the same source updates
the existing managed release in place. PATH conflicts receive read-only guidance.
For an already-managed installation, explicitly inspect a superseded Nix profile
entry with `machtiani-installer migrate-profile <entry> --check`, then omit
`--check` to remove only that named entry. Its previous generation and profile
manifest are retained privately for recovery. Unrelated profile packages remain.

On NixOS, host detection selects Nix automatically and displays
“Installation method: Nix.” Other Linux hosts and macOS offer Nix (recommended
and selected by default) and Standard. Standard’s description matches the host.
Having Nix installed does not classify an ordinary Linux or Mac host as NixOS.
When Nix is selected, the installer checks its command/flakes features and
provides configuration guidance only if needed; it does not rewrite Nix settings.

The live installer QSE accepts provider, model, reasoning effort, and private
credential-file references through `--model-config`. Compatible remote providers
can specify their Chat Completions endpoint; Forge can use an independent model
selection when its capabilities differ. See the [QSE runbook](tests/e2e/README.md)
for the configuration format and live-test command.
