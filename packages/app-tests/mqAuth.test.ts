import assert from "node:assert/strict";
import { test } from "vitest";

import { detectMqUiAuthKind, isMqAuthKindAllowedForSystem } from "../../apps/desktop/src/lib/connection/mqAuth.ts";

test("keeps hydrated Kafka Kerberos auth allowed during edit", () => {
  const authKind = detectMqUiAuthKind({
    systemKind: "kafka",
    authKind: "none",
    saslMechanism: "GSSAPI",
    jaasConfig: 'com.sun.security.auth.module.Krb5LoginModule required useKeyTab=true keyTab="/etc/user.keytab" principal="user@EXAMPLE.COM";',
  });

  assert.equal(authKind, "kerberos");
  assert.equal(isMqAuthKindAllowedForSystem("kafka", authKind), true);
});

test("normalizes unsupported Kafka auth kinds to none", () => {
  assert.equal(
    detectMqUiAuthKind({
      systemKind: "kafka",
      authKind: "token",
      saslMechanism: "PLAIN",
      jaasConfig: "",
    }),
    "none",
  );
});

test("does not allow Kerberos auth outside Kafka", () => {
  assert.equal(isMqAuthKindAllowedForSystem("pulsar", "kerberos"), false);
});
