// MQTT HTTP backend stubs (MQTT is not yet supported in web/Docker mode).
// Throw descriptive errors so the user knows this isn't available.

function mqttWebNotAvailable(name: string): never {
  throw new Error(`MQTT ${name}: MQTT 功能暂不支持 Web/Docker 模式。请使用桌面版。`);
}

export async function mqttGetBrokerInfo(_connectionId: string) {
  mqttWebNotAvailable("mqttGetBrokerInfo");
}

export async function mqttSubscribe(_connectionId: string, _topic: string, _qos?: string | null) {
  mqttWebNotAvailable("mqttSubscribe");
}

export async function mqttUnsubscribe(_connectionId: string, _topic: string) {
  mqttWebNotAvailable("mqttUnsubscribe");
}

export async function mqttPublish(_connectionId: string, _request: unknown) {
  mqttWebNotAvailable("mqttPublish");
}

export async function mqttListTopics(_connectionId: string) {
  mqttWebNotAvailable("mqttListTopics");
}

export async function mqttGetTopicTree(_connectionId: string) {
  mqttWebNotAvailable("mqttGetTopicTree");
}

export async function mqttGetMessages(_connectionId: string, _topicFilter?: string | null, _limit?: number | null) {
  mqttWebNotAvailable("mqttGetMessages");
}

export async function mqttClearMessages(_connectionId: string) {
  mqttWebNotAvailable("mqttClearMessages");
}
