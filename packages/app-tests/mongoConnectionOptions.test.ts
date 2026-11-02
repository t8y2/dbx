import { strict as assert } from "node:assert";
import { test } from "vitest";
import { looksLikeMongoSrvHost, mongoSrvConnectionString, mongoUrlParam, mongoUrlParamIsTrue, normalizeMongoTlsFormState, setMongoUrlParam, setMongoUrlParamBoolean, mongodbAuthFailureHint } from "../../apps/desktop/src/lib/mongo/mongoConnectionOptions.ts";

test("reads MongoDB authSource from URL params", () => {
  assert.equal(mongoUrlParam("?replicaSet=rs0&authSource=admin", "authSource"), "admin");
});

test("sets MongoDB authSource while preserving other URL params", () => {
  assert.equal(setMongoUrlParam("replicaSet=rs0", "authSource", "admin"), "replicaSet=rs0&authSource=admin");
});

test("removes empty MongoDB authSource from URL params", () => {
  assert.equal(setMongoUrlParam("replicaSet=rs0&authSource=admin", "authSource", ""), "replicaSet=rs0");
});

test("reads MongoDB boolean URL params", () => {
  assert.equal(mongoUrlParamIsTrue("tlsAllowInvalidCertificates=true", "tlsAllowInvalidCertificates"), true);
  assert.equal(mongoUrlParamIsTrue("retryWrites=false", "retryWrites", true), false);
  assert.equal(mongoUrlParamIsTrue("", "retryWrites", true), true);
});

test("sets MongoDB boolean URL params", () => {
  assert.equal(setMongoUrlParamBoolean("replicaSet=rs0", "retryWrites", false, true), "replicaSet=rs0&retryWrites=false");
  assert.equal(setMongoUrlParamBoolean("replicaSet=rs0&retryWrites=false", "retryWrites", true, true), "replicaSet=rs0");
  assert.equal(setMongoUrlParamBoolean("", "tlsAllowInvalidCertificates", true), "tlsAllowInvalidCertificates=true");
});

test("clears MongoDB TLS form state when SSL is disabled", () => {
  assert.deepEqual(
    normalizeMongoTlsFormState(false, "replicaSet=rs0&tlsAllowInvalidCertificates=true&tlsAllowInvalidHostnames=true&tlsCAFile=%2Ftmp%2Fca.pem", "/tmp/ca.pem"),
    { urlParams: "replicaSet=rs0", caCertPath: "" },
  );
  assert.deepEqual(normalizeMongoTlsFormState(true, "replicaSet=rs0", " /tmp/ca.pem "), {
    urlParams: "replicaSet=rs0",
    caCertPath: "/tmp/ca.pem",
  });
});

test("preserves MongoDB tlsCAFile in URL params when caCertPath is empty", () => {
  assert.deepEqual(normalizeMongoTlsFormState(true, "replicaSet=rs0&tlsCAFile=%2Ftmp%2Flegacy-ca.pem", ""), {
    urlParams: "replicaSet=rs0&tlsCAFile=%2Ftmp%2Flegacy-ca.pem",
    caCertPath: "",
  });
});

test("form caCertPath overrides tlsCAFile in URL params when set", () => {
  assert.deepEqual(normalizeMongoTlsFormState(true, "replicaSet=rs0&tlsCAFile=%2Ftmp%2Flegacy-ca.pem", "/tmp/explicit-ca.pem"), {
    urlParams: "replicaSet=rs0",
    caCertPath: "/tmp/explicit-ca.pem",
  });
});

test("adds a MongoDB authSource hint for legacy authentication failures", () => {
  const message = "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}";

  assert.equal(
    mongodbAuthFailureHint(message),
    "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='gray_lite_twin_fat'}\n\nCurrent authentication database: gray_lite_twin_fat. The server rejected these credentials. Verify the username and password, and confirm that the user was created in gray_lite_twin_fat. If the user was created in admin, set Authentication database to admin or add authSource=admin to URL params.",
  );
});

test("does not suggest authSource=admin when MongoDB already authenticated against admin", () => {
  const message = "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='admin'}";
  const hinted = mongodbAuthFailureHint(message);

  assert.match(hinted, /The server rejected these credentials/);
  assert.doesNotMatch(hinted, /add authSource=admin/);
});

test("adds a MongoDB URL encoding hint for reserved password characters", () => {
  const message = "MongoDB connection failed: Kind: An invalid argument was provided: password must be URL encoded";

  assert.match(mongodbAuthFailureHint(message), /@ becomes %40/);
});

test("adds a MongoDB directConnection multi-host hint", () => {
  const message = "MongoDB connection failed: Kind: An invalid argument was provided: cannot specify multiple seeds with directConnection=true";

  assert.match(mongodbAuthFailureHint(message), /Remove directConnection=true when using a multi-host replica set URL/);
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

test("adds a MongoDB rustls hint for tlsAllowInvalidHostnames", () => {
  const message = "MongoDB connection failed: Kind: An invalid argument was provided: tlsAllowInvalidHostnames is an invalid option";

  assert.match(mongodbAuthFailureHint(message), /tlsAllowInvalidCertificates=true/);
});

test("adds a MongoDB DocumentDB SSH tunnel hostname hint", () => {
  const message =
    'MongoDB connection failed: Kind: Server selection timeout: invalid peer certificate: certificate not valid for name "127.0.0.1"; certificate is only valid for DnsName("docdb-2023-06-13-09-23-15.ctofbpmjm2lc.ap-northeast-1.docdb.amazonaws.com")';

  assert.match(mongodbAuthFailureHint(message), /tlsAllowInvalidCertificates=true/);
});

test("recognises MongoDB Atlas cluster names that only have SRV records", () => {
  for (const host of ["cluster0.abcde.mongodb.net", " Cluster0.ABCDE.mongodb.net ", "cluster0-pl-0.abcde.mongodb.net"]) {
    assert.equal(looksLikeMongoSrvHost(host), true, host);
  }
  for (const host of ["cluster0-shard-00-00.abcde.mongodb.net", "ac-abc-shard-00-01.abcde.mongodb.net", "mongodb.net", "abcde.mongodb.net", "db.example.com", "127.0.0.1", "", undefined]) {
    assert.equal(looksLikeMongoSrvHost(host), false, String(host));
  }
});

test("builds a mongodb+srv URL from the connection form", () => {
  assert.equal(
    mongoSrvConnectionString({ host: "cluster0.abcde.mongodb.net", username: "al@ice", password: "p:ss/#", database: "", url_params: "authSource=admin&directConnection=true&tls=true&retryWrites=false" }),
    "mongodb+srv://al%40ice:p%3Ass%2F%23@cluster0.abcde.mongodb.net/?authSource=admin&retryWrites=false",
  );
  assert.equal(mongoSrvConnectionString({ host: "cluster0.abcde.mongodb.net:27017", database: "shop", ca_cert_path: "/certs/ca.pem" }), "mongodb+srv://cluster0.abcde.mongodb.net/shop?tlsCAFile=%2Fcerts%2Fca.pem");
  assert.equal(
    mongoSrvConnectionString({ host: "cluster0.abcde.mongodb.net", username: "arn:aws:iam::1:user/x", password: "ignored", url_params: "authMechanism=MONGODB-OIDC" }),
    "mongodb+srv://arn%3Aaws%3Aiam%3A%3A1%3Auser%2Fx@cluster0.abcde.mongodb.net/?authMechanism=MONGODB-OIDC",
  );
});

test("adds an SRV hint when an Atlas cluster name fails DNS lookup as host:port", () => {
  const windows =
    "MongoDB connection failed: Kind: Server selection timeout: No available servers. Topology: { Type: Single, Servers: [ { Address: cluster0.abcde.mongodb.net:27017, Type: Unknown, Error: Kind: I/O error: 不知道这样的主机。 (os error 11001), labels: {}, source: None, server response: None } ] }, labels: {}, source: None, server response: None";
  assert.match(mongodbAuthFailureHint(windows), /mongodb\+srv:\/\/cluster0\.abcde\.mongodb\.net instead of host:port/);
  const mac = windows.replace("不知道这样的主机。 (os error 11001)", "failed to lookup address information: nodename nor servname provided, or not known");
  assert.match(mongodbAuthFailureHint(mac), /Atlas cluster name/);

  // An ordinary host that fails DNS gets no SRV advice.
  const typo = windows.replaceAll("cluster0.abcde.mongodb.net", "db.example.internal");
  assert.equal(mongodbAuthFailureHint(typo), typo);
});
