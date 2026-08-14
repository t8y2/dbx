# NATS 前端组件复用与交互设计

> 关联 issue：#6121。本文只定义前端实现边界和复用关系，不包含代码。

## 1. 设计原则

NATS 控制台应当看起来属于 DBX 现有消息队列工作台，但不能假装 NATS 拥有 Pulsar/Kafka 的 tenant、namespace、partition 模型。UI 采用“复用壳层、替换领域面板”的方式：复用布局、工具栏、消息详情和发送体验，NATS 专属内容由独立 panel 承担。

## 2. 组件复用矩阵

| 现有组件/模块 | 复用 | 修改方式 | 不应复用的部分 |
| --- | --- | --- | --- |
| `MqAdminConsole.vue` | 主控制台布局、tab 状态、loading/error/capability 分支 | 增加 `systemKind === "nats"` 分支，或抽取通用 `MessageBrokerConsole` 壳层 | 不把 NATS 强行映射成 `tenant -> namespace -> topic` 树 |
| `MqPanelToolbar.vue` | 刷新、连接状态、只读状态、危险操作提示 | 支持 NATS 的连接/订阅/清空本地消息按钮 | 不复用依赖 `TopicRef` 的参数 |
| `SendMessagePanel.vue` | payload 编辑、JSON 格式化、Header 输入、发送结果 | 抽出 NATS 适配 props：subject、reply、NATS headers；保留 RabbitMQ exchange/routingKey 只在 RabbitMQ 显示 | 不显示 queue/exchange 字段给 NATS |
| `MessageBrowser.vue` | 消息列表、时间/大小、payload 详情、复制 | 增加 `NatsMessage` 映射与 headers 展示；支持实时追加和暂停滚动 | 不调用 `mqPeekMessages` 伪装实时订阅 |
| `MessageQueryPanel.vue` | 若 JetStream 历史查询需要表单，可复用查询区 chrome | 新增 JetStream 的 start sequence/time、batch、ack mode 字段 | 不复用 Kafka partition/offset 作为 NATS 字段 |
| `mq/shared/MqSearchInput.vue` | Subject/Stream/Consumer 搜索输入外观 | 文案和过滤回调改为领域中立 | 不假设搜索值一定是 topic |
| `mq/shared/mqPanel.css` | panel spacing、empty/error/loading 状态、响应式布局 | 增加实时消息密度和 header 展示样式 | 不复制一套 NATS CSS |
| `useMqMutationGuard.ts` | Publish、ack、purge、变更操作前的只读确认 | 为 NATS 写操作补充 action 文案和 capability 检查 | 不让只读连接只在前端禁用按钮，后端也必须拒绝 |
| `apps/desktop/src/lib/backend/mq-tauri.ts` / `mq-http.ts` | backend wrapper 的命名、错误处理、Tauri/Web 双实现结构 | 建议单独新增 `nats-tauri.ts`/`nats-http.ts`，避免 MQ 类型文件膨胀 | 不把 SSE/WebSocket 当作返回 Promise 的普通 API |
| `connectionStore.ts` | 连接选择、打开目标、关闭连接、读写保护状态 | 增加 NATS console open target 和清理订阅 registry 的钩子 | 不把每条实时消息写入 sidebar tree |

## 3. 推荐组件树

```text
NatsConsole.vue
├── MqPanelToolbar.vue                 # 连接状态、刷新、开始/停止订阅
├── NatsSubjectWorkbench.vue           # Subject 输入、最近/收藏、订阅列表
│   ├── MqSearchInput.vue
│   └── NatsSubscriptionList.vue
├── MessageBrowser.vue                 # 复用消息列表和详情弹窗
├── NatsPublishPanel.vue               # 复用 SendMessagePanel 的编辑逻辑
└── NatsJetStreamPanel.vue             # Phase 3，Stream/Consumer/历史消息
    ├── NatsStreamList.vue
    ├── NatsConsumerList.vue
    └── MessageQueryPanel.vue
```

`NatsConsole.vue` 只负责组合和页面生命周期，不直接拼接 NATS wire/API 参数。Subject 校验、消息 payload 解码、JSON 格式化、订阅状态归并应放在 `apps/desktop/src/lib/nats/` 的纯函数中，以便单元测试和 Web/Desktop 共用。

当前实现（与 `MqAdminConsole` 同一交互壳层）：

```text
NatsConsole.vue                         # mq-admin-console: toolbar → tabs → content
├── shared/mqConsoleShell.css           # 与 Kafka/Pulsar/RabbitMQ 共用壳层样式
├── tab: messages → nats/NatsMessagesPanel.vue
│   ├── NatsSubjectWorkbench.vue        # 订阅/抓取（领域字段 = Subject）
│   ├── NatsMessageList.vue             # 消息列表 chrome；不调用 mqPeekMessages
│   └── NatsPublishPanel.vue            # 发布（独立 concrete Subject）
└── tab: jetstream → nats/NatsJetStreamPanel.vue   # capability 开启后显示
```

交互对齐：

- 顶部工具栏：集群名/版本、RTT、PROD/只读徽章、错误、刷新（同 `MqAdminConsole`）；
- Tab 切换内容区：默认 **Messages**；JetStream 仅在 server 探测 enabled 后出现；
- Messages 面板顺序与 Kafka Messages 一致：选择目标 → 浏览/接收 → 发送；
- 侧栏入口 `nats.consoleTitle`，不映射 Topics 树；
- 文案：`mqAdmin.*`（只读/Messages tab）+ `nats.*` 领域文案；
- JetStream 只读，不显示 ack/purge/管理写按钮。

## 4. Phase 1 交互契约

### 4.1 订阅

- 用户输入 Subject 后点击“开始订阅”；
- 页面显示 `connecting -> subscribed -> stopped/error` 状态；
- 同一连接上相同 Subject 只允许一个活动订阅，重复点击应聚焦已有订阅；
- 默认显示最近 500 条消息，超出后丢弃最旧消息；
- “暂停视图”只暂停列表滚动，不取消 Broker 订阅；
- “停止订阅”先调用后端取消，再清理前端事件监听；
- 断线时保留已接收消息并显示断线状态，不自动无限重试 UI 操作。

### 4.2 消息详情

每条消息最少展示：

```text
receivedAt | subject | reply (可选) | payload bytes
headers (key/value) | payload mode: JSON / text / base64
```

规则：

- NATS headers 以大小写不敏感的 HTTP-like key/value 形式展示，但保留原始 key；
- payload 是有效 UTF-8 时显示文本，否则显示 Base64；
- JSON 格式化失败不得修改原始 payload；
- 大 payload 默认折叠，单条详情设置大小上限，避免阻塞 Vue 渲染；
- 消息复制使用既有 clipboard helper，并明确复制的是 payload 还是 headers。

### 4.3 Publish

表单字段：

- Subject（必填，不能包含空 Subject token）；
- Reply-to（可选，允许合法 Subject）；
- Headers（多行 `Key: Value`，允许同一个 key 多值时使用数组模型）；
- Payload（文本/JSON/Base64 模式）；
- 发送按钮受只读保护和 `supportsPublish` capability 控制。

Publish 成功只表示客户端已将消息交给 NATS client；如果需要确认服务端处理结果，必须使用 request/reply 或 JetStream publish ack，不能把 Core NATS publish 当成持久化确认。

## 5. JetStream UI 约束

JetStream 面板采用三栏/两栏均可，但必须显式区分以下动作：

| 动作 | 默认行为 | 风险提示 |
| --- | --- | --- |
| 浏览历史消息 | Stream message get 的 sequence 读取 | 不创建 Consumer，不 ack，不改变业务 Consumer |
| 消费并 ack | 仅在用户明确选择后进行 | 显示会改变 pending/ack 状态 |
| 刷新 Stream/Consumer | GET/request-only | 可自动刷新，但要限频 |
| Purge/Delete/修改配置 | Phase 3 后置 | 必须生产保护 + 二次确认 |

历史浏览表单建议字段：Stream、Consumer（可选）、batch size、start sequence/time、ack mode。Kafka 的 partition/offset 控件不可直接复用。

## 6. 连接表单与状态

连接编辑页建议使用 NATS 专用字段组：

```text
Server URL: nats://host:4222 / tls://host:4222
Authentication: None | Username/Password | Token
TLS: enabled, skip verify, CA path (Phase 2)
JetStream: auto-detected, read-only status
```

密码/token 使用现有 connection secret 机制。表单不能通过 `externalConfig` 的普通 JSON 导出泄露 secret。连接测试结果至少包含：server name、version、headers enabled、jetstream enabled、round-trip latency。

## 7. Desktop/Web 实时传输

### Desktop

- `start_subscription` 返回 `subscriptionId`；
- 后端用 `AppHandle`/事件总线发送 `nats://message`、`nats://state`、`nats://error` 事件；
- 前端以 `subscriptionId` 和 `connectionId` 双重过滤，避免旧连接事件串到新页面；
- 页面卸载、切换连接、关闭窗口都执行幂等 `stop_subscription`。

### Web

- 短请求仍走现有 `/api/nats/*` POST JSON route；
- 实时消息使用 SSE（优先）或 WebSocket，事件 envelope 与 Desktop 统一；
- 服务端必须绑定用户/连接权限，不能仅凭前端传来的 `connectionId` 读取消息；
- SSE 断线后前端显示“已断开”，不要自动重复创建无限订阅；重连应携带新的 subscriptionId。

统一事件 envelope：

```json
{
  "subscriptionId": "sub-uuid",
  "connectionId": "connection-uuid",
  "kind": "message|state|error",
  "sequence": 42,
  "payload": {}
}
```

## 8. 前端测试清单

- NATS console 能根据 capability 隐藏 JetStream tab；
- 相同 Subject 的重复订阅不会创建两个 UI 行；
- stop/unmount 后事件不再追加消息；
- 事件来自旧 `subscriptionId` 时被丢弃；
- JSON、纯文本、无效 UTF-8、超大 payload 的显示/复制；
- headers 多值、空 value、大小写 key；
- read-only 连接不能 Publish/ack/purge；
- Web/Desktop 两个 backend wrapper 对同一请求生成同样的 JSON 字段。
