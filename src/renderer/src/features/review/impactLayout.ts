import type { ImpactEdge, ImpactMap, ImpactNode } from '../../../../shared/impact';

export const NODE_W = 232;
export const NODE_H = 50;
const COL_GAP = 96;
const ROW_GAP = 14;
const PAD = 20;
const HEADER = 30;

export interface PlacedNode {
  node: ImpactNode;
  layer: number;
  x: number;
  y: number;
}

export interface PlacedEdge extends ImpactEdge {
  /** SVG path data, ending where the arrowhead goes. */
  d: string;
  /** Points backwards or within a column (recursion between changed functions). */
  back: boolean;
}

export interface ImpactLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  columns: { x: number; label: string }[];
}

const byLocation = (a: ImpactNode, b: ImpactNode): number =>
  a.path.localeCompare(b.path) || a.startLine - b.startLine || a.id.localeCompare(b.id);

/**
 * Longest-path layers for the changed functions (cycles broken at the first edge that closes
 * one), so a chain of changes reads left to right.
 */
function changedLayers(changed: ImpactNode[], edges: ImpactEdge[]): Map<string, number> {
  const ids = new Set(changed.map((node) => node.id));
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to))
      out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const acyclic = new Map<string, string[]>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 'open') continue; // back edge: drawn, not layered
      acyclic.set(id, [...(acyclic.get(id) ?? []), next]);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const node of changed) if (!state.has(node.id)) visit(node.id);
  const layer = new Map<string, number>(changed.map((node) => [node.id, 0]));
  for (const id of order.reverse()) {
    for (const next of acyclic.get(id) ?? [])
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1));
  }
  return layer;
}

/**
 * Lays the map out as columns: callers, then the changed functions, then what they call. Rows
 * are ordered by file and line, then by a few barycenter passes to untangle the edges.
 */
export function layoutImpact(map: Pick<ImpactMap, 'nodes' | 'edges'>): ImpactLayout {
  const nodes = [...map.nodes].sort(byLocation);
  const changed = nodes.filter((node) => node.changed);
  const layer = changedLayers(changed, map.edges);
  for (const node of nodes) {
    if (node.changed) continue;
    const calls = map.edges.filter(
      (e) => e.from === node.id && layer.has(e.to) && e.to !== node.id,
    );
    const calledBy = map.edges.filter((e) => e.to === node.id && layer.has(e.from));
    // Something that both calls and is called by the change sits with the callers.
    if (calls.length) layer.set(node.id, Math.min(...calls.map((e) => layer.get(e.to) ?? 0)) - 1);
    else if (calledBy.length)
      layer.set(node.id, Math.max(...calledBy.map((e) => layer.get(e.from) ?? 0)) + 1);
  }
  const shift = Math.min(0, ...layer.values());
  const layers: ImpactNode[][] = [];
  for (const node of nodes) {
    const index = (layer.get(node.id) ?? 0) - shift;
    (layers[index] ??= []).push(node);
  }
  const columns = Array.from({ length: layers.length }, (_, i) => layers[i] ?? []);

  const neighbours = new Map<string, string[]>();
  for (const edge of map.edges) {
    if (edge.from === edge.to) continue;
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }
  const rowOf = new Map<string, number>();
  const index = (): void =>
    columns.forEach((column) => column.forEach((node, row) => rowOf.set(node.id, row)));
  index();
  for (let pass = 0; pass < 4; pass++) {
    const sweep = pass % 2 === 0 ? columns : [...columns].reverse();
    for (const column of sweep) {
      const center = new Map(
        column.map((node, row) => {
          const rows = (neighbours.get(node.id) ?? [])
            .map((id) => rowOf.get(id))
            .filter((r): r is number => r !== undefined);
          return [node.id, rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : row];
        }),
      );
      // Array.sort is stable, so ties keep the file-and-line order.
      column.sort((a, b) => (center.get(a.id) ?? 0) - (center.get(b.id) ?? 0));
      column.forEach((node, row) => rowOf.set(node.id, row));
    }
  }
  index();

  const tallest = Math.max(1, ...columns.map((column) => column.length));
  const placed = new Map<string, PlacedNode>();
  columns.forEach((column, layerIndex) => {
    const offset = ((tallest - column.length) * (NODE_H + ROW_GAP)) / 2;
    column.forEach((node, row) => {
      placed.set(node.id, {
        node,
        layer: layerIndex,
        x: PAD + layerIndex * (NODE_W + COL_GAP),
        y: PAD + HEADER + offset + row * (NODE_H + ROW_GAP),
      });
    });
  });

  const edges: PlacedEdge[] = [];
  for (const edge of map.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    let d: string;
    const back = to.layer <= from.layer;
    if (from === to) {
      const x = from.x + NODE_W;
      d = `M ${x} ${from.y + 14} C ${x + 34} ${from.y - 8}, ${x + 34} ${from.y + NODE_H + 8}, ${x + 6} ${from.y + NODE_H - 12}`;
    } else if (!back) {
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x - 6;
      const y2 = to.y + NODE_H / 2;
      const bend = (x2 - x1) / 2;
      d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    } else {
      // Loop under both boxes so a backwards call never crosses the forward edges head-on.
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y + NODE_H + 6;
      const drop = Math.max(y1, y2) + 34;
      d = `M ${x1} ${y1} C ${x1} ${drop}, ${x2} ${drop}, ${x2} ${y2}`;
    }
    edges.push({ ...edge, d, back });
  }

  const first = Math.min(...columns.map((c, i) => (c.some((n) => n.changed) ? i : Infinity)));
  const last = Math.max(...columns.map((c, i) => (c.some((n) => n.changed) ? i : -Infinity)));
  return {
    width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * COL_GAP + 34,
    height: PAD * 2 + HEADER + tallest * (NODE_H + ROW_GAP) + 40,
    nodes: [...placed.values()],
    edges,
    columns: columns.map((_, i) => ({
      x: PAD + i * (NODE_W + COL_GAP),
      label: i < first ? 'Callers' : i > last ? 'Callees' : 'Changed',
    })),
  };
}
