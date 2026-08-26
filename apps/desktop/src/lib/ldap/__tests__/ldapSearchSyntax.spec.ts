import { describe, expect, it } from "vitest";
import { buildGetAdObjectCommand, buildGetAdObjectIdentityCommand, buildLdapSearchByDnCommand, buildLdapSearchCommand, parseScope, scopeLabel } from "../ldapSearchSyntax";

describe("buildLdapSearchCommand", () => {
  it("emits the canonical ldapsearch flags and quotes the base DN", () => {
    const cmd = buildLdapSearchCommand({
      baseDn: "OU=CLIENTS,DC=CORP,DC=INT,DC=KN",
      scope: "sub",
      filter: "(sAMAccountName=alice)",
      host: "ldap.example.com",
      port: 389,
    });
    expect(cmd).toBe("ldapsearch -x -LLL -H 'ldap://ldap.example.com:389' " + "-b 'OU=CLIENTS,DC=CORP,DC=INT,DC=KN' " + "-s sub '(sAMAccountName=alice)'");
  });

  it("uses ldaps:// and the secure default port when useTls is set", () => {
    const cmd = buildLdapSearchCommand({
      baseDn: "DC=corp,DC=com",
      scope: "one",
      filter: "(objectClass=user)",
      host: "ad.corp.com",
      useTls: true,
    });
    expect(cmd).toContain("-H 'ldaps://ad.corp.com:636'");
    expect(cmd).toContain("-s one '(objectClass=user)'");
  });

  it("falls back to (objectClass=*) when the filter is blank", () => {
    const cmd = buildLdapSearchCommand({
      baseDn: "DC=corp",
      scope: "sub",
      filter: "   ",
    });
    expect(cmd).toMatch(/'\(objectClass=\*\)'$/);
  });

  it("appends attribute names verbatim when supplied", () => {
    const cmd = buildLdapSearchCommand({
      baseDn: "DC=corp",
      scope: "sub",
      filter: "(objectClass=user)",
      attributes: ["cn", "mail"],
    });
    expect(cmd.endsWith("'(objectClass=user)' cn mail")).toBe(true);
  });

  it("escapes single quotes in base DN, filter, and host", () => {
    const cmd = buildLdapSearchCommand({
      baseDn: "OU=it's,DC=corp",
      scope: "sub",
      filter: "(description=alice's pc)",
      host: "ldap.example.com",
    });
    expect(cmd).toContain("-b 'OU=it'\\''s,DC=corp'");
    expect(cmd).toContain("'(description=alice'\\''s pc)'");
    expect(cmd).toContain("-H 'ldap://ldap.example.com:389'");
  });
});

describe("buildGetAdObjectCommand", () => {
  it("emits the canonical PowerShell flags", () => {
    const cmd = buildGetAdObjectCommand({
      baseDn: "OU=CLIENTS,DC=CORP,DC=INT,DC=KN",
      scope: "sub",
      filter: "(sAMAccountName=alice)",
      server: "dc01.corp.example.com",
      attributes: ["cn", "mail"],
    });
    expect(cmd).toBe("Get-ADObject -Server 'dc01.corp.example.com' " + "-SearchBase 'OU=CLIENTS,DC=CORP,DC=INT,DC=KN' " + "-SearchScope Subtree " + "-LDAPFilter '(sAMAccountName=alice)' " + "-Properties cn,mail");
  });

  it("maps scope tokens to the PowerShell enum values", () => {
    expect(
      buildGetAdObjectCommand({
        baseDn: "DC=corp",
        scope: "base",
        filter: "(objectClass=*)",
      }),
    ).toContain("-SearchScope Base");
    expect(
      buildGetAdObjectCommand({
        baseDn: "DC=corp",
        scope: "one",
        filter: "(objectClass=*)",
      }),
    ).toContain("-SearchScope OneLevel");
    expect(
      buildGetAdObjectCommand({
        baseDn: "DC=corp",
        scope: "sub",
        filter: "(objectClass=*)",
      }),
    ).toContain("-SearchScope Subtree");
  });

  it("emits -ResultSetSize when a positive size_limit is supplied", () => {
    const cmd = buildGetAdObjectCommand({
      baseDn: "DC=corp",
      scope: "sub",
      filter: "(objectClass=user)",
      sizeLimit: 25,
    });
    expect(cmd).toContain("-ResultSetSize 25");
  });

  it("skips -ResultSetSize when size_limit is zero / negative / missing", () => {
    const cmd = buildGetAdObjectCommand({
      baseDn: "DC=corp",
      scope: "sub",
      filter: "(objectClass=user)",
      sizeLimit: 0,
    });
    expect(cmd).not.toContain("-ResultSetSize");
  });

  it("escapes single quotes by doubling them", () => {
    const cmd = buildGetAdObjectCommand({
      baseDn: "OU=it's,DC=corp",
      scope: "sub",
      filter: "(description=alice's pc)",
      server: "dc01.corp",
    });
    expect(cmd).toContain("-SearchBase 'OU=it''s,DC=corp'");
    expect(cmd).toContain("-LDAPFilter '(description=alice''s pc)'");
    expect(cmd).toContain("-Server 'dc01.corp'");
  });
});

describe("buildGetAdObjectIdentityCommand", () => {
  it("uses -Identity and -Properties *", () => {
    const cmd = buildGetAdObjectIdentityCommand("CN=alice,OU=Users,DC=corp,DC=com", "dc01.corp");
    expect(cmd).toBe("Get-ADObject -Server 'dc01.corp' " + "-Identity 'CN=alice,OU=Users,DC=corp,DC=com' " + "-Properties *");
  });

  it("omits the -Server flag when no server is supplied", () => {
    const cmd = buildGetAdObjectIdentityCommand("CN=alice,DC=corp", "");
    expect(cmd).toBe("Get-ADObject -Identity 'CN=alice,DC=corp' -Properties *");
  });
});

describe("buildLdapSearchByDnCommand", () => {
  it("emits a base-scope search that returns all attributes of the given DN", () => {
    const cmd = buildLdapSearchByDnCommand("CN=alice,DC=corp", "ldap.example.com", 389);
    // scope=base collapses to a single-object lookup; `ldapsearch` accepts
    // `-b '<dn>'` as the object form, no extra scope flag needed. The
    // filter is always single-quoted so characters like `(` and `*` are
    // safe in any shell.
    expect(cmd).toBe("ldapsearch -x -LLL -H 'ldap://ldap.example.com:389' " + "-b 'CN=alice,DC=corp' " + "'(objectClass=*)' *");
  });
});

describe("scope helpers", () => {
  it("parses the DBX UI scope strings", () => {
    expect(parseScope("base")).toBe("base");
    expect(parseScope("object")).toBe("base");
    expect(parseScope("0")).toBe("base");
    expect(parseScope("one")).toBe("one");
    expect(parseScope("oneLevel")).toBe("one");
    expect(parseScope("1")).toBe("one");
    expect(parseScope("sub")).toBe("sub");
    expect(parseScope("subtree")).toBe("sub");
    expect(parseScope("anything-else")).toBe("sub");
  });

  it("scopeLabel is the identity function for the typed token", () => {
    expect(scopeLabel("base")).toBe("base");
    expect(scopeLabel("one")).toBe("one");
    expect(scopeLabel("sub")).toBe("sub");
  });
});
