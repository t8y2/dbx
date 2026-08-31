import type { DiagramNode, DiagramEdge, LayoutOptions, DiagramLayer } from "@/types/diagram";
import { computeLayout, computeLayoutWithLayers, type LayerLayoutInfo } from "./elk-layout";

export interface LayoutManagerOptions {
  defaultDirection?: LayoutOptions["direction"];
  gridColumns?: number;
}

export class LayoutManager {
  private defaultDirection: LayoutOptions["direction"];
  private gridColumns: number;

  constructor(options: LayoutManagerOptions = {}) {
    this.defaultDirection = options.defaultDirection || "LR";
    this.gridColumns = options.gridColumns || 4;
  }

  async applyElkLayout(nodes: DiagramNode[], edges: DiagramEdge[], direction?: LayoutOptions["direction"]): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
    return computeLayout(nodes, edges, { direction: direction || this.defaultDirection });
  }

  async applyElkLayoutWithLayers(nodes: DiagramNode[], edges: DiagramEdge[], layers: DiagramLayer[], direction?: LayoutOptions["direction"]): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[]; layerLayouts: LayerLayoutInfo[] }> {
    return computeLayoutWithLayers(nodes, edges, layers, { direction: direction || this.defaultDirection });
  }

  applyGridLayout(nodes: DiagramNode[]): DiagramNode[] {
    const columns = Math.max(1, Math.min(this.gridColumns, Math.ceil(Math.sqrt(nodes.length))));
    const cardWidth = 270;
    const rowHeight = 240;
    const gapX = 64;
    const gapY = 44;
    const margin = 40;

    return nodes.map((node, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return {
        ...node,
        position: {
          x: margin + col * (cardWidth + gapX),
          y: margin + row * (rowHeight + gapY),
        },
      };
    });
  }
}
