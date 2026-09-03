# Installer IXE/QSE

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
