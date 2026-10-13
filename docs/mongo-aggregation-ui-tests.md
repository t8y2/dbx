# 聚合编辑器 UI 回归用例

位置：apps/desktop/src/components/mongo/__tests__/MongoAggregationDialog.spec.ts

使用 happy-dom、Vue createApp 和带可控延迟的后端 mock；**不会连接真实数据库**。

覆盖范围：

- 预览剥离末尾 $out / $merge，显示 BSON 类型结果但不会写入。
- 点击运行只产生完整命令审核；必须再次点击人工确认才写入。
- 同库一次生产 guard；跨库分别通过源库与目标库 guard，目标拒绝时不写入。
- 只读连接仍可只读预览，但不能准备写入；等待生产确认期间变为只读时，确认后再检查。
- 连接过程中取消，旧连接结果不会触发延迟查询。
- 取消后新请求完成，旧结果不会覆盖新结果或补出写入审核。
- 关闭对话框丢弃过期响应。
- writeConcernError 不被误报为成功，旧审核失效，不自动重试。

运行定向 UI 回归：

    pnpm exec vitest run apps/desktop/src/components/mongo/__tests__/MongoAggregationDialog.spec.ts

主进程内 smoke 另有 Vue SFC 解析和模板编译检查；该检查不等价于 UI 交互回归测试。
