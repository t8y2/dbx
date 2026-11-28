/**
 * Ctrl/Cmd+点击一个 Oracle 包源码里的名字时，先问这个包本身。
 *
 * 包头里的 `PROCEDURE X(...);` 是声明，包体里的 `PROCEDURE X(...) IS` 是实现，两者都不是
 * 「一个叫 X 的独立过程」。按裸名去查数据字典只会落空，然后乐观地开出一个 `PROCEDURE X`
 * 的源码 tab —— 对象不存在，ALL_SOURCE 取回空串，用户看到的就是一个空编辑器。
 */

import { normalizeOracleNavigationTarget, sqlObjectNavigationPackageMember, sqlObjectNavigationSourceKind, sqlObjectNavigationSourceName, sqlObjectNavigationSourceSchema, sqlObjectNavigationTarget, type SqlObjectNavigationIdentity, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import type { ObjectSourceKind, PackageMemberFocus } from "@/types/database";
import { findOraclePackageMember, oraclePackageMemberHeaderAt, type OraclePackageMemberEntry } from "@/lib/sql/oraclePackageMembers";

/** 当前源码 tab 正在显示的包（包头或包体）。 */
export interface OraclePackageSourceContext {
  name: string;
  schema?: string;
  objectType: Extract<ObjectSourceKind, "PACKAGE" | "PACKAGE_BODY">;
}

export type OraclePackageMemberNavigation =
  /** 实现就在当前文档里：在编辑器内跳过去，不要另开 tab。 */
  | { kind: "document"; entry: OraclePackageMemberEntry }
  /** 当前显示的是包头：打开同名包体，并把光标落在成员实现上。 */
  | { kind: "packageBody"; entry: OraclePackageMemberEntry; target: SqlObjectNavigationTarget };

/** 元数据名按库里存的样子来；混合大小写说明是带引号建的，不能再被 Oracle 规范化成全大写。 */
function preserveOracleStoreCase(value?: string): boolean {
  return !!value && value !== value.toUpperCase();
}

/** 用头部自己的形参重建一段签名文本，重载时让包体侧定位到同一个子程序。 */
function memberSignature(entry: OraclePackageMemberEntry): string | undefined {
  if (!entry.parameters.length) return undefined;
  if (entry.parameters.length !== entry.parameterTypes.length) return undefined;
  if (entry.parameterTypes.some((type) => !type)) return undefined;
  return entry.parameters.map((name, index) => `${name} ${entry.parameterTypes[index]}`).join(", ");
}

/**
 * 源码里的引用对应的数据字典名：带引号的按原样，不带引号的 Oracle 会折成全大写。
 * `MyProc` 因此是 `MYPROC`，不会命中带引号创建的 `"MyProc"`。
 */
function dictionaryName(reference: string, referenceQuoted: boolean | undefined): string {
  return referenceQuoted ? reference : reference.toUpperCase();
}

/** `stored` 是数据字典里存的名字（带引号创建的混合大小写保持原样）。 */
function referencesSameIdentifier(reference: string, referenceQuoted: boolean | undefined, stored: string): boolean {
  return dictionaryName(reference, referenceQuoted) === stored;
}

/**
 * 包内解析的结果，拿不准就返回 null 交回原有的元数据解析链。
 *
 * 只接管两种点击：裸名（`X` / `X(...)`）和限定到本包的 `PKG.X`。前者还要求点在子程序头的
 * 名字上，或者是一个调用点 —— 否则 `FROM` 后面一个碰巧与子程序同名的表就会被抢走。
 */
export function resolveOraclePackageMemberNavigation(options: { source: string; position: number; identity: SqlObjectNavigationIdentity; context: OraclePackageSourceContext }): OraclePackageMemberNavigation | null {
  const { source, position, identity, context } = options;
  if (!source || !identity.name || !context.name) return null;

  const parts = identity.parts.length;
  if (parts > 2) return null;
  if (parts === 2 && !referencesSameIdentifier(identity.qualifier ?? "", identity.qualifierQuoted, context.name)) return null;

  const header = parts === 1 ? oraclePackageMemberHeaderAt(source, position) : null;
  if (parts === 1 && !header && identity.role !== "routine_call") return null;

  const wanted = identity.name;
  // 点在头上时那个头就是答案；否则按名字在本文件里找。调用点没有签名可用，重载同名时
  // {@link findOraclePackageMember} 会返回 null —— 这里不再强行挑一个「第一个实现」，
  // 否则 Ctrl/Cmd+点击会悄悄跳到错误的重载。拿不准就交回元数据解析链。
  const found = header ?? findOraclePackageMember(source, { name: wanted, nameQuoted: identity.nameQuoted });
  if (!found) return null;
  // 成员名也按引用方式折叠后再比：找回来的成员必须正是这个引用在 Oracle 里指向的那个。
  if (found.databaseName !== dictionaryName(wanted, identity.nameQuoted)) return null;

  const signature = memberSignature(found);

  if (context.objectType === "PACKAGE_BODY") {
    if (found.implemented) return { kind: "document", entry: found };
    // 点中的是包体里的前向声明：实现在后面，带上签名再找一次。
    const implementation = findOraclePackageMember(source, { name: found.name, kind: found.isFunction ? "function" : "procedure", ...(signature ? { signature } : {}) });
    return { kind: "document", entry: implementation ?? found };
  }

  return {
    kind: "packageBody",
    entry: found,
    target: sqlObjectNavigationTarget({
      name: found.name,
      type: found.isFunction ? "function" : "procedure",
      schema: context.schema,
      parentName: context.name,
      parentSchema: context.schema,
      ...(signature ? { signature } : {}),
      nameQuoted: identity.nameQuoted || preserveOracleStoreCase(found.name),
      ...(context.schema ? { schemaQuoted: identity.schemaQuoted || preserveOracleStoreCase(context.schema), parentSchemaQuoted: preserveOracleStoreCase(context.schema) } : {}),
      parentNameQuoted: identity.qualifierQuoted || preserveOracleStoreCase(context.name),
    }),
  };
}

/**
 * 把一个包成员目标折成取源请求：取的是包体，成员只用来定位光标。
 *
 * 成员的签名不属于包体的取源身份 —— 混进去会让后端按重载去匹配一个并不存在的独立子程序。
 */
export function oraclePackageMemberSourceRequest(target: SqlObjectNavigationTarget, fallbackSchema?: string): { name: string; objectType: Extract<ObjectSourceKind, "PACKAGE_BODY">; schema?: string; focusMember: PackageMemberFocus } | null {
  const normalized = normalizeOracleNavigationTarget(target);
  const focusMember = sqlObjectNavigationPackageMember(normalized);
  if (!focusMember || sqlObjectNavigationSourceKind(normalized) !== "PACKAGE_BODY") return null;
  return { name: sqlObjectNavigationSourceName(normalized), objectType: "PACKAGE_BODY", schema: sqlObjectNavigationSourceSchema(normalized, fallbackSchema), focusMember };
}
