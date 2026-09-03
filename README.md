# Machtiani Installer

Machtiani Installer is the first-party guided setup application for Dear
Machine. It presents one predictable terminal experience while keeping the
Dear Machine backend agent as a later, explicit user choice.

This repository currently implements the first risk-reduction slice:

- an exact DeepSeek Harness package and source pin;
- a narrow process adapter and isolated DSH profile;
- a maintained, Machtiani-branded derivative of the last official DSH TUI;
- terminal snapshots, real-PTY lifecycle checks, and a single-process lock;
- the canonical consent, environment, LLM, and email workflow as a no-mutation
  preview; and
- a live DSH smoke test that requires one harmless shell-tool round trip.

The public bootstrap and machine-changing installation tools are deliberately
not enabled in this slice. The launcher exits unless explicitly passed
`--mock`. Credential-helper integration, backend selection, full IXE, and live
email QSE follow only after these compatibility and terminal gates remain
green.

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
and the lock/launcher in `packages/app`. The active TUI does not import DSH
internals. The historical source and tests are preserved under
`packages/tui/upstream` as porting references, not built application code.

Machtiani Installer is built on DeepSeek Harness. DeepSeek does not support or
endorse this derivative. See `THIRD_PARTY_NOTICES.md` and `LICENSES/`.
