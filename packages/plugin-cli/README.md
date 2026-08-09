# @dbx-app/plugin-cli

Precompiled `dbx-plugin` CLI for creating and packaging DBX plugins. Installing this package does not compile the CLI and does not require a DBX source checkout.

```bash
npm install --global @dbx-app/plugin-cli
dbx-plugin create my-plugin
```

Or run it without a global installation:

```bash
npx @dbx-app/plugin-cli create my-plugin
```

The package selects a precompiled binary for macOS, Linux, or Windows and bundles the matching Rust and Go DBX plugin SDK sources. Frontend-only plugins require only Node.js. Rust and Go are needed only when the plugin itself has a Rust or Go backend.

```bash
dbx-plugin create my-plugin --template frontend
dbx-plugin create my-rust-plugin --template rust
dbx-plugin create my-go-plugin --template go
dbx-plugin package my-plugin
```

## 中文说明

`@dbx-app/plugin-cli` 提供预编译的 `dbx-plugin` 命令。安装时不会编译 CLI，也不需要克隆 DBX 源码仓库。

```bash
npm install -g @dbx-app/plugin-cli
dbx-plugin create my-plugin
```

也可以直接使用：

```bash
npx @dbx-app/plugin-cli create my-plugin
```

npm 主包会自动选择当前操作系统对应的预编译二进制，并携带匹配版本的 Rust 和 Go 插件 SDK。纯前端插件只需要 Node.js；只有插件自身包含 Rust 或 Go 后端时才需要对应语言的编译环境。
