# Message Queue Admin Components

消息队列管理 UI 组件集。

## 组件列表

- **MqAdminConsole.vue** - 主控制台框架
- **TenantsPanel.vue** - 租户管理
- **NamespacesPanel.vue** - 命名空间管理
- **TopicsPanel.vue** - 主题管理
- **SubscriptionsPanel.vue** - 订阅管理
- **MonitoringPanel.vue** - 监控统计

## 使用方式

```vue
<template>
  <MqAdminConsole :connection-id="connectionId" />
</template>

<script setup lang="ts">
import MqAdminConsole from "@/components/mq/MqAdminConsole.vue";

const connectionId = "your-mq-connection-id";
</script>
```

## 文档

完整文档请参考：`docs/mq-index.md`
