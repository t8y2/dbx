export const english = {
  插件调试: "Plugin Debug",
  纯前端: "Frontend only",
  后端运行中: "Backend running",
  正在构建: "Building",
  正在启动: "Starting",
  后端已停止: "Backend stopped",
  正在停止: "Stopping",
  后端异常: "Backend failed",
  重建后端: "Rebuild backend",
  重载页面: "Reload page",
  "有新构建 · 重载页面": "New build · Reload page",
  调试: "Debug",
  自动重载: "Auto reload",
  切换插件语言: "Switch language",
  浅色主题: "Light theme",
  深色主题: "Dark theme",
  关闭错误: "Dismiss error",
  连接列表: "Connections",
  工作台: "Workbench",
  连接: "Connections",
  新建连接: "New connection",
  导入连接: "Import connections",
  编辑: "Edit",
  断开: "Disconnect",
  删除: "Delete",
  关闭: "Close",
  暂无连接: "No connections",
  尚未打开工作台: "No workbench open",
  编辑连接: "Edit connection",
  关闭表单: "Close form",
  连接类型: "Connection type",
  只读连接: "Read-only connection",
  测试连接: "Test connection",
  保存: "Save",
  取消: "Cancel",
  确认: "Confirm",
  调试信息: "Diagnostics",
  日志级别: "Log level",
  全部级别: "All levels",
  错误: "Error",
  信息: "Info",
  自动滚动: "Auto scroll",
  清空调试信息: "Clear diagnostics",
  清空当前视图: "Clear current view",
  关闭调试信息: "Close diagnostics",
  入参: "Parameters",
  出参: "Result",
  错误详情: "Error details",
  暂无调试记录: "No diagnostic entries",
  "启用自动重载？所有打开的插件页面会在更新后刷新，未保存修改将丢失；后端源码变化会重建并断开连接。此设置影响同一调试服务的所有浏览器页面。":
    "Enable auto reload? Updated plugin pages will reload and unsaved changes will be lost. Backend changes rebuild and disconnect sessions. This affects all browsers using this development server.",
  "切换语言并重载当前页面？未保存修改将丢失。": "Switch language and reload the current page? Unsaved changes will be lost.",
  "断开连接将中断该连接正在进行的操作。继续？": "Disconnecting will interrupt operations on this connection. Continue?",
  "删除连接“{name}”？其页面将关闭，未保存修改会丢失。": 'Delete connection "{name}"? Its pages will close and unsaved changes will be lost.',
  "关闭此页面？未保存修改将丢失；最后一个关联页面关闭后会断开连接。": "Close this page? Unsaved changes will be lost. Closing the last associated page disconnects the connection.",
  "重载当前页面？未保存修改将丢失。": "Reload the current page? Unsaved changes will be lost.",
  "重建并重启后端将断开所有连接、中断传输。页面不会自动重载，写操作不会自动重试。继续？": "Rebuild and restart the backend? All connections and transfers will be interrupted. Pages will not reload automatically and writes will not be retried.",
  请求失败: "Request failed",
  无法读取模拟宿主状态: "Unable to load development host state",
  连接已保存: "Connection saved",
  连接测试成功: "Connection test succeeded",
  "后端已启动，请重新连接": "Backend started. Reconnect to continue.",
  "导入文件超过 2 MiB": "Import exceeds 2 MiB",
  "自动重载失败，请查看调试日志；修复源码后可重试": "Auto reload failed. Check diagnostics and fix the source to retry.",
  "页面构建监听已停止，请重启调试服务": "UI build watcher stopped. Restart the development server.",
  "调试服务连接中断，正在重新连接": "Connection to the development server lost. Reconnecting.",
  构建命令开始: "Build command started",
  构建命令完成: "Build command completed",
  构建命令失败: "Build command failed",
  后端状态变化: "Backend state changed",
  后端进程退出: "Backend process exited",
  后端协议解析失败: "Backend protocol parsing failed",
  "RPC 开始": "RPC started",
  "RPC 完成": "RPC completed",
  "RPC 失败": "RPC failed",
  "HTTP 请求完成": "HTTP request completed",
  收到后端事件: "Backend event received",
  收到二进制帧: "Binary frame received",
  开始重建后端: "Backend rebuild started",
  后端重建完成: "Backend rebuild completed",
  后端重建失败: "Backend rebuild failed",
  调试服务已启动: "Development server started",
  调试服务已停止: "Development server stopped",
  前端构建监听启动失败: "UI watcher failed to start",
  前端构建监听已退出: "UI watcher exited",
  页面回收时断开连接失败: "Failed to disconnect an abandoned page's connection",
  后端源码监听已停止: "Backend source watcher stopped",
  自动重载已启用: "Auto reload enabled",
  自动重载已关闭: "Auto reload disabled",
};

export function translate(locale, text, values = {}) {
  const translated = locale === "en" ? english[text] || text : text;
  return String(translated ?? "").replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

export function localizeManifest(source, locale) {
  if (!source) return source;
  const result = structuredClone(source),
    translation = source.localizations?.[locale];
  if (!translation) return result;
  result.name = translation.name || result.name;
  for (const contribution of result.contributions || []) {
    const item = translation.contributions?.[contribution.id];
    if (!item) continue;
    contribution.label = item.label || contribution.label;
    contribution.description = item.description || contribution.description;
    for (const field of contribution.fields || []) {
      const localized = item.fields?.[field.key];
      if (!localized) continue;
      field.label = localized.label || field.label;
      field.description = localized.description || field.description;
      for (const option of field.options || []) option.label = localized.options?.[option.value] || option.label;
    }
  }
  return result;
}
