{
  description = "DBX - Open-source database management tool (Tauri 2 + Vue 3 + Rust)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    crane.url = "github:ipetkov/crane";
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
      crane,
      rust-overlay,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };

        # Rust toolchain — lock to the minimum required version (1.88)
        # while allowing newer stable releases to satisfy all crate deps.
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "rust-src"
            "rust-analyzer"
            "clippy"
            "rustfmt"
          ];
        };
        baseCraneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        craneLib = baseCraneLib.appendCrateRegistries [
          (baseCraneLib.registryFromDownloadUrl {
            indexUrl = "https://github.com/rust-lang/crates.io-index";
            dl = "https://static.crates.io/crates";
            fetchurlExtraArgs.curlOpts = "--retry 20 --retry-all-errors --retry-delay 1";
          })
        ];

        # ------------------------------------------------------------------ #
        # Linux-only system libraries required by Tauri / WebKit2GTK          #
        # ------------------------------------------------------------------ #
        linuxTauriDeps = pkgs.lib.optionals pkgs.stdenv.isLinux (
          with pkgs;
          [
            webkitgtk_4_1
            gtk3
            libappindicator-gtk3
            libayatana-appindicator   # provides libayatana-appindicator3.so.1 (dlopen'd at runtime)
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

        # Fast fixed-output target used by CI to validate pnpm dependency hashes
        # without compiling the frontend and Rust desktop application.
        packages.dbx-pnpm-deps = self.packages.${system}.dbx-desktop.pnpmDeps;

        # Fast dependency target used by CI to validate Cargo vendoring without
        # compiling the frontend and Rust desktop application.
        packages.dbx-cargo-deps = self.packages.${system}.dbx-desktop.cargoVendorDir;

        # ------------------------------------------------------------------ #
        # packages.dbx-desktop — Tauri desktop application                    #
        # Build with: nix build .#dbx-desktop                                 #
        #                                                                      #
        # Two-phase build strategy:                                            #
        #   1. pnpm.fetchDeps  → vendor all npm/pnpm deps offline             #
        #   2. Crane vendoring → vendor all Cargo deps offline                #
        #   3. pnpm build      → compile Vue/TypeScript frontend               #
        #   4. cargo build -p dbx → compile Tauri Rust backend                 #
        #                                                                      #
        # The pnpmDeps hash is verified by the nix-packaging CI job.           #
        # When dependency inputs change, use the hash reported by the failed  #
        # Nix build and rerun the job before merging.                          #
        # ------------------------------------------------------------------ #
        packages.dbx-desktop = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "dbx-desktop";
          version = "0.5.81";

          src = pkgs.lib.cleanSource ./.;

          # ── Step 1: vendor pnpm (npm) dependencies ──────────────────────── #
          # pnpm.fetchDeps downloads everything listed in pnpm-lock.yaml into  #
          # a content-addressed store path so the build sandbox has no network. #
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            # `fetcherVersion = 4` is supported for `pnpm_11`
            fetcherVersion = 4;
            # Update with the hash reported by a failed fixed-output build:
            #   nix build .#dbx-pnpm-deps 2>&1 | grep 'got:'
            hash = "sha256-iFr+nYvhdFO6Y3fOs3tlhQL/10rgY3f2T1CbjnNZ3Nc=";
          };

          # ── Step 2: vendor Cargo dependencies ───────────────────────────── #
          cargoVendorDir = craneLib.vendorCargoDeps {
            cargoLock = ./Cargo.lock;
            # Pin Git checkouts by their complete Cargo source identity. Unlike
            # package-name/version keys, these remain stable when a package
            # version inside the same checkout changes.
            outputHashes = {
              "git+https://github.com/t8y2/rust_mysql_common.git?rev=77085e91e5081309d585153e3b656ce33bc1fe74#77085e91e5081309d585153e3b656ce33bc1fe74" =
                "sha256-8lWgsdTuLTgOmzP7tXmA9LnomOE0wjxXsCBw9NEMt2o=";
              "git+https://github.com/t8y2/mysql_async.git?rev=2be6e392eb9b06d20dcd2d8ed8eae748d413c9ec#2be6e392eb9b06d20dcd2d8ed8eae748d413c9ec" =
                "sha256-tMFvmypIBh1GHg3cLFWmLf6N1wrwKPlzx2G/MHwtlFM=";
              "git+https://github.com/t8y2/tokio-postgres-gaussdb.git?rev=115f9fef10f0fc3669b5337955e4eb461fc349a6#115f9fef10f0fc3669b5337955e4eb461fc349a6" =
                "sha256-HRbYVSD7iIwG3m1tOGoIZy0xAZwALWIpTtakVSYPIYI=";
            };
          };

          # ── Native build tools (available during build, not linked) ──────── #
          nativeBuildInputs =
            [
              rustToolchain
              pkgs.nodejs_22
              pkgs.pnpm
              pkgs.pkg-config
              pkgs.perl
              pkgs.jq                         # used by preConfigure to strip packageManager
              pkgs.cargo-tauri               # tauri CLI — needed to properly embed frontend assets
              # Hooks that wire up the vendored deps automatically:
              craneLib.configureCargoCommonVarsHook
              craneLib.configureCargoVendoredDepsHook
              pkgs.pnpmConfigHook             # sets up pnpm offline store
              pkgs.desktop-file-utils         # for `desktop-file-validate`
              pkgs.copyDesktopItems           # installs desktopItem into share/applications
              pkgs.imagemagick                # generates correctly sized hicolor icons
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
            comment = "Open-source database management tool for 70+ databases";
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

          # ── Runtime library path injection ───────────────────────────────── #
          # libappindicator-sys uses dlopen() at runtime to load the appindicator
          # shared library. dlopen() does NOT honour the binary's RPATH — it only
          # searches LD_LIBRARY_PATH and system paths. In a Nix derivation the
          # library lives in the store, not in /usr/lib, so we must inject the
          # path explicitly into the wrapGAppsHook3 C-wrapper.
          #
          # IMPORTANT: wrapGAppsHook3 uses its own `gappsWrapperArgs` bash array
          # (NOT `makeWrapperArgs`) — inject via preFixup before the hook runs.
          preFixup = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            gappsWrapperArgs+=(
              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath linuxTauriDeps}"
            )
          '';

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

            # Install icon files into the hicolor theme tree so that all
            # desktop environments (GNOME Shell, KDE Plasma, XFCE, etc.) can
            # find the right size: task-switcher (32px), panel (48px),
            # launcher (64px), app-menu (128px), HiDPI launcher (256px).
            if [ -d src-tauri/icons ]; then
              for size in 32 128; do
                if [ -f "src-tauri/icons/''${size}x''${size}.png" ]; then
                  mkdir -p "$out/share/icons/hicolor/''${size}x''${size}/apps"
                  cp "src-tauri/icons/''${size}x''${size}.png" \
                    "$out/share/icons/hicolor/''${size}x''${size}/apps/dbx.png"
                fi
              done

              # @2x retina variant (128x128@2x) → install as 256x256
              if [ -f "src-tauri/icons/128x128@2x.png" ]; then
                mkdir -p "$out/share/icons/hicolor/256x256/apps"
                cp "src-tauri/icons/128x128@2x.png" \
                  "$out/share/icons/hicolor/256x256/apps/dbx.png"
              fi

              # Generate missing common sizes so hicolor directory metadata
              # always matches the actual PNG dimensions.
              for size in 16 48 64; do
                mkdir -p "$out/share/icons/hicolor/''${size}x''${size}/apps"
                if [ "$size" -le 32 ] && [ -f "src-tauri/icons/32x32.png" ]; then
                  src="src-tauri/icons/32x32.png"
                elif [ -f "src-tauri/icons/128x128.png" ]; then
                  src="src-tauri/icons/128x128.png"
                else
                  continue
                fi
                magick "$src" -resize "''${size}x''${size}" \
                  "$out/share/icons/hicolor/''${size}x''${size}/apps/dbx.png"
              done

              # Install the full-size icon.png as the scalable fallback so that
              # Tauri's default_window_icon() and the taskbar always have an image.
              if [ -f "src-tauri/icons/icon.png" ]; then
                mkdir -p "$out/share/icons/hicolor/512x512/apps"
                cp "src-tauri/icons/icon.png" \
                  "$out/share/icons/hicolor/512x512/apps/dbx.png"
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
              DBX is a lightweight (~15 MB) database management tool supporting 70+
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
