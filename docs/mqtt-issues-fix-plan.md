# MQTT Issues 修复计划

关联 issue：

- [#5471](https://github.com/t8y2/dbx/issues/5471)：JSON 发布面板消失、重新打开后 Topic 丢失（P0）
- [#5490](https://github.com/t8y2/dbx/issues/5490)：断线后 Topic 丢失、缺少 SSL 证书登录（P0）
- [#5450](https://github.com/t8y2/dbx/issues/5450)：Payload 切换为 JSON 后发送框消失（P0）
- [#5448](https://github.com/t8y2/dbx/issues/5448)：禁止 MQTT 本地转发、消息分区展示（P1）
- [#5456](https://github.com/t8y2/dbx/issues/5456)：保存 Topic 配置（P1）

## 现状与根因

1. JSON placeholder 中包含原始 `{...}`，切换 JSON 时会被 Vue I18n 当作插值表达式编译，导致发布组件渲染异常。
2. MQTT Topic 目前只保存在 `MqttClient` 的进程内存中；同一客户端的网络重连可以恢复，但重建客户端或重启 DBX 后会丢失。
3. `MqttAuth` 已声明 `certificate` 类型，但连接 UI 只提供无认证和账号密码，Rust TLS 构建也只应用账号密码。
4. 消息已经携带 `sent/received` 方向，但订阅请求没有 MQTT 5 `No Local` 选项，因此发布到自己订阅的 Topic 时会看到 broker 回送副本。

## 实施顺序

### 1. P0：JSON 发布面板

- 将 JSON 示例改为安全参数插值，避免语言包直接出现未转义花括号。
- 保持 Payload textarea 和发布按钮在编码切换后继续挂载。
- 增加切换所有 Payload 编码的组件回归测试，并覆盖非法 JSON。

### 2. P0/P1：Topic 持久化

- 在 MQTT external config 中新增带默认值的订阅配置数组，保持旧连接配置兼容。
- 订阅成功后保存 Topic、QoS 和订阅选项；取消订阅成功后删除配置。
- 客户端创建和首次 CONNACK 后恢复保存的订阅；保留现有网络重连恢复逻辑。
- 使用按连接 ID 的合并更新，避免覆盖用户同时修改的其他连接字段。

### 3. P0：TLS 与证书登录

- 增加 CA、客户端证书、客户端私钥的选择和校验。
- Rust 端构建系统 CA、自定义 CA、mTLS 和跳过服务端验证的 Rustls 配置。
- 只保存证书路径，不把私钥内容写入连接配置。

### 4. P1：No Local 与消息分流

- MQTT 5 使用 `Filter.nolocal`；MQTT 3.x 明确提示协议不支持。
- 订阅配置保存 `noLocal` 等 MQTT 5 选项。
- 消息列表按方向左右展示，并提供全部/接收/发送过滤。

## 验收标准

- 选择 JSON 后发布面板不消失，合法 JSON 可发布，非法 JSON 有错误提示。
- 断线重连、关闭并重新打开 DBX 后，已保存 Topic、QoS 和选项自动恢复。
- TLS、CA、自签 CA、客户端证书认证均可连接，错误证书给出明确错误。
- MQTT 5 开启 No Local 后不出现自己的 broker 回送副本；关闭后发送和接收消息仍能按方向区分。

## 验证命令

```text
pnpm typecheck
pnpm test
cargo test -p dbx-core --features mq-admin mqtt
```
