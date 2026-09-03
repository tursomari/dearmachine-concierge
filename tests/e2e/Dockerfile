# Nix is pinned by both release tag and immutable image digest.
FROM nixos/nix:2.24.5@sha256:4ad79a0ab633944869a37921f096d35a3f2c7a0275d98b7bfa0cd3cba5a6b96e

ENV NIX_CONFIG="experimental-features = nix-command flakes"

COPY . /workspace/machtiani
WORKDIR /workspace/machtiani

# Exercise the full installer semantic, snapshot, and PTY suite in the same
# sparse source-only image used by the live product gate.
RUN nix develop path:/workspace/machtiani/machtiani-installer -c \
      pnpm --dir /workspace/machtiani/machtiani-installer install --frozen-lockfile \
 && nix develop path:/workspace/machtiani/machtiani-installer -c \
      pnpm --dir /workspace/machtiani/machtiani-installer test

# Git LFS is required when Dear Machine creates its default state workspace.
RUN nix develop path:/workspace/machtiani/machtiani-harness#smoke -c true \
 && nix profile install --impure --expr \
      'let f = builtins.getFlake "path:/workspace/machtiani/machtiani-harness"; p = import f.inputs.nixpkgs { system = builtins.currentSystem; }; in p.buildEnv { name = "machtiani-qse-runtime"; paths = [ p.git-lfs p.nodejs_24 p.python3 ]; }'

# Forge is the selected Dear Machine backend for this disposable live gate.
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) forge_target=x86_64-unknown-linux-musl; forge_sha256=4ae6d86cdd001e649e1b435d99243d7249d169e30b24529e350f9dfec798f29a ;; \
      arm64) forge_target=aarch64-unknown-linux-musl; forge_sha256=983652eb26b1e4900633877bc2a1a0e5af788196969bc4b18e184ad3d50cd254 ;; \
      *) printf 'Unsupported Forge architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    export forge_target forge_sha256; \
    nix develop path:/workspace/machtiani/machtiani-harness#smoke -c bash -euo pipefail -c '\
      forge_tmp=$(mktemp -d /tmp/machtiani-forge.XXXXXX); \
      trap '\''rm -rf -- "$forge_tmp"'\'' EXIT; \
      forge_download="$forge_tmp/forge"; \
      curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
        --connect-timeout 15 --max-time 180 --output "$forge_download" \
        "https://github.com/tailcallhq/forgecode/releases/download/v2.13.21/forge-${forge_target}"; \
      printf "%s  %s\n" "$forge_sha256" "$forge_download" | sha256sum -c -; \
      install -Dm0755 "$forge_download" /usr/local/bin/forge; \
      test "$(/usr/local/bin/forge --version)" = "forge 2.13.21" \
    '

RUN install -d -m 0700 /run/machtiani-installer-qse/secrets

ENTRYPOINT ["/workspace/machtiani/machtiani-installer/tests/e2e/container-run.sh"]
