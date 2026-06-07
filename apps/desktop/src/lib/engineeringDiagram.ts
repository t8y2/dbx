import type { DiagramPosition, DiagramRelationship, DiagramTable } from "./erDiagram";

export const ENGINEERING_ENTITY_WIDTH = 184;
export const ENGINEERING_ENTITY_HEIGHT = 58;
export const ENGINEERING_ATTRIBUTE_HEIGHT = 34;
export const ENGINEERING_RELATIONSHIP_WIDTH = 104;
export const ENGINEERING_RELATIONSHIP_HEIGHT = 58;

const ATTRIBUTE_MIN_WIDTH = 96;
const ATTRIBUTE_MAX_WIDTH = 156;
const ATTRIBUTE_GAP_X = 18;
const ATTRIBUTE_GAP_Y = 12;
const ATTRIBUTE_ENTITY_GAP = 38;
const HORIZONTAL_ATTRIBUTE_COLUMNS = 4;
const ENGINEERING_CLUSTER_GAP_X = 120;
const ENGINEERING_CLUSTER_GAP_Y = 100;
const CANVAS_PADDING = 80;

type AttributeSide = "top" | "right" | "bottom" | "left";
type EngineeringColumn = DiagramTable["columns"][number];

interface AttributeDraft {
  column: EngineeringColumn;
  width: number;
}

interface BlockSize {
  width: number;
  height: number;
}

interface EngineeringCluster {
  tableName: string;
  width: number;
  height: number;
  entityX: number;
  entityY: number;
  attributes: EngineeringAttributeNode[];
}

export interface EngineeringEntityNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EngineeringAttributeNode {
  id: string;
  tableName: string;
  columnName: string;
  label: string;
  dataType: string;
  primaryKey: boolean;
  foreignKey: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EngineeringRelationshipNode {
  id: string;
  label: string;
  sourceTable: string;
  targetTable: string;
  sourceCardinality: "1" | "N";
  targetCardinality: "1" | "N";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EngineeringDiagram {
  entities: EngineeringEntityNode[];
  attributes: EngineeringAttributeNode[];
  relationships: EngineeringRelationshipNode[];
  canvas: {
    width: number;
    height: number;
  };
}

function attributeWidth(label: string): number {
  return Math.min(ATTRIBUTE_MAX_WIDTH, Math.max(ATTRIBUTE_MIN_WIDTH, label.length * 10 + 30));
}

function relationshipLabel(relationship: DiagramRelationship): string {
  if (relationship.name && relationship.name.length <= 16) return relationship.name;
  return relationship.sourceColumn || "rel";
}

function entityCenter(entity: EngineeringEntityNode): DiagramPosition {
  return {
    x: entity.x + entity.width / 2,
    y: entity.y + entity.height / 2,
  };
}

function chunkAttributes(items: AttributeDraft[], size: number): AttributeDraft[][] {
  const rows: AttributeDraft[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function rowWidth(items: AttributeDraft[]): number {
  if (items.length === 0) return 0;
  return items.reduce((width, item) => width + item.width, 0) + (items.length - 1) * ATTRIBUTE_GAP_X;
}

function horizontalBlockSize(items: AttributeDraft[]): BlockSize {
  if (items.length === 0) return { width: 0, height: 0 };
  const rows = chunkAttributes(items, HORIZONTAL_ATTRIBUTE_COLUMNS);
  return {
    width: Math.max(...rows.map(rowWidth)),
    height: rows.length * ENGINEERING_ATTRIBUTE_HEIGHT + (rows.length - 1) * ATTRIBUTE_GAP_Y,
  };
}

function verticalBlockSize(items: AttributeDraft[]): BlockSize {
  if (items.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.max(...items.map((item) => item.width)),
    height: items.length * ENGINEERING_ATTRIBUTE_HEIGHT + (items.length - 1) * ATTRIBUTE_GAP_Y,
  };
}

function sideGap(block: BlockSize): number {
  return block.width > 0 && block.height > 0 ? ATTRIBUTE_ENTITY_GAP : 0;
}

function distributeAttributes(table: DiagramTable): Record<AttributeSide, AttributeDraft[]> {
  const sides: AttributeSide[] = ["top", "right", "bottom", "left"];
  const groups: Record<AttributeSide, AttributeDraft[]> = {
    top: [],
    right: [],
    bottom: [],
    left: [],
  };

  table.columns.forEach((column, index) => {
    groups[sides[index % sides.length]].push({
      column,
      width: attributeWidth(column.name),
    });
  });

  return groups;
}

function localAttributeNode(table: DiagramTable, item: AttributeDraft, x: number, y: number): EngineeringAttributeNode {
  return {
    id: `${table.name}:${item.column.name}`,
    tableName: table.name,
    columnName: item.column.name,
    label: item.column.name,
    dataType: item.column.data_type,
    primaryKey: item.column.is_primary_key,
    foreignKey: table.foreignKeys.some((fk) => fk.column === item.column.name),
    x,
    y,
    width: item.width,
    height: ENGINEERING_ATTRIBUTE_HEIGHT,
  };
}

function buildEngineeringCluster(table: DiagramTable): EngineeringCluster {
  const groups = distributeAttributes(table);
  const topSize = horizontalBlockSize(groups.top);
  const rightSize = verticalBlockSize(groups.right);
  const bottomSize = horizontalBlockSize(groups.bottom);
  const leftSize = verticalBlockSize(groups.left);

  const leftGap = sideGap(leftSize);
  const rightGap = sideGap(rightSize);
  const topGap = sideGap(topSize);
  const bottomGap = sideGap(bottomSize);
  const centerWidth = Math.max(ENGINEERING_ENTITY_WIDTH, topSize.width, bottomSize.width);
  const centerHeight = Math.max(ENGINEERING_ENTITY_HEIGHT, leftSize.height, rightSize.height);
  const centerX = leftSize.width + leftGap;
  const centerY = topSize.height + topGap;
  const entityX = centerX + centerWidth / 2 - ENGINEERING_ENTITY_WIDTH / 2;
  const entityY = centerY + centerHeight / 2 - ENGINEERING_ENTITY_HEIGHT / 2;
  const attributes: EngineeringAttributeNode[] = [];

  chunkAttributes(groups.top, HORIZONTAL_ATTRIBUTE_COLUMNS).forEach((row, rowIndex) => {
    let x = centerX + (centerWidth - rowWidth(row)) / 2;
    const y = rowIndex * (ENGINEERING_ATTRIBUTE_HEIGHT + ATTRIBUTE_GAP_Y);
    row.forEach((item) => {
      attributes.push(localAttributeNode(table, item, x, y));
      x += item.width + ATTRIBUTE_GAP_X;
    });
  });

  groups.right.forEach((item, index) => {
    attributes.push(
      localAttributeNode(
        table,
        item,
        centerX + centerWidth + rightGap + (rightSize.width - item.width) / 2,
        centerY + (centerHeight - rightSize.height) / 2 + index * (ENGINEERING_ATTRIBUTE_HEIGHT + ATTRIBUTE_GAP_Y),
      ),
    );
  });

  chunkAttributes(groups.bottom, HORIZONTAL_ATTRIBUTE_COLUMNS).forEach((row, rowIndex) => {
    let x = centerX + (centerWidth - rowWidth(row)) / 2;
    const y = centerY + centerHeight + bottomGap + rowIndex * (ENGINEERING_ATTRIBUTE_HEIGHT + ATTRIBUTE_GAP_Y);
    row.forEach((item) => {
      attributes.push(localAttributeNode(table, item, x, y));
      x += item.width + ATTRIBUTE_GAP_X;
    });
  });

  groups.left.forEach((item, index) => {
    attributes.push(
      localAttributeNode(
        table,
        item,
        (leftSize.width - item.width) / 2,
        centerY + (centerHeight - leftSize.height) / 2 + index * (ENGINEERING_ATTRIBUTE_HEIGHT + ATTRIBUTE_GAP_Y),
      ),
    );
  });

  return {
    tableName: table.name,
    width: leftSize.width + leftGap + centerWidth + rightGap + rightSize.width,
    height: topSize.height + topGap + centerHeight + bottomGap + bottomSize.height,
    entityX,
    entityY,
    attributes,
  };
}

function positionKey(value: number): string {
  return value.toFixed(3);
}

function orderedTableRows(tables: DiagramTable[], positions: Record<string, DiagramPosition>): DiagramTable[][] {
  const columnsPerRow = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(Math.max(tables.length, 1)))));
  const ordered = tables.map((table, fallbackIndex) => ({
    table,
    position: positions[table.name] ?? {
      x: fallbackIndex % columnsPerRow,
      y: Math.floor(fallbackIndex / columnsPerRow),
    },
  }));
  const ys = [...new Set(ordered.map((item) => positionKey(item.position.y)))].sort(
    (left, right) => Number(left) - Number(right),
  );

  return ys.map((y) =>
    ordered
      .filter((item) => positionKey(item.position.y) === y)
      .sort((left, right) => left.position.x - right.position.x)
      .map((item) => item.table),
  );
}

function normalizeDiagram(diagram: Omit<EngineeringDiagram, "canvas">): EngineeringDiagram {
  const rects = [...diagram.entities, ...diagram.attributes, ...diagram.relationships];
  if (rects.length === 0) {
    return {
      ...diagram,
      canvas: {
        width: CANVAS_PADDING * 2,
        height: CANVAS_PADDING * 2,
      },
    };
  }

  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  const dx = CANVAS_PADDING - minX;
  const dy = CANVAS_PADDING - minY;

  const shift = <T extends { x: number; y: number }>(node: T): T => ({
    ...node,
    x: node.x + dx,
    y: node.y + dy,
  });

  return {
    entities: diagram.entities.map(shift),
    attributes: diagram.attributes.map(shift),
    relationships: diagram.relationships.map(shift),
    canvas: {
      width: maxX + dx + CANVAS_PADDING,
      height: maxY + dy + CANVAS_PADDING,
    },
  };
}

export function buildEngineeringDiagram(
  tables: DiagramTable[],
  relationships: DiagramRelationship[],
  positions: Record<string, DiagramPosition>,
): EngineeringDiagram {
  const clusters = new Map(tables.map((table) => [table.name, buildEngineeringCluster(table)]));
  const rows = orderedTableRows(tables, positions);
  const entities: EngineeringEntityNode[] = [];
  const attributes: EngineeringAttributeNode[] = [];
  let nextRowY = 0;

  rows.forEach((row) => {
    const rowClusters = row
      .map((table) => clusters.get(table.name))
      .filter((cluster): cluster is EngineeringCluster => cluster !== undefined);
    const rowHeight = Math.max(...rowClusters.map((cluster) => cluster.height), ENGINEERING_ENTITY_HEIGHT);
    let nextX = 0;

    rowClusters.forEach((cluster) => {
      const originX = nextX;
      const originY = nextRowY + (rowHeight - cluster.height) / 2;

      entities.push({
        id: cluster.tableName,
        name: cluster.tableName,
        x: originX + cluster.entityX,
        y: originY + cluster.entityY,
        width: ENGINEERING_ENTITY_WIDTH,
        height: ENGINEERING_ENTITY_HEIGHT,
      });
      attributes.push(
        ...cluster.attributes.map((attribute) => ({
          ...attribute,
          x: originX + attribute.x,
          y: originY + attribute.y,
        })),
      );

      nextX += cluster.width + ENGINEERING_CLUSTER_GAP_X;
    });

    nextRowY += rowHeight + ENGINEERING_CLUSTER_GAP_Y;
  });
  const entityMap = new Map(entities.map((entity) => [entity.name, entity]));
  const orderedEntities = tables
    .map((table) => entityMap.get(table.name))
    .filter((entity): entity is EngineeringEntityNode => entity !== undefined);

  const relationshipNodes: EngineeringRelationshipNode[] = relationships.flatMap((relationship) => {
    const source = entityMap.get(relationship.sourceTable);
    const target = entityMap.get(relationship.targetTable);
    if (!source || !target) return [];

    const sourceCenter = entityCenter(source);
    const targetCenter = entityCenter(target);
    return [
      {
        id: relationship.id,
        label: relationshipLabel(relationship),
        sourceTable: relationship.sourceTable,
        targetTable: relationship.targetTable,
        sourceCardinality: "N",
        targetCardinality: "1",
        x: (sourceCenter.x + targetCenter.x) / 2 - ENGINEERING_RELATIONSHIP_WIDTH / 2,
        y: (sourceCenter.y + targetCenter.y) / 2 - ENGINEERING_RELATIONSHIP_HEIGHT / 2,
        width: ENGINEERING_RELATIONSHIP_WIDTH,
        height: ENGINEERING_RELATIONSHIP_HEIGHT,
      },
    ];
  });

  return normalizeDiagram({
    entities: orderedEntities,
    attributes,
    relationships: relationshipNodes,
  });
}
