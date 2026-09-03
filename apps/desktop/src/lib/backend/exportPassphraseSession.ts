// 加密导出的密码短语只保留在当前会话的内存中，应用重启或页面刷新后自动清空。
// 相比 localStorage 等持久化存储，明文密钥不会长期落盘，
// 同源脚本或 WebView 存储检查都无法在会话之外读取到它。
let rememberedExportPassphrase = "";

// 记住本次加密导出使用的密码短语，同一会话内下次打开导出对话框时自动回显
export function rememberExportPassphrase(passphrase: string) {
  rememberedExportPassphrase = passphrase;
}

// 读取本会话上次加密导出使用的密码短语，没有则返回空字符串
export function getRememberedExportPassphrase(): string {
  return rememberedExportPassphrase;
}

// 清空记住的密码短语，供测试重置会话状态使用
export function clearRememberedExportPassphrase() {
  rememberedExportPassphrase = "";
}
