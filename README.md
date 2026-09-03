# Machtiani Installer

Machtiani Installer is the first-party guided setup application for Dear
Machine. It presents one predictable terminal experience while keeping the
Dear Machine backend agent as a later, explicit user choice.

This repository implements the first risk-reduction slices and the guarded
native installation path:

- an exact DeepSeek Harness package and source pin;
- a narrow process adapter and isolated DSH profile;
- a maintained, Machtiani-branded derivative of the last official DSH TUI;
- terminal snapshots, real-PTY lifecycle checks, and a single-process lock;
- the canonical consent, environment, LLM, and email workflow as a no-mutation
  preview;
- private credential-helper handoff that never returns key material to the
  workflow or transcript;
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

Use Node 24 and pnpm through the pinned Nix shell:

```console
nix develop
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
nix build
```

Run the preview in a real terminal with:

```console
nix run .# -- --mock
```

Run the guided configuration against an umbrella checkout with:

```console
nix run .# -- --install --source-root /absolute/path/to/machtiani
```

This prepares the canonical `enter-llm-key` and `enter-email-key` helpers and,
with permission, runs isolated backend health probes. It then installs and
starts Machtiani and Dear Machine, asks for one live test email, follows that
message through the selected backend, and reports success only after the reply
is sent.

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
