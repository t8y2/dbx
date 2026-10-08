// Plugin-backed path picker dialog (components/plugins/PluginPathPickerDialog.vue).
// Kept in a dedicated module so the three locale files only merge one
// namespace, the same way `schedulerMessages` and `redisGrouping` do — the
// picker is a global plugins-surface component, so its copy does not live
// under a feature namespace like `scheduler`.

export const pluginPathPickerEn = {
  title: "Choose directory",
  loading: "Loading…",
  parent: "Parent directory",
  empty: "No subdirectories here",
  truncated: "Listing truncated — enter a deeper directory to see the rest.",
  retry: "Retry",
  cancel: "Cancel",
  choose: "Choose this directory",
  loadFailed: "Cannot browse this path: {error}",
  needsConnection: "No connection selected. Pick the connection this path belongs to first.",
  needsConnectionShort: "Pick a connection above to browse its directories.",
  notDirectory: "That path is not a directory — showing its parent instead.",
  pathInput: "Jump to path",
};

export type PluginPathPickerMessages = typeof pluginPathPickerEn;

export const pluginPathPickerZhCN: PluginPathPickerMessages = {
  title: "选择目录",
  loading: "加载中…",
  parent: "上一级目录",
  empty: "此处没有子目录",
  truncated: "列表已截断，请进入更深层的目录查看其余内容。",
  retry: "重试",
  cancel: "取消",
  choose: "选择当前目录",
  loadFailed: "无法浏览该路径：{error}",
  needsConnection: "尚未选择连接。请先在上方选择该路径所属的连接。",
  needsConnectionShort: "请先在上方选择连接，才能浏览其目录。",
  notDirectory: "该路径不是目录，已定位到其上级目录。",
  pathInput: "跳转到路径",
};

export const pluginPathPickerZhTW: PluginPathPickerMessages = {
  title: "選擇資料夾",
  loading: "載入中…",
  parent: "上一層目錄",
  empty: "此處沒有子目錄",
  truncated: "清單已截斷，請進入更深層的目錄查看其餘內容。",
  retry: "重試",
  cancel: "取消",
  choose: "選擇目前目錄",
  loadFailed: "無法瀏覽該路徑：{error}",
  needsConnection: "尚未選擇連線。請先在上方選擇該路徑所屬的連線。",
  needsConnectionShort: "請先在上方選擇連線，才能瀏覽其目錄。",
  notDirectory: "該路徑不是目錄，已定位到其上級目錄。",
  pathInput: "跳轉到路徑",
};
