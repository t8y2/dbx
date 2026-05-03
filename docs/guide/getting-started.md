# Getting Started

## Install

Download the latest release from the [Releases](https://github.com/t8y2/dbx/releases) page.

### Homebrew (macOS)

```bash
brew install --cask t8y2/tap/dbx
```

Update:
```bash
brew upgrade --cask t8y2/tap/dbx
```

### Scoop (Windows)

```bash
scoop bucket add dbx https://github.com/t8y2/scoop-bucket
scoop install dbx
```

Update:
```bash
scoop update dbx
```

### macOS Note

DBX is not signed with an Apple Developer certificate. On first launch, macOS will block the app. To fix:

```bash
xattr -cr /Applications/dbx.app
```

Or: **System Settings → Privacy & Security → Open Anyway**.

## Create Your First Connection

1. Click **New Connection** in the toolbar
2. Select your database type (MySQL, PostgreSQL, etc.)
3. Fill in host, port, username, password
4. Click **Test** to verify the connection
5. Click **Save & Connect**

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77

### Run

```bash
git clone https://github.com/t8y2/dbx.git
cd dbx
pnpm install
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

The installer will be in `src-tauri/target/release/bundle/`.
