{
  description = "Isolated Machtiani Installer runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    dsh-src = {
      url = "github:deepseek-ai/deepseek-harness/76fda729799fe9b3848dbe2c211d4b231032b81e";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, dsh-src }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          claudeRuntime = if system == "x86_64-linux" then pkgs.fetchurl {
            url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-x64-musl/-/claude-agent-sdk-linux-x64-musl-0.3.260.tgz";
            hash = "sha512-JL07je0d2g680Hbu0D9W4hGuZlUeQlhPQac+NPKTJAdJ21bH12JdaMO5QE9RDNIxjd1BaodqMOdTEhjrH1capQ==";
          } else if system == "aarch64-linux" then pkgs.fetchurl {
            url = "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/-/claude-agent-sdk-linux-arm64-musl-0.3.260.tgz";
            hash = "sha512-ZLMbeLHVjkq5hmnpWK1Q2qGAztSPrnTtV+ufdPNf9rzYTYEJdLvEHMqmqlFE2VStOrFEpa7feftT3rcbobBJEw==";
          } else null;
          dependencySource = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./package.json
              ./pnpm-lock.yaml
              ./pnpm-workspace.yaml
              ./patches
              ./packages/app/package.json
              ./packages/backend-adapter/package.json
              ./packages/credential-adapter/package.json
              ./packages/dsh-adapter/package.json
              ./packages/environment-adapter/package.json
              ./packages/model-host/package.json
              ./packages/product-adapter/package.json
              ./packages/tui/package.json
              ./packages/workflow/package.json
            ];
          };
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "machtiani-installer";
            version = "0.0.1";
            src = dependencySource;
            fetcherVersion = 4;
            hash = "sha256-I6b7w/un7cfyWUuQb6uhh50iguqPIQuI2jYJiY47NSs=";
            prePnpmInstall = "pnpm config set network-concurrency 4";
            pnpmInstallFlags = [ "--no-force" ];
          };
        in {
          build-dependencies = pkgs.buildEnv {
            name = "machtiani-installer-build-dependencies";
            paths = [ pnpmDeps pkgs.nodejs_24 pkgs.pnpm pkgs.makeWrapper ];
          };
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "machtiani-installer";
            version = "0.0.1";
            src = self;
            inherit pnpmDeps;
            nativeBuildInputs = [ pkgs.nodejs_24 pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper ];
            buildPhase = ''
              runHook preBuild
              pnpm build
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              runtime="$out/libexec/machtiani-installer"
              mkdir -p "$runtime" "$out/bin"
              cp -R package.json node_modules packages "$runtime/"
              ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                mkdir -p "$runtime/vendor/claude"
                tar -xzf ${claudeRuntime} --strip-components=1 -C "$runtime/vendor/claude"
                makeWrapper ${pkgs.musl}/lib/ld-musl-${pkgs.stdenv.hostPlatform.linuxArch}.so.1 \
                  "$runtime/vendor/claude/claude-nix" \
                  --add-flags "$runtime/vendor/claude/claude"
              ''}
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-installer" \
                --add-flags "$runtime/packages/app/dist/bin.mjs"
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-model-host" \
                --add-flags "$runtime/packages/model-host/dist/bin.mjs"
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-installer-backend" \
                --add-flags "$runtime/packages/backend-adapter/dist/bin.mjs"
              ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
                claude_runtime="$runtime/vendor/claude/claude-nix"
                if [ ! -x "$claude_runtime" ]; then
                  echo "The pinned Claude Agent SDK executable is missing from the installer closure." >&2
                  exit 1
                fi
                "$claude_runtime" --version >/dev/null
                wrapProgram "$out/bin/machtiani-installer" \
                  --set MACHTIANI_CLAUDE_EXECUTABLE "$claude_runtime"
                wrapProgram "$out/bin/machtiani-model-host" \
                  --set MACHTIANI_CLAUDE_EXECUTABLE "$claude_runtime"
              ''}
              runHook postInstall
            '';
            passthru = {
              dshSource = dsh-src;
              dshRevision = "76fda729799fe9b3848dbe2c211d4b231032b81e";
            };
          };
        });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; }; in {
          default = pkgs.mkShell { packages = [ pkgs.nodejs_24 pkgs.pnpm pkgs.zstd ]; };
        });
    };
}
