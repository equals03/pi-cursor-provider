{
  description = "pi-cursor-provider development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs { inherit system; };
    in {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs
          corepack_24
          git
          jq
          just
          fd
          ripgrep
          bashInteractive
        ];

        shellHook = ''
          export PATH="$PWD/node_modules/.bin:$PATH"

          export COREPACK_ENABLE_AUTO_PIN=0
          corepack enable >/dev/null 2>&1 || true

          pi() {
            if [ -x "$PWD/node_modules/.bin/pi" ]; then
              "$PWD/node_modules/.bin/pi" "$@"
            else
              echo "pi is not installed locally yet."
              echo "Run: pnpm install"
              return 1
            fi
          }

          export -f pi
        '';
      };
    });
}
