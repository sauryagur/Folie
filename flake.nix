{
  description = "Folie - autonomous AI agent swarm";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-24.05";
    flake-utils.url = "github:numtide/flake-utils";
    # Optional: ax as a flake input if it becomes one
    # ax.url = "github:sauryagur/ax";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # The runtime dependencies needed for `folie up`
        devDeps = with pkgs; [
          bun
          docker
          kubectl
          kind
          git
          # Build-time only: protobuf compiler (if modifying .proto files)
          protobuf
        ];
        # Development shell with all tools needed to run `folie up`
        devShell = pkgs.mkShell {
          name = "folie-dev";
          buildInputs = devDeps;
          shellHook = ''
            # Ensure PATH includes bun and local tools
            export PATH="$HOME/.bun/bin:$PATH"
            # Auto-load .env if present
            if [ -f .env ]; then
              set -a
              source .env
              set +a
            fi
            # Ensure ax is available next to the repo
            if [ ! -d ../ax ]; then
              echo "Warning: ax checkout not found at ../ax. Set FOLIE_AX_DIR or clone ax next to this repo."
            fi
            # Helpful aliases
            alias folie="bun run src/cli.ts"
            alias folie-test="bunx vitest run"
            alias folie-typecheck="bunx tsc -p ."
            alias folie-build="bun run src/cli.ts up"
            alias folie-down="bun run src/cli.ts down"
          '';
        };

        # The project is run from source; no build step produces binaries.
        # Binaries are compiled at runtime by `bun build --compile`.
        # The nix flake provides the environment to run the project.
        # If you want to package the binaries, see the `packages` attribute below.
        packages = {
          # Helper: run the CLI from the flake without installing
          cli = pkgs.writeShellScriptBin "folie" ''
            #!/usr/bin/env bash
            set -euo pipefail
            cd ${self.outPath}
            exec bun run src/cli.ts "$@"
          '';

          # Development shell with all tools
          shell = devShell;
        };

        # Dev container for VS Code / CI
        devContainer = pkgs.runCommand "folie-dev-container" {
          buildInputs = devDeps;
        } ''
          mkdir -p $out
          cat > $out/devcontainer.json <<'EOF'
          {
            "name": "Folie",
            "image": "nixos/nix:latest",
            "features": {
              "ghcr.io/devcontainers/features/docker-in-docker:1": {},
              "ghcr.io/devcontainers/features/kubectl-helm:1": {}
            },
            "customizations": {
              "vscode": {
                "extensions": [
                  "rust-lang.rust-analyzer",
                  "bierner.markdown-mermaid",
                  "ms-vscode.makefile-tools"
                ]
              }
            },
            "remoteUser": "root"
          }
          EOF
        '';

      in {
        devShell = devShell;
        packages = packages;
        devContainer = devContainer;
        apps = {
          up = {
            type = "app";
            program = "${packages.cli}";
            args = ["up"];
          };
          down = {
            type = "app";
            program = "${packages.cli}";
            args = ["down"];
          };
          test = {
            type = "app";
            program = "${pkgs.bun}/bin/bun";
            args = ["x", "vitest", "run"];
          };
          typecheck = {
            type = "app";
            program = "${pkgs.bun}/bin/bun";
            args = ["x", "tsc", "-p", "."];
          };
        };
        defaultPackage = packages.cli;
      })
    ++ {
      # Make the flake itself available as a package
      formatter = nixpkgs.legacyPackages.x86_64-linux.alejandra;
    };