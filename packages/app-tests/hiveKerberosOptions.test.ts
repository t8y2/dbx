import { test } from "vitest";
import assert from "node:assert/strict";
import { applyHiveKerberosSubmitConfig, hiveKerberosFormConfig } from "../../apps/desktop/src/lib/database/hiveKerberosOptions.ts";

test("adds Hive Kerberos URL and JVM options while preserving unrelated params", () => {
  const result = applyHiveKerberosSubmitConfig({
    authMode: "kerberos",
    principal: "hive/_HOST@EXAMPLE.COM",
    krb5ConfPath: "C:\\ProgramData\\MIT\\Kerberos5\\krb5.ini",
    jaasConfigPath: "C:\\dbx\\hive-jaas.conf",
    useSubjectCredsOnlyFalse: true,
    extraJavaOptions: "-Dsun.security.krb5.debug=true",
    urlParams: ";serviceDiscoveryMode=zooKeeper;principal=hive/old@EXAMPLE.COM",
  });

  assert.equal(result.urlParams, "serviceDiscoveryMode=zooKeeper;principal=hive/_HOST@EXAMPLE.COM");
  assert.deepEqual(result.agentJavaOptions, ["-Djava.security.krb5.conf=C:\\ProgramData\\MIT\\Kerberos5\\krb5.ini", "-Djava.security.auth.login.config=C:\\dbx\\hive-jaas.conf", "-Djavax.security.auth.useSubjectCredsOnly=false", "-Dsun.security.krb5.debug=true"]);
});

test("disabling Hive Kerberos removes generated URL params but keeps extra JVM options", () => {
  const result = applyHiveKerberosSubmitConfig({
    authMode: "none",
    principal: "hive/_HOST@EXAMPLE.COM",
    krb5ConfPath: "/etc/krb5.conf",
    jaasConfigPath: "/etc/hive-jaas.conf",
    useSubjectCredsOnlyFalse: true,
    extraJavaOptions: "-Dcustom.flag=true",
    urlParams: "auth=kerberos;principal=hive/_HOST@EXAMPLE.COM;transportMode=http",
  });

  assert.equal(result.urlParams, "transportMode=http");
  assert.deepEqual(result.agentJavaOptions, ["-Dcustom.flag=true"]);
});

test("preserves non Kerberos Hive auth params when Kerberos is disabled", () => {
  const result = applyHiveKerberosSubmitConfig({
    authMode: "none",
    principal: "",
    krb5ConfPath: "",
    jaasConfigPath: "",
    useSubjectCredsOnlyFalse: false,
    extraJavaOptions: "",
    urlParams: "auth=noSasl;transportMode=http",
  });

  assert.equal(result.urlParams, "auth=noSasl;transportMode=http");
});

test("hydrates Hive Kerberos form values from saved URL and JVM options", () => {
  const form = hiveKerberosFormConfig("principal=hive/_HOST@EXAMPLE.COM", ["-Djava.security.krb5.conf=/etc/krb5.conf", "-Djava.security.auth.login.config=/etc/hive-jaas.conf", "-Djavax.security.auth.useSubjectCredsOnly=false", "-Dsun.security.krb5.debug=true"]);

  assert.deepEqual(form, {
    authMode: "kerberos",
    principal: "hive/_HOST@EXAMPLE.COM",
    krb5ConfPath: "/etc/krb5.conf",
    jaasConfigPath: "/etc/hive-jaas.conf",
    useSubjectCredsOnlyFalse: true,
    extraJavaOptions: "-Dsun.security.krb5.debug=true",
  });
});
