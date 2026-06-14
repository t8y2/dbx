import { strict as assert } from "node:assert";
import { test } from "vitest";
import { mongoUrlParam, setMongoUrlParam, mongodbAuthFailureHint } from "../../apps/desktop/src/lib/mongoConnectionOptions.ts";

test("reads MongoDB authSource from URL params", () => {
  assert.equal(mongoUrlParam("?replicaSet=rs0&authSource=admin", "authSource"), "admin");
});

test("sets MongoDB authSource while preserving other URL params", () => {
  assert.equal(setMongoUrlParam("replicaSet=rs0", "authSource", "admin"), "replicaSet=rs0&authSource=admin");
});

test("removes empty MongoDB authSource from URL params", () => {
  assert.equal(setMongoUrlParam("replicaSet=rs0&authSource=admin", "authSource", ""), "replicaSet=rs0");
});

test("adds a MongoDB authSource hint for legacy authentication failures", () => {
  const message = "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}";

  assert.equal(
    mongodbAuthFailureHint(message),
    "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}\n\nCurrent authentication database: gray_lite_twin_fat. If this user was created in admin, set Authentication database to admin or add authSource=admin to URL params.",
  );
});

test("adds a MongoDB URL encoding hint for reserved password characters", () => {
  const message = "MongoDB connection failed: Kind: An invalid argument was provided: password must be URL encoded";

  assert.match(mongodbAuthFailureHint(message), /@ becomes %40/);
});

test("adds a MongoDB SRV DNS hint for IP endpoints", () => {
  const message = 'MongoDB connection failed: Kind: An error occurred during DNS resolution: DNS error: no records found for Query { name: Name("_mongodb._tcp.172.17.0.1."), query_type: SRV }';

  assert.match(mongodbAuthFailureHint(message), /use mongodb:\/\/host:port instead of mongodb\+srv:\/\/host/);
});

test("adds a MongoDB replica set localhost advertisement hint", () => {
  const message = "MongoDB connection failed: Kind: Server selection timeout: No available servers. Topology: { Type: ReplicaSetNoPrimary, Set Name: LIMLIU, Servers: [ { Address: 127.0.0.1:27017, Type: Unknown, Error: Kind: I/O error: Connection refused (os error 111) } ] }";

  assert.match(mongodbAuthFailureHint(message), /Add directConnection=true/);
});

test("adds a MongoDB listDatabases permission hint", () => {
  const message = "Command failed with error 13 (Unauthorized): not authorized on admin to execute command { listDatabases: 1 }";

  assert.match(mongodbAuthFailureHint(message), /does not have permission to run listDatabases/);
});
