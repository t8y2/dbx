import type { QueryResult } from "@/types/database";

export interface DoltRef {
  name: string;
  hash: string;
  kind: "branch" | "tag";
  active: boolean;
}

export interface DoltCommit {
  hash: string;
  parents: string[];
  committer: string;
  email: string;
  date: string;
  message: string;
  refs: string[];
}

export interface DoltTableChange {
  tableName: string;
  fromTableName: string;
  toTableName: string;
  diffType: string;
  dataChange: boolean;
  schemaChange: boolean;
}

export type DoltTableChangeKind = "added" | "removed" | "modified" | "schema" | "mixed";
export type DoltTableChangeFlag = "data" | "schema" | "metadata";

/** Matches Dolt's table-level change classification used by the reference UI. */
export function doltTableChangeKind(change: Pick<DoltTableChange, "diffType" | "dataChange" | "schemaChange">): DoltTableChangeKind {
  const normalized = change.diffType.trim().toLowerCase();
  if (normalized.includes("add") || normalized.includes("create")) return "added";
  if (normalized.includes("drop") || normalized.includes("remove") || normalized.includes("delete")) return "removed";
  if (change.schemaChange && change.dataChange) return "mixed";
  if (change.schemaChange) return "schema";
  return "modified";
}

export function doltTableChangeSymbol(change: Pick<DoltTableChange, "diffType" | "dataChange" | "schemaChange">): "+" | "-" | "*" {
  const kind = doltTableChangeKind(change);
  return kind === "added" ? "+" : kind === "removed" ? "-" : "*";
}

export function doltTableChangeFlags(change: Pick<DoltTableChange, "diffType" | "dataChange" | "schemaChange">): DoltTableChangeFlag[] {
  const flags: DoltTableChangeFlag[] = [];
  if (change.dataChange) flags.push("data");
  if (change.schemaChange) flags.push("schema");
  if (flags.length === 0 && change.diffType.trim()) flags.push("metadata");
  return flags;
}

export interface DoltWorkingChange {
  tableName: string;
  staged: boolean;
  status: string;
}

export type DoltRowChangeKind = "added" | "removed" | "modified";
export type DoltDiffColumnKind = "unchanged" | "added" | "removed";

export interface DoltDiffRow {
  kind: DoltRowChangeKind;
  before: QueryResult["rows"][number];
  after: QueryResult["rows"][number];
  changedColumns: string[];
}

export interface DoltParsedRowDiff {
  columns: string[];
  columnKinds: DoltDiffColumnKind[];
  rows: DoltDiffRow[];
}

export interface DoltGraphLayout {
  lane: number;
  nodeRef: string | null;
  edges: DoltGraphEdge[];
  maxLane: number;
}

export interface DoltGraphEdge {
  fromLane: number;
  toLane: number;
  colorLane: number;
  colorRef: string | null;
}

export interface DoltClientSessionScope {
  connectionId: string;
  database: string;
  clientSessionId: string;
}

export type DoltGraphEdgeRoute = "direct" | "fork" | "merge";
const DOLT_GRAPH_DIAGONAL_HEIGHT = 30;

export function doltGraphEdgeRoute(parentLane: number, childLane: number, rowDistance: number, childParentCount: number): DoltGraphEdgeRoute {
  if (parentLane === childLane || rowDistance <= 1) return "direct";
  if (childParentCount > 1) return "merge";
  return "fork";
}

export function doltGraphEdgePath(startX: number, startY: number, targetX: number, targetY: number, route: DoltGraphEdgeRoute = "direct"): string {
  if (startX === targetX || route === "direct") return `M ${startX} ${startY} L ${targetX} ${targetY}`;
  const availableHeight = Math.abs(targetY - startY);
  const diagonalHeight = DOLT_GRAPH_DIAGONAL_HEIGHT;
  if (diagonalHeight >= availableHeight) return `M ${startX} ${startY} L ${targetX} ${targetY}`;
  const direction = Math.sign(targetY - startY) || 1;
  if (route === "fork") return `M ${startX} ${startY} L ${targetX} ${startY + direction * diagonalHeight} L ${targetX} ${targetY}`;
  return `M ${startX} ${startY} L ${startX} ${targetY - direction * diagonalHeight} L ${targetX} ${targetY}`;
}

export function doltClientSessionScope(connectionId: string, database: string): DoltClientSessionScope {
  return {
    connectionId,
    database,
    clientSessionId: `dolt-version-control:${connectionId}:${database}`,
  };
}

export function doltSqlLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

export function doltLogSql(revision: string, limit = 500): string {
  return `SELECT * FROM DOLT_LOG(${doltSqlLiteral(revision)}, '--parents', '--decorate', 'short') LIMIT ${Math.max(1, Math.floor(limit))}`;
}

export function doltStatusSql(): string {
  return "SELECT table_name, staged, status FROM dolt_status ORDER BY table_name, staged DESC";
}

export function doltAddAllSql(): string {
  return "CALL DOLT_ADD('.')";
}

export function doltCommitSql(message: string): string {
  return `CALL DOLT_COMMIT('-m', ${doltSqlLiteral(message)})`;
}

export function doltDiffSummarySql(fromRevision: string, toRevision: string): string {
  return `SELECT * FROM DOLT_DIFF_SUMMARY(${doltSqlLiteral(fromRevision)}, ${doltSqlLiteral(toRevision)})`;
}

export function doltTableDiffSql(fromRevision: string, toRevision: string, tableName: string, limit = 200, offset = 0): string {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  return `SELECT * FROM DOLT_DIFF(${doltSqlLiteral(fromRevision)}, ${doltSqlLiteral(toRevision)}, ${doltSqlLiteral(tableName)}) LIMIT ${Math.max(1, Math.floor(limit))}${normalizedOffset > 0 ? ` OFFSET ${normalizedOffset}` : ""}`;
}

export function doltTableDiffCountSql(fromRevision: string, toRevision: string, tableName: string): string {
  return `SELECT COUNT(*) AS row_count FROM DOLT_DIFF(${doltSqlLiteral(fromRevision)}, ${doltSqlLiteral(toRevision)}, ${doltSqlLiteral(tableName)})`;
}

export function doltCreateBranchSql(branchName: string, sourceRevision?: string): string {
  const source = sourceRevision?.trim();
  return source ? `CALL DOLT_BRANCH(${doltSqlLiteral(branchName)}, ${doltSqlLiteral(source)})` : `CALL DOLT_BRANCH(${doltSqlLiteral(branchName)})`;
}

export function doltMergeBranchSql(branchName: string): string {
  return `CALL DOLT_MERGE(${doltSqlLiteral(branchName)})`;
}

export function doltCheckoutBranchSql(branchName: string): string {
  return `CALL DOLT_CHECKOUT(${doltSqlLiteral(branchName)})`;
}

export function doltRevertCommitSql(revision: string): string {
  return `CALL DOLT_REVERT(${doltSqlLiteral(revision)})`;
}

export function doltHardResetSql(revision: string): string {
  return `CALL DOLT_RESET('--hard', ${doltSqlLiteral(revision)})`;
}

export function doltDiscardWorkingTreeSql(): string {
  return doltHardResetSql("HEAD");
}

export function doltCreateTagSql(tagName: string, sourceRevision?: string): string {
  const source = sourceRevision?.trim();
  return source ? `CALL DOLT_TAG(${doltSqlLiteral(tagName)}, ${doltSqlLiteral(source)})` : `CALL DOLT_TAG(${doltSqlLiteral(tagName)})`;
}

export function doltDeleteTagSql(tagName: string): string {
  return `CALL DOLT_TAG('-d', ${doltSqlLiteral(tagName)})`;
}

export function doltDeleteBranchSql(branchName: string): string {
  return `CALL DOLT_BRANCH('-d', ${doltSqlLiteral(branchName)})`;
}

function normalizedColumnIndex(result: QueryResult): Map<string, number> {
  return new Map(result.columns.map((column, index) => [column.trim().toLowerCase(), index]));
}

function valueFromRow(row: QueryResult["rows"][number], columns: Map<string, number>, names: string[]): string {
  for (const name of names) {
    const index = columns.get(name.toLowerCase());
    if (index !== undefined && row[index] !== null && row[index] !== undefined) return String(row[index]);
  }
  return "";
}

function booleanFromRow(row: QueryResult["rows"][number], columns: Map<string, number>, names: string[]): boolean {
  const value = valueFromRow(row, columns, names).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseParents(value: string): string[] {
  return value
    .replace(/[;,]/g, " ")
    .split(/\s+/)
    .map((parent) => parent.trim())
    .filter(Boolean);
}

function parseRefs(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((ref) =>
      ref
        .trim()
        .replace(/^HEAD\s*->\s*/i, "")
        .replace(/^refs\/tags\//i, "tag: ")
        .replace(/^refs\/(?:heads|remotes)\//i, ""),
    )
    .filter(Boolean);
}

function decorationRef(decoration: string, hash: string): DoltRef | null {
  let name = decoration.trim();
  if (!name) return null;

  name = name.replace(/^HEAD\s*->\s*/i, "").trim();
  if (!name || name.toUpperCase() === "HEAD") return null;

  let kind: DoltRef["kind"] = "branch";
  if (/^(?:tag:\s*|refs\/tags\/)/i.test(name)) {
    kind = "tag";
    name = name.replace(/^(?:tag:\s*|refs\/tags\/)/i, "").trim();
  } else {
    name = name.replace(/^refs\/(?:heads|remotes)\//i, "").trim();
  }
  return name ? { name, hash, kind, active: false } : null;
}

export function parseDoltCommits(result: QueryResult): DoltCommit[] {
  const columns = normalizedColumnIndex(result);
  return result.rows
    .map((row) => ({
      hash: valueFromRow(row, columns, ["commit_hash", "hash", "commit"]),
      parents: parseParents(valueFromRow(row, columns, ["parents", "parent_hashes", "parent"])),
      committer: valueFromRow(row, columns, ["committer", "commit_user", "author", "name"]),
      email: valueFromRow(row, columns, ["email", "committer_email", "author_email"]),
      date: valueFromRow(row, columns, ["date", "commit_date", "timestamp"]),
      message: valueFromRow(row, columns, ["message", "commit_message"]),
      refs: parseRefs(valueFromRow(row, columns, ["refs", "ref_names", "decorations", "decorate"])),
    }))
    .filter((commit) => commit.hash);
}

export function parseDoltBranches(result: QueryResult, activeBranch: string): DoltRef[] {
  const columns = normalizedColumnIndex(result);
  return result.rows
    .map((row) => {
      const name = valueFromRow(row, columns, ["name", "branch"]);
      return {
        name,
        hash: valueFromRow(row, columns, ["hash", "commit_hash"]),
        kind: "branch" as const,
        active: name === activeBranch,
      };
    })
    .filter((ref) => ref.name);
}

export function parseDoltTags(result: QueryResult): DoltRef[] {
  const columns = normalizedColumnIndex(result);
  return result.rows
    .map((row) => ({
      name: valueFromRow(row, columns, ["tag_name", "name", "tag"]),
      hash: valueFromRow(row, columns, ["tag_hash", "hash", "commit_hash"]),
      kind: "tag" as const,
      active: false,
    }))
    .filter((ref) => ref.name);
}

export function parseDoltStatus(result: QueryResult): DoltWorkingChange[] {
  const columns = normalizedColumnIndex(result);
  return result.rows
    .map((row) => ({
      tableName: valueFromRow(row, columns, ["table_name", "name", "table"]),
      staged: booleanFromRow(row, columns, ["staged", "is_staged"]),
      status: valueFromRow(row, columns, ["status", "change_type"]),
    }))
    .filter((change) => change.tableName);
}

export function parseDoltTableChanges(result: QueryResult): DoltTableChange[] {
  const columns = normalizedColumnIndex(result);
  return result.rows
    .map((row) => {
      const fromTableName = valueFromRow(row, columns, ["from_table_name", "from_table"]);
      const toTableName = valueFromRow(row, columns, ["to_table_name", "to_table"]);
      return {
        tableName: toTableName || fromTableName,
        fromTableName,
        toTableName,
        diffType: valueFromRow(row, columns, ["diff_type", "change_type"]) || "modified",
        dataChange: booleanFromRow(row, columns, ["data_change", "data_changed"]),
        schemaChange: booleanFromRow(row, columns, ["schema_change", "schema_changed"]),
      };
    })
    .filter((change) => change.tableName);
}

const DOLT_DIFF_METADATA_COLUMNS = new Set(["commit", "commit_hash", "commit_date", "from_commit", "to_commit", "from_commit_hash", "to_commit_hash", "from_commit_date", "to_commit_date", "table_name", "from_table_name", "to_table_name", "diff_type", "conflict_type"]);

function diffValue(row: QueryResult["rows"][number], index: number | undefined): QueryResult["rows"][number][number] {
  return index === undefined ? null : (row[index] ?? null);
}

function diffKind(value: unknown, hasBefore: boolean, hasAfter: boolean): DoltRowChangeKind {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized.includes("add") || normalized.includes("insert") || normalized === "new") return "added";
  if (normalized.includes("remove") || normalized.includes("delete") || normalized.includes("drop") || normalized === "old") return "removed";
  if (!hasBefore && hasAfter) return "added";
  if (hasBefore && !hasAfter) return "removed";
  return "modified";
}

function normalizedDiffColumnName(column: string): string {
  const unqualified = column.trim().split(".").pop() ?? column;
  return unqualified.replace(/^[`"\x5b]|[`"\x5d]$/g, "").trim();
}

function diffColumnSide(column: string): { side: "from" | "to"; field: string } | null {
  const name = normalizedDiffColumnName(column);
  const normalized = name.toLowerCase();
  if (normalized.startsWith("from_")) return { side: "from", field: name.slice(5) };
  if (normalized.startsWith("to_")) return { side: "to", field: name.slice(3) };
  if (normalized.endsWith("_from")) return { side: "from", field: name.slice(0, -5) };
  if (normalized.endsWith("_to")) return { side: "to", field: name.slice(0, -3) };
  return null;
}

export function parseDoltRowDiff(result: QueryResult, schemaChange = false): DoltParsedRowDiff {
  const pairs = new Map<string, { name: string; fromIndex?: number; toIndex?: number }>();
  let diffTypeIndex: number | undefined;
  result.columns.forEach((column, index) => {
    const normalized = normalizedDiffColumnName(column).toLowerCase();
    if (normalized === "diff_type") diffTypeIndex = index;
    const descriptor = diffColumnSide(column);
    if (!descriptor || !descriptor.field || DOLT_DIFF_METADATA_COLUMNS.has(normalized)) return;
    const key = descriptor.field.toLowerCase();
    const pair = pairs.get(key) ?? { name: descriptor.field };
    if (descriptor.side === "from") pair.fromIndex = index;
    else pair.toIndex = index;
    pairs.set(key, pair);
  });

  const columns = [...pairs.values()];
  const rows = result.rows.map((row) => {
    const before = columns.map((pair) => diffValue(row, pair.fromIndex));
    const after = columns.map((pair) => diffValue(row, pair.toIndex));
    const hasBefore = before.some((value) => value !== null);
    const hasAfter = after.some((value) => value !== null);
    const changedColumns = columns.filter((_, index) => before[index] !== after[index]).map((pair) => pair.name);
    return {
      kind: diffKind(diffValue(row, diffTypeIndex), hasBefore, hasAfter),
      before,
      after,
      changedColumns,
    };
  });

  const columnKinds = columns.map((pair, index): DoltDiffColumnKind => {
    if (pair.fromIndex === undefined) return "added";
    if (pair.toIndex === undefined) return "removed";
    if (!schemaChange) return "unchanged";
    const hasBeforeValue = rows.some((row) => row.before[index] !== null && String(row.before[index]).trim() !== "");
    const hasAfterValue = rows.some((row) => row.after[index] !== null && String(row.after[index]).trim() !== "");
    if (!hasBeforeValue && hasAfterValue) return "added";
    if (hasBeforeValue && !hasAfterValue) return "removed";
    return "unchanged";
  });

  return {
    columns: columns.map((pair) => pair.name),
    columnKinds,
    rows,
  };
}

function matchingHash(hashes: Iterable<string>, candidate: string): string | undefined {
  for (const hash of hashes) {
    if (hash === candidate || hash.startsWith(candidate) || candidate.startsWith(hash)) return hash;
  }
  return undefined;
}

export function doltRefsByCommit(commits: readonly DoltCommit[], refs: readonly DoltRef[]): Map<string, DoltRef[]> {
  const hashes = commits.map((commit) => commit.hash);
  const result = new Map<string, DoltRef[]>();
  const seenByHash = new Map<string, Set<string>>();
  const append = (hash: string, ref: DoltRef) => {
    const seen = seenByHash.get(hash) ?? new Set<string>();
    const key = `${ref.kind}:${ref.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    seenByHash.set(hash, seen);
    const entries = result.get(hash) ?? [];
    entries.push(ref);
    result.set(hash, entries);
  };

  for (const ref of refs) {
    const hash = matchingHash(hashes, ref.hash);
    if (!hash) continue;
    append(hash, ref);
  }
  for (const commit of commits) {
    for (const decoration of commit.refs) {
      const ref = decorationRef(decoration, commit.hash);
      if (ref) append(commit.hash, ref);
    }
  }
  for (const entries of result.values()) {
    entries.sort((left, right) => Number(right.active) - Number(left.active) || (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "branch" ? -1 : 1));
  }
  return result;
}

export function doltRefColorIndexes(refs: Iterable<string>, colorCount: number): Map<string, number> {
  const normalizedColorCount = Math.max(1, Math.floor(colorCount));
  const names = [...new Set([...refs].map((ref) => ref.trim()).filter(Boolean))].sort();
  const result = new Map<string, number>();
  const used = new Set<number>();
  for (const name of names) {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) hash = (Math.imul(31, hash) + name.charCodeAt(index)) | 0;
    const preferred = ((hash % normalizedColorCount) + normalizedColorCount) % normalizedColorCount;
    let colorIndex = preferred;
    for (let offset = 0; offset < normalizedColorCount; offset += 1) {
      const candidate = (preferred + offset) % normalizedColorCount;
      if (!used.has(candidate)) {
        colorIndex = candidate;
        break;
      }
    }
    result.set(name, colorIndex);
    used.add(colorIndex);
  }
  return result;
}

function primaryGraphRef(refs: readonly DoltRef[], activeBranch: string): string | null {
  return refs.find((ref) => ref.kind === "branch" && (ref.active || ref.name === activeBranch))?.name ?? refs.find((ref) => ref.kind === "branch" && !ref.name.startsWith("origin/"))?.name ?? refs[0]?.name ?? null;
}

export function layoutDoltCommitGraph(commits: readonly DoltCommit[], refs: readonly DoltRef[] = [], activeBranch = ""): { rows: DoltGraphLayout[]; laneCount: number } {
  const knownHashes = new Set(commits.map((commit) => commit.hash));
  const canonical = (hash: string) => matchingHash(knownHashes, hash) ?? hash;
  const commitIndexByHash = new Map<string, number>();
  commits.forEach((commit, index) => {
    commitIndexByHash.set(commit.hash, index);
    if (commit.hash.length > 8) commitIndexByHash.set(commit.hash.slice(0, 8), index);
  });
  const refByCommit = doltRefsByCommit(commits, refs);
  const refByHash = new Map<string, string>();
  for (const commit of commits) {
    const ref = primaryGraphRef(refByCommit.get(commit.hash) ?? [], activeBranch);
    if (ref) refByHash.set(commit.hash, ref);
  }

  // Reserve lane 0 for the active branch's first-parent chain. Dolt returns
  // merge history in a topological order where side commits can appear between
  // mainline commits, so lane allocation must be driven by branch ancestry
  // rather than by the order in which rows happen to be returned.
  const commitByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const activeBranchRef = refs.find((ref) => ref.kind === "branch" && (ref.active || ref.name === activeBranch));
  let primaryHash = activeBranchRef ? canonical(activeBranchRef.hash) : undefined;
  if (!primaryHash && activeBranch) {
    primaryHash = commits.find((commit) => refByCommit.get(commit.hash)?.some((ref) => ref.kind === "branch" && ref.name === activeBranch))?.hash;
  }
  if (activeBranch && (!primaryHash || !commitByHash.has(primaryHash))) primaryHash = commits[0]?.hash;
  const primaryCommitHashes = new Set<string>();
  while (primaryHash && commitByHash.has(primaryHash) && !primaryCommitHashes.has(primaryHash)) {
    primaryCommitHashes.add(primaryHash);
    primaryHash = canonical(commitByHash.get(primaryHash)?.parents[0] ?? "");
  }

  let lanes: Array<string | null> = [];
  let laneRefs: Array<string | null> = [];
  const rows: DoltGraphLayout[] = [];
  let laneCount = 1;

  const setLane = (values: Array<string | null>, lane: number, value: string | null) => {
    while (values.length <= lane) values.push(null);
    values[lane] = value;
  };
  const firstEmptyLane = (values: Array<string | null>, startLane: number, blockedLane = -1) => {
    for (let lane = Math.max(0, startLane); lane < values.length; lane += 1) {
      if (lane !== blockedLane && values[lane] === null) return lane;
    }
    values.push(null);
    return values.length - 1;
  };

  for (let rowIndex = 0; rowIndex < commits.length; rowIndex += 1) {
    const commit = commits[rowIndex];
    const isPrimaryCommit = primaryCommitHashes.has(commit.hash);
    let nodeLane = lanes.indexOf(commit.hash);
    if (isPrimaryCommit) {
      if (nodeLane > 0) {
        const laneZeroHash = lanes[0] ?? null;
        const laneZeroRef = laneRefs[0] ?? null;
        setLane(lanes, 0, commit.hash);
        setLane(laneRefs, 0, laneRefs[nodeLane] ?? null);
        setLane(lanes, nodeLane, laneZeroHash);
        setLane(laneRefs, nodeLane, laneZeroRef);
      } else if (nodeLane < 0) {
        if (lanes[0] && lanes[0] !== commit.hash) {
          const displacedLane = firstEmptyLane(lanes, 1);
          setLane(lanes, displacedLane, lanes[0]);
          setLane(laneRefs, displacedLane, laneRefs[0] ?? null);
        }
        nodeLane = 0;
        setLane(lanes, nodeLane, commit.hash);
      }
      nodeLane = 0;
    } else {
      if (nodeLane === 0 && primaryCommitHashes.size > 0) {
        const displacedLane = firstEmptyLane(lanes, 1);
        setLane(lanes, displacedLane, lanes[0] ?? null);
        setLane(laneRefs, displacedLane, laneRefs[0] ?? null);
        setLane(lanes, 0, null);
        setLane(laneRefs, 0, null);
        nodeLane = displacedLane;
      }
      if (nodeLane < 0) {
        nodeLane = firstEmptyLane(lanes, primaryCommitHashes.size > 0 ? 1 : rowIndex === 0 ? 0 : 1);
        setLane(lanes, nodeLane, commit.hash);
      }
    }
    const commitRef = refByHash.get(commit.hash) ?? laneRefs[nodeLane] ?? null;
    setLane(laneRefs, nodeLane, commitRef);

    const edges: DoltGraphEdge[] = [];
    const visibleParents = commit.parents.map(canonical).filter((parent) => commitIndexByHash.has(parent));
    const nextLanes = [...lanes];
    const nextLaneRefs = [...laneRefs];
    if (visibleParents.length === 0) {
      setLane(nextLanes, nodeLane, null);
      setLane(nextLaneRefs, nodeLane, null);
    } else {
      visibleParents.forEach((parent, parentIndex) => {
        let parentLane: number;
        if (parentIndex === 0) {
          const existingParentLane = nextLanes.indexOf(parent);
          if (existingParentLane >= 0 && existingParentLane !== nodeLane) {
            parentLane = existingParentLane;
          } else {
            for (let lane = 0; lane < nextLanes.length; lane += 1) {
              if (nextLanes[lane] === parent) nextLanes[lane] = null;
            }
            parentLane = nodeLane;
            setLane(nextLanes, parentLane, parent);
          }
        } else {
          parentLane = nextLanes.indexOf(parent);
          if (parentLane < 0 || parentLane === nodeLane) {
            if (parentLane === nodeLane) setLane(nextLanes, parentLane, null);
            parentLane = firstEmptyLane(nextLanes, 0, nodeLane);
          }
          setLane(nextLanes, parentLane, parent);
        }
        let parentRef = refByHash.get(parent) ?? nextLaneRefs[parentLane] ?? null;
        if (parentIndex === 0 && !parentRef) parentRef = laneRefs[nodeLane] ?? null;
        setLane(nextLaneRefs, parentLane, parentRef);
        edges.push({ fromLane: nodeLane, toLane: parentLane, colorLane: parentIndex === 0 ? nodeLane : parentLane, colorRef: parentIndex === 0 ? (laneRefs[nodeLane] ?? null) : parentRef });
      });
      for (let lane = 0; lane < nextLanes.length; lane += 1) {
        if (nextLanes[lane] === commit.hash) nextLanes[lane] = null;
      }
    }

    for (let lane = 0; lane < lanes.length; lane += 1) {
      const laneHash = lanes[lane];
      if (!laneHash || laneHash === commit.hash) continue;
      const targetLane = nextLanes.indexOf(laneHash);
      if (targetLane < 0) continue;
      const colorRef = laneRefs[lane] ?? null;
      setLane(nextLaneRefs, targetLane, colorRef);
      edges.push({ fromLane: lane, toLane: targetLane, colorLane: lane, colorRef });
    }

    const maxLane = Math.max(
      0,
      lanes.reduce((maximum, hash, lane) => (hash ? Math.max(maximum, lane) : maximum), 0),
      nextLanes.reduce((maximum, hash, lane) => (hash ? Math.max(maximum, lane) : maximum), 0),
    );
    rows.push({ lane: nodeLane, nodeRef: laneRefs[nodeLane] ?? null, edges, maxLane });
    laneCount = Math.max(laneCount, maxLane + 1, nodeLane + 1);

    const seen = new Set<string>();
    for (let lane = 0; lane < nextLanes.length; lane += 1) {
      const hash = nextLanes[lane];
      const targetIndex = hash ? commitIndexByHash.get(hash) : undefined;
      if (!hash || targetIndex === undefined || targetIndex < rowIndex + 1 || seen.has(hash)) {
        nextLanes[lane] = null;
        nextLaneRefs[lane] = null;
      } else {
        seen.add(hash);
      }
    }
    while (nextLanes.length > 0 && nextLanes[nextLanes.length - 1] === null) {
      nextLanes.pop();
      nextLaneRefs.pop();
    }
    lanes = nextLanes;
    laneRefs = nextLaneRefs.slice(0, nextLanes.length);
  }
  return { rows, laneCount };
}
