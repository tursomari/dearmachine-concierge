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

The launch-time wizard first asks which AI service and model should conduct the
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

Run the live DSH recursion smoke test only with a disposable or explicitly
authorized OpenRouter credential already present in the environment:

```console
nix develop -c ./scripts/dsh-smoke
```

The test never prints the credential or raw transcript. It verifies the model
route, reasoning setting, tool call/result, exact final response, clean exit,
and absence of the credential from the isolated runtime tree.

## Boundaries

Presentation lives in `packages/tui`, canonical state transitions in
`packages/workflow`, DSH construction and shutdown in `packages/dsh-adapter`,
and credential, environment, and backend operations behind their corresponding
adapter packages. The lock and launcher live in `packages/app`. The active TUI
does not import DSH internals. The historical source and tests are preserved under
`packages/tui/upstream` as porting references, not built application code.

Machtiani Installer is built on DeepSeek Harness. DeepSeek does not support or
endorse this derivative. See `THIRD_PARTY_NOTICES.md` and `LICENSES/`.
