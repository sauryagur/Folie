# Non-flake Nix shell for Folie development
# Usage: nix-shell shell.nix

{ pkgs ? import <nixpkgs> {} }:

let
  devDeps = with pkgs; [
    bun
    docker
    kubectl
    kind
    git
    protobuf
  ];
in
pkgs.mkShell {
  name = "folie-dev";
  buildInputs = devDeps;
  shellHook = ''
    export PATH="$HOME/.bun/bin:$PATH"
    if [ -f .env ]; then
      set -a
      source .env
      set +a
    fi
    if [ ! -d ../ax ]; then
      echo "Warning: ax checkout not found at ../ax. Set FOLIE_AX_DIR or clone ax next to this repo."
    fi
    alias folie="bun run src/cli.ts"
    alias folie-test="bunx vitest run"
    alias folie-typecheck="bunx tsc -p ."
    alias folie-build="bun run src/cli.ts up"
    alias folie-down="bun run src/cli.ts down"
  '';
}