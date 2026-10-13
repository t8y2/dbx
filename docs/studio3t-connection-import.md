# Studio 3T 连接导入

DBX 的侧栏“导入/导出”和欢迎页提供“导入 Studio 3T（.uri）”。这是连接配置导入，不是集合数据导入，不会自动连接数据库。

## 从图中的 Export 导出

1. 在 Studio 3T Connection Manager 中选择连接，点击 **Export**。
2. 在 URI 导出窗口选择 **Export to File**，保存为 `.uri` 文件。需要迁移密码时，按 Studio 3T 提供的选项包含密码；没有包含的密码需要在 DBX 中重新填写。
3. 在 DBX 选择“导入 Studio 3T（.uri）”，可同时选中多个文件。
4. 检查预览列表与警告，勾选要保存的连接，再点击导入。URI v3 优先使用导出的连接名称；标准 URI 使用文件名，多行文件使用编号区分连接。
5. 连接前在 DBX 连接设置中核对密码、认证库、证书路径和隧道配置。

Studio 3T 官方 Connection Manager 文档说明 Export/To URI 支持导出到 `.uri` 文件；参考：
https://studio3t.com/knowledge-base/3t-build/3t-desktop-ide/connect-to-mongodb/

## 支持范围

- 标准 `mongodb://` 和 `mongodb+srv://` URI，以及 Studio 3T URI v3 导出的 `3t.*` 元数据。
- 多服务器、副本集、IPv6、认证用户名与密码、认证库、数据库、TLS 和其他标准 MongoDB URI 参数。
- 标准 MongoDB 参数与凭据编码保持原样；`3t.*` 参数转换为 DBX 设置并从驱动 URI 移除。凭据不会显示在预览列表或错误消息中。
- UTF-8/带 BOM 文本与现有 DBX 文本解码器支持的编码；一行一个 URI，空行及以 `#` 或 `//` 开头的注释被忽略。Studio 3T 元数据中的 `+` 按空格解码。
- URI v3 的无口令 SSH 私钥隧道转换为 DBX `transport_layers`，保留主机、端口、用户、私钥路径；不会读取私钥或连接数据库。
- 文件合计最多 10 MiB、最多 1000 个连接；任一文件无效时整批预览失败，不保存部分连接。
- 复用 DBX 现有选择确认、去重、配置持久化和连接设置流程。取消预览不会保存。

## 明确限制

已针对真实 URI v3 导出文件本地验证：全部 65 个连接可解析，包括一个 SSH 私钥隧道。原始文件及凭据未复制到测试样本或仓库；回归使用虚构数据。

不支持 Studio 3T 私有、加密或旧版本非 URI 连接备份格式；不会猜测结构或将密文当密码。未迁移文件夹和配色；URI v3 的展示数据库选项仍使用 DBX 默认展示规则，不会被误用为权限限制。

带私钥口令、SSH 密码认证、代理、未知 `3t.*` 字段或其他版本的扩展会明确拒绝整批导入，避免隧道信息被丢弃后误连。私钥路径需要在连接前核对文件是否存在；导入不会读取它。

个别 URI v3 导出带有不符合 MongoDB 规则的默认数据库名。如果显式 `authSource` 有效，DBX 会清空默认库并保留认证库，在预览中显示警告且把原数据库名写入连接备注，连接前需核对；缺少有效认证库时仍拒绝转换。真实文件中有一项属于此情况。

## 验证

运行：

```powershell
node node_modules/vitest/vitest.mjs run --configLoader native --pool threads apps/desktop/src/lib/__tests__/imports apps/desktop/src/stores/__tests__/connectionStore.studio3t.spec.ts apps/desktop/src/composables/__tests__/useDialogSources.spec.ts apps/desktop/src/components/config/__tests__/ConfigConnectionSelectDialog.spec.ts
node --max-old-space-size=8192 node_modules/vue-tsc/bin/vue-tsc.js --noEmit --project apps/desktop/tsconfig.json
```

覆盖多服务器参数与凭据保留、TLS/SRV/IPv6、65 项 URI v3 注释/元数据、SSH 私钥隧道、默认库警告、多个文件与唯一选择 ID、错误/大小限制、原生选择取消、勾选后保存以及无自动连接。读取前通过文件 stat 拒绝超过上限的文件，读取后再次检查合计大小。

2026-10-13 修复后验证：导入与配置相关 9 个文件共 125 项测试通过，MongoDB 工作台回归 25 个文件共 180 项测试通过，20 项 smoke 检查通过，全量前端类型检查及生产构建通过。真实文件仅在本地内存中读取，65 项名称和标准参数、1 项 SSH 配置通过逐项比对；未连接其中的数据库。

浏览器使用 65 项虚构数据验证了生产解析器和 DBX 选择弹窗：显示默认库警告，确认发出 65 个选择 ID。文件选择与持久化由原生导入流程测试覆盖，浏览器截图不代表原生文件选择器已手工验收。

本地打包曾遇到 Tauri JS/Rust 次版本不一致，已将 JS 版本范围限制为与锁定 Rust 相同的次版本。原生编译遇到 LLVM 内存不足后，以单并发、拆分代码生成单元及降低应用 crate 优化强度完成本地验收包，依赖保持 release 优化且所有默认功能保留。

修复后的 Windows NSIS 安装包构建通过，隔离安装返回 0，安装版版本为 0.6.42，启动后进程保持运行、响应正常并创建 DBX 主窗口及独立数据目录。安装文件与构建文件逐字节一致，除 Tauri 的三字节安装格式标记外无差异。此项验证不包含在真实数据库上的连通性测试，也未手工操作原生文件选择器。

真实导出文件与凭据未打包。安装后须退出旧实例并核对快捷方式指向的新程序；同一版本号的本地构建可能包含不同代码。
