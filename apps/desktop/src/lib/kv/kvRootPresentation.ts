export type KvRootKind = "etcd" | "zookeeper" | "consul";

export function kvRootNodeLabel(kind: KvRootKind): string {
  return kind === "zookeeper" ? "/" : "Keys";
}
