import { invoke } from "@tauri-apps/api/core";
import type {
  NacosConfigHistoryKey,
  NacosConfigHistoryList,
  NacosConfigHistoryQuery,
  NacosConfigItem,
  NacosConfigKey,
  NacosConfigList,
  NacosConfigQuery,
  NacosConfigRollbackRequest,
  NacosConfigUpsert,
  NacosConnectionInfo,
  NacosRNacosConsoleCaptcha,
  NacosInstanceInfo,
  NacosInstanceQuery,
  NacosInstanceUpdate,
  NacosNamespaceCreate,
  NacosNamespaceInfo,
  NacosNamespaceUpdate,
  NacosRawRequest,
  NacosRawResponse,
  NacosServiceList,
  NacosServiceQuery,
} from "@/types/nacos";

export async function nacosTestConnection(connectionId: string): Promise<NacosConnectionInfo> {
  return invoke("nacos_test_connection", { connectionId });
}

export async function nacosListNamespaces(connectionId: string): Promise<NacosNamespaceInfo[]> {
  return invoke("nacos_list_namespaces", { connectionId });
}

export async function nacosCreateNamespace(connectionId: string, req: NacosNamespaceCreate): Promise<void> {
  return invoke("nacos_create_namespace", { connectionId, req });
}

export async function nacosUpdateNamespace(connectionId: string, req: NacosNamespaceUpdate): Promise<void> {
  return invoke("nacos_update_namespace", { connectionId, req });
}

export async function nacosListConfigs(connectionId: string, query: NacosConfigQuery): Promise<NacosConfigList> {
  return invoke("nacos_list_configs", { connectionId, query });
}

export async function nacosGetConfig(connectionId: string, key: NacosConfigKey): Promise<NacosConfigItem> {
  return invoke("nacos_get_config", { connectionId, key });
}

export async function nacosPublishConfig(connectionId: string, req: NacosConfigUpsert): Promise<void> {
  return invoke("nacos_publish_config", { connectionId, req });
}

export async function nacosDeleteConfig(connectionId: string, key: NacosConfigKey): Promise<void> {
  return invoke("nacos_delete_config", { connectionId, key });
}

export async function nacosListConfigHistory(connectionId: string, query: NacosConfigHistoryQuery): Promise<NacosConfigHistoryList> {
  return invoke("nacos_list_config_history", { connectionId, query });
}

export async function nacosGetConfigHistory(connectionId: string, key: NacosConfigHistoryKey): Promise<NacosConfigItem> {
  return invoke("nacos_get_config_history", { connectionId, key });
}

export async function nacosRollbackConfig(connectionId: string, req: NacosConfigRollbackRequest): Promise<void> {
  return invoke("nacos_rollback_config", { connectionId, req });
}

export async function nacosGetRNacosConsoleCaptcha(connectionId: string): Promise<NacosRNacosConsoleCaptcha> {
  return invoke("nacos_get_rnacos_console_captcha", { connectionId });
}

export async function nacosLoginRNacosConsole(connectionId: string, captcha?: string): Promise<void> {
  return invoke("nacos_login_rnacos_console", { connectionId, captcha });
}

export async function nacosListServices(connectionId: string, query: NacosServiceQuery): Promise<NacosServiceList> {
  return invoke("nacos_list_services", { connectionId, query });
}

export async function nacosListInstances(connectionId: string, query: NacosInstanceQuery): Promise<NacosInstanceInfo[]> {
  return invoke("nacos_list_instances", { connectionId, query });
}

export async function nacosUpdateInstance(connectionId: string, req: NacosInstanceUpdate): Promise<void> {
  return invoke("nacos_update_instance", { connectionId, req });
}

export async function nacosRawRequest(connectionId: string, req: NacosRawRequest): Promise<NacosRawResponse> {
  return invoke("nacos_raw_request", { connectionId, req });
}
