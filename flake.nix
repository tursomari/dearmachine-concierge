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
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "machtiani-installer";
            version = "0.0.1";
            src = self;
            fetcherVersion = 4;
            hash = "sha256-QAQ8YP2dHtXMLzrKqvUy+Z+Wxh/AIFnyj4wJQdqCaZY=";
            prePnpmInstall = "pnpm config set network-concurrency 4";
            pnpmInstallFlags = [ "--no-force" ];
          };
        in {
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
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-installer" \
                --add-flags "$runtime/packages/app/dist/bin.mjs"
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-model-host" \
                --add-flags "$runtime/packages/model-host/dist/bin.mjs"
              makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/machtiani-installer-backend" \
                --add-flags "$runtime/packages/backend-adapter/dist/bin.mjs"
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
