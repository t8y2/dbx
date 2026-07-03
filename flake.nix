{
  description = "DBX - Open-source database management tool (Tauri 2 + Vue 3 + Rust)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      rust-overlay,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Rust toolchain — lock to the minimum required version (1.77)
        # while allowing newer stable releases to satisfy all crate deps.
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
            "clippy"
            "rustfmt"
          ];
        };

        # ------------------------------------------------------------------ #
        # Linux-only system libraries required by Tauri / WebKit2GTK          #
        # ------------------------------------------------------------------ #
        linuxTauriDeps = pkgs.lib.optionals pkgs.stdenv.isLinux (
          with pkgs;
          [
            webkitgtk_4_1
            gtk3
            libappindicator-gtk3
            librsvg
            patchelf
            openssl
            pkg-config
            # Additional GTK / glib runtime deps
            glib
            glib-networking
            dbus
            at-spi2-atk
            atkmm
            cairo
            gdk-pixbuf
            harfbuzz
            pango
            xdotool
            libx11
            libxext
            libxfixes
          ]
        );

        # Node / frontend tooling
        nodeDeps = with pkgs; [
          nodejs_22
          pnpm
          # Optional: for building native node addons (better-sqlite3 etc.)
          python3
          gnumake
          gcc
        ];

        # General build tooling
        buildDeps = with pkgs; [
          pkg-config
          openssl
          openssl.dev
          curl
          wget
          git
        ];

      in
      {
        # ------------------------------------------------------------------ #
        # devShell — `nix develop`                                             #
        # Provides everything needed to run `pnpm install && pnpm dev:tauri`  #
        # or `pnpm dev:web` + `pnpm dev:backend` for the web variant.         #
        # ------------------------------------------------------------------ #
        devShells.default = pkgs.mkShell {
          name = "dbx-dev";

          buildInputs =
            [ rustToolchain ]
            ++ nodeDeps
            ++ buildDeps
            ++ linuxTauriDeps
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux (
              with pkgs;
              [
                # cargo-watch is used by `pnpm dev:backend`
                cargo-watch
                # tauri-cli is installed via npm/pnpm, but Rust parts need this
                pkg-config
              ]
            );

          # Make pkg-config aware of all native libs
          PKG_CONFIG_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux (
            pkgs.lib.makeSearchPath "lib/pkgconfig" (
              with pkgs;
              [
                openssl.dev
                webkitgtk_4_1.dev
                gtk3.dev
                glib.dev
                cairo.dev
                gdk-pixbuf.dev
                harfbuzz.dev
                pango.dev
                at-spi2-atk.dev
              ]
            )
          );

          # Required by rustls / aws-lc-rs which the project uses for TLS
          OPENSSL_DIR = "${pkgs.openssl.dev}";
          OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
          OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";

          shellHook = ''
            echo "╔══════════════════════════════════════════════════════════════╗"
            echo "║  DBX development environment                                 ║"
            echo "║                                                              ║"
            echo "║  Desktop (Tauri):   pnpm install && pnpm dev:tauri           ║"
            echo "║  Web frontend:      pnpm dev:web                             ║"
            echo "║  Web backend:       pnpm dev:backend                         ║"
            echo "║  Build release:     pnpm tauri build                         ║"
            echo "║                                                              ║"
            echo "║  Node: $(node --version)  pnpm: $(pnpm --version)  Rust: $(rustc --version | cut -d' ' -f2)              ║"
            echo "╚══════════════════════════════════════════════════════════════╝"
          '';
        };

        # Convenience alias
        packages.default = self.packages.${system}.dbx-desktop;

        # ------------------------------------------------------------------ #
        # packages.dbx-desktop — Tauri desktop application                    #
        # Build with: nix build .#dbx-desktop                                 #
        #                                                                      #
        # Two-phase build strategy:                                            #
        #   1. pnpm.fetchDeps  → vendor all npm/pnpm deps offline             #
        #   2. importCargoLock → vendor all Cargo deps offline                 #
        #   3. pnpm build      → compile Vue/TypeScript frontend               #
        #   4. cargo build -p dbx → compile Tauri Rust backend                 #
        #                                                                      #
        # ⚠️  The pnpmDeps.hash below is a placeholder.                       #
        #    Run `nix build .#dbx-desktop` once; Nix will report the          #
        #    correct sha256 — paste it in place of the placeholder.           #
        # ------------------------------------------------------------------ #
        packages.dbx-desktop = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "dbx-desktop";
          version = "0.5.44";

          src = pkgs.lib.cleanSource ./.;

          # ── Step 1: vendor pnpm (npm) dependencies ──────────────────────── #
          # pnpm.fetchDeps downloads everything listed in pnpm-lock.yaml into  #
          # a content-addressed store path so the build sandbox has no network. #
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            # nixpkgs 26.11+ requires fetcherVersion = 3 (versions 1 & 2 removed)
            fetcherVersion = 3;
            # Replace with the correct hash after the first failed build:
            #   nix build .#dbx-desktop 2>&1 | grep 'got:'
            hash = "sha256-DDPnQEuAsns7q7mxd2mPGyipIZXvFkrEGZlMh56YirE=";
          };

          # ── Step 2: vendor Cargo dependencies ───────────────────────────── #
          cargoDeps = pkgs.rustPlatform.importCargoLock {
            lockFile = ./Cargo.lock;
            outputHashes = {
              "tokio-postgres-0.7.17" = "sha256-mGzfqYmo1PPcpKOlyA6ePzZA4lrNspOJ5G52meHiocY=";
              "mysql_async-0.36.2" = "sha256-qxSo2JX/ldU8Z+PVDrHy8+EB9ZG3Vdo9TbKLCLQt2CU=";
              "mysql_common-0.35.5" = "sha256-CwXuC6QInSI1GcVSdaD1tcA7J+zTY9ZatOyTYTYPe0Q=";
            };
          };

          # ── Native build tools (available during build, not linked) ──────── #
          nativeBuildInputs =
            [
              rustToolchain
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.pkg-config
              pkgs.jq                         # used by preConfigure to strip packageManager
              pkgs.cargo-tauri               # tauri CLI — needed to properly embed frontend assets
              # Hooks that wire up the vendored deps automatically:
              pkgs.rustPlatform.cargoSetupHook # sets CARGO_HOME to cargoDeps
              pkgs.pnpmConfigHook             # sets up pnpm offline store
              pkgs.desktop-file-utils         # for `desktop-file-validate`
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux (
              with pkgs;
              [
                wrapGAppsHook3 # wraps binary with GTK3/WebKit env
              ]
            );

          # ── Desktop entry (freedesktop .desktop file) ────────────────────── #
          # Built with `makeDesktopItem` so it is validated against the spec
          # at build time. Icon name "dbx" resolves via the hicolor theme
          # (the installPhase copies PNGs into share/icons/hicolor/<size>/apps).
          desktopItem = pkgs.makeDesktopItem {
            name = "dbx";
            type = "Application";
            exec = "dbx %u";
            icon = "dbx";
            desktopName = "DBX";
            genericName = "Database Management Tool";
            comment = "Open-source database management tool for 60+ databases";
            categories = [ "Development" "Database" ];
            keywords = [
              "database"
              "sql"
              "client"
              "mysql"
              "postgresql"
              "mongodb"
              "redis"
            ];
            startupWMClass = "DBX";
            terminal = false;
            mimeTypes = [ "application/sql" "x-scheme-handler/dbx" ];
          };

          # ── Linked libraries (present at both build and runtime) ─────────── #
          buildInputs =
            (with pkgs; [
              openssl
              openssl.dev
            ])
            ++ linuxTauriDeps;

          # ── Environment variables ─────────────────────────────────────────── #
          PKG_CONFIG_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux (
            pkgs.lib.makeSearchPath "lib/pkgconfig" (
              with pkgs;
              [
                openssl.dev
                webkitgtk_4_1.dev
                gtk3.dev
                glib.dev
                cairo.dev
                gdk-pixbuf.dev
                harfbuzz.dev
                pango.dev
                at-spi2-atk.dev
              ]
            )
          );
          OPENSSL_DIR = "${pkgs.openssl.dev}";
          OPENSSL_LIB_DIR = "${pkgs.openssl.out}/lib";
          OPENSSL_INCLUDE_DIR = "${pkgs.openssl.dev}/include";

          # Tauri reads the version from this env var during build
          TAURI_SKIP_DEVSERVER_CHECK = "true";

          # ── Build phases ─────────────────────────────────────────────────── #
          preConfigure = ''
            export HOME=$TMPDIR
            # The "packageManager" field in package.json causes pnpm to enforce a
            # specific version via corepack, which requires network access in sandbox.
            # Use jq (not sed) to drop the key so we don't leave a trailing comma
            # in the file. A naive `sed '/"packageManager"/d'` removes only the
            # value line and leaves `,\n}` behind, which pnpm then refuses to parse.
            if [ -f package.json ]; then
              jq 'del(.packageManager)' package.json > package.json.tmp \
                && mv package.json.tmp package.json
            fi
          '';

          buildPhase = ''
            runHook preBuild

            # ① Use `tauri build --no-bundle` which:
            #   - Runs `beforeBuildCommand` (pnpm build) to compile the Vue/TS frontend
            #   - Sets TAURI_ENV_* variables so the Rust build embeds the dist/ assets
            #   - Properly initialises the Tauri IPC layer inside the binary
            #   - Skips platform-specific installer/bundle creation (AppImage, deb, …)
            #
            # DO NOT replace this with a bare `cargo build -p dbx`.
            # A raw cargo build skips Tauri's asset-embedding pipeline, so the
            # WebView has no bundled frontend to load → __TAURI_INTERNALS__ is
            # never injected → isTauriRuntime() returns false → the UI falls back
            # to HTTP mode and immediately gets "Connection refused".
            cargo tauri build --no-bundle

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/bin
            # tauri build --no-bundle puts the binary at target/release/dbx
            cp target/release/dbx $out/bin/dbx

            # Copy desktop integration files if present.
            # Install every PNG size Tauri ships so the hicolor theme lookup
            # (e.g. panels @ 48px, launchers @ 128px) always succeeds.
            if [ -d src-tauri/icons ]; then
              for size in 32 128; do
                if [ -f "src-tauri/icons/''${size}x''${size}.png" ]; then
                  mkdir -p "$out/share/icons/hicolor/''${size}x''${size}/apps"
                  cp "src-tauri/icons/''${size}x''${size}.png" \
                    "$out/share/icons/hicolor/''${size}x''${size}/apps/dbx.png"
                fi
              done
              # @2x retina variant for 128px
              if [ -f "src-tauri/icons/128x128@2x.png" ]; then
                mkdir -p "$out/share/icons/hicolor/256x256/apps"
                cp "src-tauri/icons/128x128@2x.png" \
                  "$out/share/icons/hicolor/256x256/apps/dbx.png"
              fi
            fi

            # Register the freedesktop .desktop file so app launchers (GNOME
            # Shell, KDE Plasma, etc.) can discover the application.
            mkdir -p $out/share/applications
            cp ${finalAttrs.desktopItem}/share/applications/dbx.desktop \
              $out/share/applications/dbx.desktop
            ${pkgs.desktop-file-utils}/bin/desktop-file-validate \
              $out/share/applications/dbx.desktop

            runHook postInstall
          '';

          # ── Metadata ────────────────────────────────────────────────────── #
          meta = with pkgs.lib; {
            description = "DBX desktop — open-source database management tool (Tauri 2)";
            longDescription = ''
              DBX is a lightweight (~15 MB) database management tool supporting 60+
              databases. Built with Tauri 2, Vue 3, and Rust. No Java, no Chromium.
            '';
            license = licenses.asl20;
            homepage = "https://github.com/t8y2/dbx";
            maintainers = [ ];
            platforms = platforms.linux; # macOS/Windows need platform-specific adjustments
            mainProgram = "dbx";
          } // {
            # Non-lib meta: absolute path to the installed .desktop file so
            # `nix profile install`/home-manager can register it with the
            # user's desktop environment.
            desktopFile = "${placeholder "out"}/share/applications/dbx.desktop";
          };
        });
      }
    );
}
