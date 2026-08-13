import type { ConsulSession, ConsulSessionServiceCheck } from "@/types/consul";

type ConsulSessionWire = Partial<ConsulSession> & { Checks?: unknown };

export function normalizeConsulSession(value: ConsulSessionWire): ConsulSession {
  const nodeChecks = Array.isArray(value.NodeChecks) ? value.NodeChecks.filter((item): item is string => typeof item === "string") : Array.isArray(value.Checks) ? value.Checks.filter((item): item is string => typeof item === "string") : [];
  const serviceChecks = Array.isArray(value.ServiceChecks) ? value.ServiceChecks.filter((item): item is ConsulSessionServiceCheck => Boolean(item) && typeof item.ID === "string").map((item) => ({ ID: item.ID, Namespace: typeof item.Namespace === "string" ? item.Namespace : "" })) : [];
  return {
    ID: typeof value.ID === "string" ? value.ID : "",
    Name: typeof value.Name === "string" ? value.Name : "",
    Node: typeof value.Node === "string" ? value.Node : "",
    LockDelay: Number(value.LockDelay || 0),
    Behavior: typeof value.Behavior === "string" ? value.Behavior : "release",
    TTL: typeof value.TTL === "string" ? value.TTL : "",
    NodeChecks: nodeChecks,
    ServiceChecks: serviceChecks,
    Namespace: typeof value.Namespace === "string" ? value.Namespace : "",
    Partition: typeof value.Partition === "string" ? value.Partition : "",
    CreateIndex: Number(value.CreateIndex || 0),
    ModifyIndex: Number(value.ModifyIndex || value.CreateIndex || 0),
  };
}
