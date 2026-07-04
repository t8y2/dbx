export type KvRootKind = "etcd" | "zookeeper";

export function kvRootNodeLabel(kind: KvRootKind): string {
  return kind === "zookeeper" ? "/" : "Keys";
}
