import { invoke } from "@tauri-apps/api/core";

export async function mqttGetBrokerInfo(connectionId: string) {
  return invoke("mqtt_get_broker_info", { connectionId });
}

export async function mqttSubscribe(connectionId: string, topic: string, qos?: string | null) {
  return invoke("mqtt_subscribe", { connectionId, topic, qos: qos ?? null });
}

export async function mqttUnsubscribe(connectionId: string, topic: string) {
  return invoke("mqtt_unsubscribe", { connectionId, topic });
}

export async function mqttPublish(connectionId: string, request: { topic: string; payloadBase64: string; payloadText?: string | null; qos: string; retain: boolean }) {
  return invoke("mqtt_publish", { connectionId, request });
}

export async function mqttListTopics(connectionId: string) {
  return invoke("mqtt_list_topics", { connectionId });
}

export async function mqttGetTopicTree(connectionId: string) {
  return invoke("mqtt_get_topic_tree", { connectionId });
}

export async function mqttGetMessages(connectionId: string, topicFilter?: string | null, limit?: number | null) {
  return invoke("mqtt_get_messages", { connectionId, topicFilter: topicFilter ?? null, limit: limit ?? null });
}

export async function mqttClearMessages(connectionId: string) {
  return invoke("mqtt_clear_messages", { connectionId });
}
