# Installer IXE/QSE

This is the detailed operating contract for the harness. Start with the
repository-wide [`TESTING.md`](../../TESTING.md) to select the appropriate
Installer test and understand its safety class.

`run.sh` builds an isolated source container, runs the installer snapshot and PTY
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

For a live run, provide a private JSON model configuration and approved AgentMail
credentials. The JSON contains credential **file references**, never key values:

```json
{
  "provider": "example_provider",
  "endpoint": "https://models.example.test/v1/chat/completions",
  "model": "example/model",
  "reasoningEffort": "high",
  "credentialFile": "/private/shared-provider.key",
  "backend": {
    "provider": "openai",
    "model": "example-backend-model",
    "reasoningEffort": "high",
    "credentialFile": "/private/backend-provider.key"
  }
}
```

```console
AGENTMAIL_SECRETS_PATH=/private/agentmail.env \
  tests/e2e/run.sh --umbrella-root /absolute/path/to/machtiani \
  --model-config /private/models.json
```

`openrouter`, `openai`, and `deepseek` use their built-in adapters without an
`endpoint`. Other provider IDs require their exact HTTPS Chat Completions
endpoint. The optional complete `backend` selection configures Forge separately;
when absent, Forge uses the shared selection. There is no automatic provider or
reasoning fallback. `reasoningEffort: "default"` explicitly selects provider
defaults. Pinned Forge 2.13.21 cannot forward reasoning settings for custom
providers; the runner rejects that combination before building or provisioning.
Choose a supported backend selection or explicitly request default reasoning.

Configuration and credential sources must be absolute, owned regular non-symlink
files with mode `0600`. Model credentials contain one nonempty key, optionally
followed by a newline. AgentMail uses the existing environment-file format.
The runner validates configuration before building, then reads and stages keys
only after the image and offline source checks pass. Sanitized model receipts
record both selections and Forge's functional probe. Credential copies are
removed even when `TXN_KEEP_RUNTIME=1` retains diagnostics.

For compatibility, omitting `--model-config` retains the previous OpenRouter
`z-ai/glm-5.3-flash` / high selection for both roles, using `OPENROUTER_KEY_PATH`
or `~/.secrets/openrouter/work-api-key.txt`. The uncredentialed self-test also
runs configuration, endpoint, private-file and artifact-redaction regressions;
it never reads live keys.

## Git fixture

The host exports umbrella `HEAD` and every recursive gitlink revision, regardless
of component working-tree `HEAD`s. Each object pack contains just the original
commit and its full tree; ancestors and host Git administration are excluded.
Packing uses one thread so unchanged pins produce stable image-cache inputs.
Fresh shallow bare origins and a recursive clone are created inside the container,
preserving commit IDs, gitlinks and committed `.gitmodules`. HTTPS repository
identities are mapped to these local origins with disposable Git URL rewrites.
Unmapped Git transports are disabled. The installer retains the configured
release identity while Git applies the transport mapping.

Before credentials or inboxes are loaded, an offline container proves that the
umbrella origin advertises its default branch and every recursive pin can be
cloned cleanly. The self-test runs the same Git fixture check on the host with
a disposable HOME, plus a regression covering nested pins, drifted checkouts,
and excluded host state. It does not require Docker. Tracked `.env.example`,
`.env.sample` and `.env.template` files are allowed in the object export; actual
credential paths are rejected.

The live clone and its local origins use a dedicated 2 GiB tmpfs at
`/run/machtiani-qse-git`. Nix build scratch uses the container's ordinary `/tmp`
on disk; it must not share the clone's bounded tmpfs. The installer dependency
and package builds require several GiB of scratch space.
