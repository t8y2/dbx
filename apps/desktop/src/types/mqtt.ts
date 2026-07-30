// MQTT broker connection types, matching dbx-core/src/mqtt/types.rs

export type MqttProtocolVersion = "v3" | "v4" | "v5";
export type MqttTransport = "tcp" | "websocket";
export type MqttQoS = "atmostonce" | "atleastonce" | "exactlyonce";

export interface MqttAuth {
  kind: "none" | "password" | "certificate";
  username?: string;
  password?: string;
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
}

export interface MqttConnectionConfig {
  host: string;
  port: number;
  clientId: string;
  protocolVersion: MqttProtocolVersion;
  transport: MqttTransport;
  tls: boolean;
  tlsSkipVerify: boolean;
  auth: MqttAuth;
  keepAliveSecs: number;
  connectTimeoutSecs: number;
  maxPacketSizeBytes: number;
  wsPath?: string;
}

export interface MqttBrokerInfo {
  brokerUrl: string;
  clientId: string;
  connected: boolean;
  protocolVersion: string;
  subscriptionCount: number;
}

export type MqttMessageDirection = "sent" | "received";

export interface MqttMessage {
  topic: string;
  payloadBase64: string;
  payloadText?: string | null;
  qos: number;
  retain: boolean;
  receivedAtMs: number;
  /** 消息方向：sent（发出的）或 received（接收的） */
  direction?: MqttMessageDirection;
}

export interface MqttTopicNode {
  name: string;
  fullPath: string;
  children: MqttTopicNode[];
  messageCount?: number | null;
  isLeaf: boolean;
}

export interface MqttPublishRequest {
  topic: string;
  payloadBase64: string;
  payloadText?: string | null;
  qos: MqttQoS;
  retain: boolean;
}

export interface MqttSubscribeRequest {
  topic: string;
  qos: MqttQoS;
}

export interface MqttUnsubscribeRequest {
  topic: string;
}
