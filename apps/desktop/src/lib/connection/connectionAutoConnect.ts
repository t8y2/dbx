import type { AutoConnectAfterCreateMode } from "@/stores/settingsStore";

export interface AutoConnectAfterCreateContext {
  /** 本次保存是否为新建连接；编辑已有连接永远不自动连接。 */
  isNew: boolean;
  /** 新建的连接是否来自 `dbx://connection/new` 深链（外部唤起或在弹窗内粘贴的连接链接）。 */
  fromDeepLink: boolean;
}

/**
 * 新建连接保存后是否立即发起连接。
 *
 * `deepLink` 只覆盖深链创建的连接：堡垒机下发的一次性凭据通常有时效，
 * 需要在时限内连上，过了时限连接就会失效。
 *
 * 老配置文件（以及只提供部分字段的调用方）缺该字段时回落到 `all`，
 * 保持「保存并连接」的历史行为。
 */
export function shouldAutoConnectAfterCreate(mode: AutoConnectAfterCreateMode | undefined, context: AutoConnectAfterCreateContext): boolean {
  if (!context.isNew || mode === "off") return false;
  if (mode === "deepLink") return context.fromDeepLink;
  return true;
}

/**
 * 连接深链是否跳过确认弹窗、直接保存。
 *
 * 「新建连接后自动连接」只要覆盖深链（`deepLink` 或 `all`），就跳过确认：堡垒机下发的
 * 凭据有时效，等用户确认再保存往往已经过期（表现为 `ERROR 1043 bad handshake`）。
 * 新建链接和带 `id` 刷新凭据的更新链接都直接提交，随后立即连接。
 *
 * `off` / 老配置缺字段时完全沿用 `deepLinkConnectionConfirmMode` 的原有确认行为；
 * 此时若要免确认，需要用户自己把确认方式设成「仅新建连接」/「仅带 id 的更新链接」等。
 */
export function shouldAutoSubmitConnectionDeepLink(mode: AutoConnectAfterCreateMode | undefined): boolean {
  return mode === "deepLink" || mode === "all";
}
