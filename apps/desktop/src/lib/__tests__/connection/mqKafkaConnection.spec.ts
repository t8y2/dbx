import { describe, expect, it } from "vitest";
import { buildMqKafkaConnectionExtra, mqKafkaConnectionTarget, normalizeMqKafkaZooKeeperServers, resolveMqKafkaConnectionSource } from "@/lib/connection/mqKafkaConnection";

describe("MQ Kafka connection", () => {
  it("keeps existing configurations on the Bootstrap source", () => {
    expect(resolveMqKafkaConnectionSource({ bootstrapServers: "broker-1:9092" })).toBe("bootstrap");
    expect(resolveMqKafkaConnectionSource({})).toBe("bootstrap");
  });

  it("recognizes explicit and legacy ZooKeeper discovery configurations", () => {
    expect(resolveMqKafkaConnectionSource({ connectionSource: "zookeeper", zookeeperServers: "zk-1:2181" })).toBe("zookeeper");
    expect(resolveMqKafkaConnectionSource({ zookeeperServers: "zk-legacy:2181" })).toBe("zookeeper");
  });

  it("builds Bootstrap extra fields from listener URIs without persisting the scheme", () => {
    expect(
      buildMqKafkaConnectionExtra({
        connectionSource: "bootstrap",
        bootstrapServers: "SASL_SSL://broker-1:9093, broker-2:9093",
        zookeeperServers: "ignored:2181",
        securityProtocol: "",
      }),
    ).toEqual({ bootstrapServers: "broker-1:9093,broker-2:9093", securityProtocol: "SASL_SSL" });
  });

  it("keeps an explicit security protocol ahead of the listener URI hint", () => {
    expect(
      buildMqKafkaConnectionExtra({
        connectionSource: "bootstrap",
        bootstrapServers: "PLAINTEXT://broker-1:9092",
        zookeeperServers: "",
        securityProtocol: "SSL",
      }),
    ).toEqual({ bootstrapServers: "broker-1:9092", securityProtocol: "SSL" });
  });

  it("builds ZooKeeper discovery fields without a fake Bootstrap address", () => {
    expect(
      buildMqKafkaConnectionExtra({
        connectionSource: "zookeeper",
        bootstrapServers: "ignored:9092",
        zookeeperServers: "zookeeper://zk-1:2181; zk-2:2181/kafka",
        securityProtocol: "PLAINTEXT",
      }),
    ).toEqual({
      connectionSource: "zookeeper",
      zookeeperServers: "zk-1:2181,zk-2:2181/kafka",
      securityProtocol: "PLAINTEXT",
    });
  });

  it("rejects malformed ZooKeeper discovery addresses", () => {
    expect(() => normalizeMqKafkaZooKeeperServers("zk-1:not-a-port/kafka")).toThrow("Kafka ZooKeeper servers are invalid");
    expect(() => normalizeMqKafkaZooKeeperServers("zk-1:70000/kafka")).toThrow("Kafka ZooKeeper servers are invalid");
  });

  it("maps the active source to the generic connection target", () => {
    expect(
      mqKafkaConnectionTarget({
        connectionSource: "bootstrap",
        bootstrapServers: "SSL://broker-1:9093,broker-2:9093",
        zookeeperServers: "",
        securityProtocol: "",
      }),
    ).toEqual({ host: "broker-1", port: 9093, ssl: true });

    expect(
      mqKafkaConnectionTarget({
        connectionSource: "zookeeper",
        bootstrapServers: "",
        zookeeperServers: "zk-1:2281,zk-2:2181/kafka",
        securityProtocol: "SASL_SSL",
      }),
    ).toEqual({ host: "zk-1", port: 2281, ssl: false });
  });
});
