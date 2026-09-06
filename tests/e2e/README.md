# Installer IXE/QSE

This is the detailed operating contract for the harness. Start with the
repository-wide [`TESTING.md`](../../TESTING.md) to select the appropriate
Installer test and understand its safety class.

`run.sh` builds a source-only container, runs the installer snapshot and PTY
tests in that sparse environment, then exercises the guarded product adapter
against a pre-provisioned pair of disposable AgentMail inboxes. The live gate
sends a real message, requires a reply through Forge, and restores the exact
pre-run AgentMail baseline.

The harness never mounts a host checkout, Git directory, credential directory,
or agent socket into the container. The permanent host Dear Machine inbox and
client identity are protected explicitly. Run the uncredentialed checks with:

```console
tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani --self-test
```

Omit `--self-test` only when the live OpenRouter and AgentMail credentials are
available in the approved local locations.

When the QSE source is an isolated worktree without its own credential files,
point the runner at the approved host files explicitly:

```console
AGENTMAIL_SECRETS_PATH=/absolute/path/to/agentmail.env \
OPENROUTER_KEY_PATH=/absolute/path/to/openrouter.key \
  tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani
```

Both overrides must be absolute. The credential sources remain host-side,
must be owned regular non-symlink files with mode `0600`, and are copied only
into the private transaction and disposable container.
