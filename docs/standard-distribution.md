# Supplied runtime distribution boundary

Historical Standard launcher and supplied-product configuration routing are
implemented. The paired umbrella owns the portable runtime and checksum-pinned
curl bootstrap. Its no-Nix container gate covers acquisition, product and
provider-runtime entrypoints, child execution, Git LFS, and offline cache reuse.
This is not yet a verified install-to-live-email release; the human IXE and
subsequent live QSE remain required.

The wizard automatically uses **Nix** on NixOS. Other Linux hosts and macOS offer **Nix** and **Standard**, with host-specific Standard descriptions.
Standard invokes the umbrella's `scripts/standard-build.py`: Docker builds on
Linux x86-64, native Apple developer tools on macOS Intel/Apple Silicon.
Both export a host runtime and use the same model, credential, backend and
concierge flow. See the umbrella's `docs/standard-installation.md`.

## Launcher contract

A release launcher sets `MACHTIANI_DISTRIBUTION` to an absolute path to a small
`distribution.json` file in the release root. Its version-1 schema is:

```json
{
  "version": 1,
  "sourceRoot": "source",
  "binaries": {
    "dearmachine": "bin/dearmachine",
    "machtiani": "bin/machtiani",
    "modelHost": "bin/machtiani-model-host",
    "agentManager": "bin/agent-manager"
  }
}
```

These paths are relative to that release, not to the current working directory.
Every binary must exist and be executable. Paths and symlinks may not escape
the release. An invalid explicit manifest fails closed; it never triggers a
silent Nix fallback. Without a distribution manifest, both wizard methods remain available;
Standard acquires its own products without requiring a prebuilt bundle.

Nix is recommended and selected by default. Acquisition runs before model setup and loads
its validated distribution. Existing `method: container` manifests remain
readable as the legacy Linux implementation; they do not add a third menu
choice. Native macOS manifests use `method: standard`. Absent method metadata
continues to identify older Standard releases. Escape returns to installation
consent; cancellation returns to method selection. The selected method and
validated product paths are included in the agent's runtime context.

The source snapshot contains the canonical documentation and source at the
release revisions, without Git history, repository administration, or host
state. `bootstrap-source-revisions.json` records the umbrella revision under
the `.` key. The documentation reference can resolve this metadata only when
`.git` is absent; malformed Git metadata cannot be hidden by a release file.

## Configuration boundary

Standard stage guidance skips Nix acquisition and uses the supplied model-host
and product paths. The headless product adapter does the same, fingerprints the
source snapshot before and after installation, and records the distribution in
its resume journal. A different distribution or installation method cannot
silently resume that journal. Existing Nix checkout entrypoints retain their
previous route.

## Remaining acceptance work

1. Complete Nix selection from a portable snapshot. The current Nix acquisition
   route assumes a Git checkout and the managed Machtiani install requires its
   origin/default-branch metadata. A source-only release cannot satisfy that
   contract. Do not describe the portable bundle's Nix choice as verified or
   silently initialize Git in the snapshot to bypass it.
2. Exercise Standard install-to-concierge and live email in a disposable
   container without `/nix`, through a human IXE before the live QSE. Starting
   the wizard or passing runtime help checks is not installation success.

No domain deployment or pushing is part of this local implementation work.
