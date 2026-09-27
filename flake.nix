{
  description = "Isolated Machtiani Installer runtime";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Unstable has retired Intel macOS; keep that target on the supported line.
    nixpkgs-intel-darwin.url = "github:NixOS/nixpkgs/nixos-26.05";
    dsh-src = {
      url = "github:deepseek-ai/deepseek-harness/76fda729799fe9b3848dbe2c211d4b231032b81e";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, nixpkgs-intel-darwin, dsh-src }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import (if system == "x86_64-darwin" then nixpkgs-intel-darwin else nixpkgs) { inherit system; };
    in {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
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
          packageSource = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: _type:
              let name = builtins.baseNameOf path;
              in !(builtins.elem name [
                ".direnv"
                ".git"
                "coverage"
                "dist"
                "node_modules"
                "result"
              ] || builtins.match "result-.*" name != null);
          };
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "machtiani-installer";
            version = "0.0.1";
            src = dependencySource;
            fetcherVersion = 4;
            # --no-force fetches platform-specific optional native dependencies.
            hash = if system == "x86_64-darwin" then "sha256-uXr9K/yIei5Z8s1gvyLqcMVenjcv9cUCJ61WL0YXLAI="
              else if system == "aarch64-darwin" then "sha256-tSuSWh1KziDyfDSsoXt05Xya8WGTOP9q8JEkH41w/hk="
              else if system == "aarch64-linux" then "sha256-K13pMRhdSIYlGrnFlNIs9ro2IbbexEfsXNXuxt0ZolU="
              else "sha256-fUJ/PdLDUTTq50CbyVTNPb3aGTcOWJSIlh02w1EJ5Hw=";
            prePnpmInstall = ''
              pnpm config set network-concurrency 1
              pnpm config set child-concurrency 1
            '';
            # Keep optional package selection explicit for target-cache prefetches.
            pnpmInstallFlags = [
              "--no-force"
              "--cpu=${pkgs.stdenv.hostPlatform.node.arch}"
              "--os=${pkgs.stdenv.hostPlatform.node.platform}"
            ];
          };
        in {
          build-dependencies = pkgs.buildEnv {
            name = "machtiani-installer-build-dependencies";
            paths = [ pnpmDeps pkgs.nodejs_24 pkgs.pnpm pkgs.makeWrapper ];
          };
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "machtiani-installer";
            version = "0.0.1";
            src = packageSource;
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
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/dearmachine" \
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
                wrapProgram "$out/bin/dearmachine" \
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
            meta.mainProgram = "dearmachine";
          };
        });

      checks = forAllSystems (system:
        let pkgs = pkgsFor system; in {
          node-worker-files = pkgs.runCommand "machtiani-installer-node-worker-files" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            node ${./tests/node-worker-files.cjs}
            touch "$out"
          '';
        });

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in {
          default = pkgs.mkShell { packages = [ pkgs.nodejs_24 pkgs.pnpm pkgs.zstd pkgs.zsh ]; };
        });
    };
}
