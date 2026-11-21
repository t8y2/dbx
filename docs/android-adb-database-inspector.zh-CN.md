# Android (ADB) 数据库实时检查 — 使用说明

通过 adb 连接 Android 设备，直接查看并读写**已安装应用（debuggable 构建）**内的 SQLite 数据库，类似 Android Studio 的 App Inspection → Database Inspector。

## 工作原理

```
dbx 桌面端 ──adb push──▶ /data/local/tmp/dbx-android-worker（中转暂存）
                └─adb shell─▶ cat 暂存文件 | run-as <包名> sh -c 'cat > ./dbx-android-worker && chmod 755 ...'
                                  （写入应用数据目录，避免 SELinux 禁止执行 shell_data_file）
dbx 桌面端 ──adb exec-out──▶ run-as <包名> ./dbx-android-worker --stdio
                （JSON 行协议，与 SQLite SSH Worker 相同）
设备端 Worker 以应用 uid 运行，直接打开 /data/data/<包名>/databases/*.db
```

- 目标应用必须是 **debuggable** 构建（`adb shell run-as <包名>` 可用）。未 root 设备无法访问 release 包数据库——这是 Android 沙箱限制，Android Studio 的 Database Inspector 同样如此。
- 首次连接时 dbx 自动完成**二级部署**：先把 worker 推送到 `/data/local/tmp` 暂存（按设备 ABI 匹配 arm64-v8a / armeabi-v7a / x86_64），再经管道写入应用数据目录 `./dbx-android-worker` 后执行。SELinux Enforcing 下应用 uid 不能直接执行 `/data/local/tmp`（`shell_data_file` 标签）的文件，已在华为等主流机型真机验证。
- 设备版本兼容：Android 9 及以下无 W^X 限制，稳定可用；**Android 10+ 上若目标应用 targetSdk ≥ 29，系统禁止在应用数据目录执行二进制**（W^X），会得到明确的「不允许执行」提示——此为系统级限制，无 root 无法绕过，请改用 Android 9 及以下设备或 targetSdk 更低的应用。
- 安装副本按 SHA-256 校验，相同则跳过重装；每次连接前用 `--version` 校验可执行性。
- 对接现有 SQLite 全功能 UI：对象树、数据编辑、SQL 编辑器、导出、ER 图等。

## 连接步骤

1. 设备开启 USB 调试并连接电脑，`adb devices` 可见且状态为 `device`。
2. dbx 新建连接 → 选择 **Android (ADB)**。
3. adb 路径留空则自动探测（PATH → Android SDK 默认位置），也可手动指定。
4. 选择设备 → 选择应用包名 → 选择数据库文件（也可手动输入相对路径，如 `databases/app.db`）。
5. 保存并连接。

## 实时观察

打开表数据标签页 → 网格设置菜单 → 「自动刷新」，可选 1s / 2s / 5s。刷新会跳过有未保存编辑或正在执行查询的标签页。

## 写安全

- 会话内**首次写操作前自动备份**目标库为 `<db>.dbx-backup-<unix时间戳>`（同目录，最多保留 3 份）。
- busy_timeout 5 秒：设备端 App 正持锁时写入会等待而不是立刻报错。
- 注意：worker 与 App 各自持有独立连接，双端并发写同一库时以 SQLite 锁机制为准。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `run-as` 报 `Package 'x' is not debuggable` | 目标 App 是 release 构建，无法通过 adb 访问其数据库 |
| 枚举不到包名 | 确认设备状态为 `device`（非 offline/unauthorized）；确认选择的是第三方包 |
| worker 推送失败 | 多半是 `/data/local/tmp` 不可写（部分厂商 ROM），可换用带 root 的设备 |
| 提示「应用身份不允许执行 Worker」 | Android 10+ 的 W^X 限制（应用 targetSdk ≥ 29 时禁止在数据目录执行二进制）；换 Android 9 及以下设备或 targetSdk 更低的应用 |
| 连接后无表 | 手动输入数据库文件路径；有些应用把库放在 `no_backup`/`files` 子目录 |

## 权限与合规提示

仅可操作你拥有或获得授权的设备与应用。该能力面向开发调试场景。
