##  Add to NixOS system configuration

Add DBX as a flake input and include the package in `environment.systemPackages`.

### `flake.nix`

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    dbx = {
      url = "github:t8y2/dbx";
      inputs.nixpkgs.follows = "nixpkgs"; # optional
    };
  };

  outputs = { self, nixpkgs, dbx, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        {
          environment.systemPackages = [
            dbx.packages.x86_64-linux.dbx-desktop
          ];
        }
      ];
    };
  };
}
```

### Apply

```bash
sudo nixos-rebuild switch --flake .#my-machine
```

---

## Add via Home Manager

This method installs DBX for a specific user through [Home Manager](https://github.com/nix-community/home-manager).

> [!NOTE]
> The `inputs.nixpkgs.follows = "nixpkgs"` line is **optional**.
> It prevents Nix from downloading a second copy of nixpkgs, but it also makes
> DBX ineligible for the upstream binary cache (it will be built locally).
> Remove that line if you prefer to download a pre-built binary.

### `flake.nix` (standalone Home Manager)

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs"; 
    };

    dbx = {
      url = "github:t8y2/dbx";
      inputs.nixpkgs.follows = "nixpkgs"; # optional
    };
  };

  outputs = { self, nixpkgs, home-manager, dbx, ... }: {
    homeConfigurations."youruser" = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      system = "x86_64-linux";
      modules = [
        {
          home.packages = [
            dbx.packages.x86_64-linux.dbx-desktop
          ];
        }
      ];
    };
  };
}
```

### `flake.nix` (NixOS + Home Manager as a NixOS module)

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    dbx = {
      url = "github:t8y2/dbx";
      inputs.nixpkgs.follows = "nixpkgs"; # optional
    };
  };

  outputs = { self, nixpkgs, home-manager, dbx, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        home-manager.nixosModules.home-manager
        {
          home-manager.users.youruser = {
            home.packages = [
              dbx.packages.x86_64-linux.dbx-desktop
            ];
          };
        }
      ];
    };
  };
}
```

> Replace `youruser` with your actual Linux username and `my-machine` with your hostname.

### Apply (standalone)

```bash
home-manager switch --flake .#youruser
```

### Apply (NixOS module)

```bash
sudo nixos-rebuild switch --flake .#my-machine
```

---

## Development Shell

If you are contributing to DBX or building it from a local clone, the flake provides a fully configured development shell with Rust, Node.js, pnpm, and all GTK/WebKit system libraries:

```bash
git clone https://github.com/t8y2/dbx
cd dbx
nix develop
```

Inside the shell:

| Task | Command |
|---|---|
| Desktop app (Tauri) | `pnpm install && pnpm dev:tauri` |
| Web frontend only | `pnpm dev:web` |
| Web backend only | `pnpm dev:backend` |
| Release build | `pnpm tauri build` |

---

## Building from Source

Build the `dbx-desktop` package directly from the flake:

```bash
nix build github:t8y2/dbx#dbx-desktop
# or, from a local clone:
nix build .#dbx-desktop
```

The resulting binary is available at `./result/bin/dbx`.

---
