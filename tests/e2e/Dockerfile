# Nix is pinned by both release tag and immutable image digest.
FROM nixos/nix:2.24.5@sha256:4ad79a0ab633944869a37921f096d35a3f2c7a0275d98b7bfa0cd3cba5a6b96e

ENV NIX_CONFIG="experimental-features = nix-command flakes"

WORKDIR /workspace/machtiani

# Git LFS is required when Dear Machine creates its default state workspace.
COPY machtiani-harness/flake.nix machtiani-harness/flake.lock /opt/machtiani-qse-harness/
RUN nix develop path:/opt/machtiani-qse-harness#smoke -c true \
 && nix profile install --impure --expr \
      'let f = builtins.getFlake "path:/opt/machtiani-qse-harness"; p = import f.inputs.nixpkgs { system = builtins.currentSystem; }; in p.buildEnv { name = "machtiani-qse-runtime"; paths = [ p.git-lfs p.nodejs_24 p.python3 ]; }'

# Forge is the selected Dear Machine backend for this disposable live gate.
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) forge_target=x86_64-unknown-linux-musl; forge_sha256=4ae6d86cdd001e649e1b435d99243d7249d169e30b24529e350f9dfec798f29a ;; \
      arm64) forge_target=aarch64-unknown-linux-musl; forge_sha256=983652eb26b1e4900633877bc2a1a0e5af788196969bc4b18e184ad3d50cd254 ;; \
      *) printf 'Unsupported Forge architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    export forge_target forge_sha256; \
    nix develop path:/opt/machtiani-qse-harness#smoke -c bash -euo pipefail -c '\
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

# Cache the installer dependency graph separately from changing source. Keep
# downloads serial because the subscription runtime packages are large enough
# to put memory-constrained Docker daemons under avoidable pressure.
COPY machtiani-installer/flake.nix \
     machtiani-installer/flake.lock \
     machtiani-installer/package.json \
     machtiani-installer/pnpm-lock.yaml \
     machtiani-installer/pnpm-workspace.yaml \
     /workspace/machtiani/machtiani-installer/
COPY machtiani-installer/patches /workspace/machtiani/machtiani-installer/patches
COPY machtiani-installer/packages/app/package.json /workspace/machtiani/machtiani-installer/packages/app/package.json
COPY machtiani-installer/packages/backend-adapter/package.json /workspace/machtiani/machtiani-installer/packages/backend-adapter/package.json
COPY machtiani-installer/packages/credential-adapter/package.json /workspace/machtiani/machtiani-installer/packages/credential-adapter/package.json
COPY machtiani-installer/packages/dsh-adapter/package.json /workspace/machtiani/machtiani-installer/packages/dsh-adapter/package.json
COPY machtiani-installer/packages/environment-adapter/package.json /workspace/machtiani/machtiani-installer/packages/environment-adapter/package.json
COPY machtiani-installer/packages/model-host/package.json /workspace/machtiani/machtiani-installer/packages/model-host/package.json
COPY machtiani-installer/packages/product-adapter/package.json /workspace/machtiani/machtiani-installer/packages/product-adapter/package.json
COPY machtiani-installer/packages/tui/package.json /workspace/machtiani/machtiani-installer/packages/tui/package.json
COPY machtiani-installer/packages/workflow/package.json /workspace/machtiani/machtiani-installer/packages/workflow/package.json
RUN --mount=type=cache,id=machtiani-installer-qse-pnpm-v11,target=/root/.local/share/pnpm/store,sharing=locked \
    nix develop path:/workspace/machtiani/machtiani-installer -c \
      pnpm --dir /workspace/machtiani/machtiani-installer install --frozen-lockfile \
        --store-dir=/root/.local/share/pnpm/store --network-concurrency=1 --child-concurrency=1

# Exercise the full installer semantic, snapshot, and PTY suite in the same
# sparse source-only image used by the live product gate.
COPY . /workspace/machtiani
RUN nix develop path:/workspace/machtiani/machtiani-installer -c \
      pnpm --dir /workspace/machtiani/machtiani-installer test

# Pinned OMP is an alternative backend; configuration selects the live backend.
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) omp_target=x64; omp_sha256=73eeef0bf5a42b80bb5e6f1251ddbe9096f0630093c78a671ec7f41ca6dcbf5d ;; \
      arm64) omp_target=arm64; omp_sha256=f219439bc19ad95d0ee9caa595bae16ab309015b3b2561fe184cc9b7207b6736 ;; \
      *) exit 1 ;; \
    esac; \
    curl --fail --location --silent --show-error --retry 3 --connect-timeout 15 --max-time 180 \
      "https://github.com/can1357/oh-my-pi/releases/download/v18.1.16/omp-linux-musl-${omp_target}" -o /tmp/omp; \
    printf '%s  /tmp/omp\n' "$omp_sha256" | sha256sum -c -; \
    install -Dm0755 /tmp/omp /usr/local/bin/omp; rm /tmp/omp; \
    test "$(/usr/local/bin/omp --version)" = 'omp/18.1.16'

RUN install -d -m 0700 /run/machtiani-installer-qse/secrets

ENTRYPOINT ["/workspace/machtiani/machtiani-installer/tests/e2e/container-run.sh"]
