# 快速开始

## 安装

从 [Releases](https://github.com/t8y2/dbx/releases) 页面下载最新版本。

### Homebrew (macOS)

```bash
brew install --cask t8y2/tap/dbx
```

更新：
```bash
brew upgrade --cask t8y2/tap/dbx
```

### Scoop (Windows)

```bash
scoop bucket add dbx https://github.com/t8y2/scoop-bucket
scoop install dbx
```

更新：
```bash
scoop update dbx
```

### macOS 说明

DBX 未使用 Apple 开发者证书签名，首次打开时 macOS 会阻止运行。解决方法：

```bash
xattr -cr /Applications/DBX.app
```

或者：**系统设置 → 隐私与安全性 → 仍要打开**。

## 创建第一个连接

1. 点击工具栏的 **新建连接**
2. 选择数据库类型（MySQL、PostgreSQL 等）
3. 填写主机、端口、用户名、密码
4. 点击 **测试** 验证连接
5. 点击 **保存并连接**

## 开发环境搭建

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) >= 1.77

### 运行

```bash
git clone https://github.com/t8y2/dbx.git
cd dbx
pnpm install
pnpm tauri dev
```

### 构建

```bash
pnpm tauri build
```

安装包输出在 `src-tauri/target/release/bundle/` 目录。
