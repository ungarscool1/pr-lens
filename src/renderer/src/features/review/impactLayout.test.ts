import { describe, expect, it } from 'vitest';
import type { ImpactNode } from '../../../../shared/impact';
import { layoutImpact } from './impactLayout';

const node = (name: string, changed = false, path = 'src/a.ts', startLine = 1): ImpactNode => ({
  id: `${path}#${name}`,
  name,
  kind: 'function',
  container: null,
  path,
  startLine,
  endLine: startLine + 2,
  changed,
  test: false,
  anchorLineId: changed ? 'F1-001' : null,
});

const layerOf = (layout: ReturnType<typeof layoutImpact>, name: string): number | undefined =>
  layout.nodes.find((placed) => placed.node.name === name)?.layer;

describe('layoutImpact', () => {
  it('puts callers left of the change and callees right of it', () => {
    const [caller, changed, callee] = [node('caller'), node('changed', true), node('callee')];
    const layout = layoutImpact({
      nodes: [callee, changed, caller],
      edges: [
        { from: caller.id, to: changed.id },
        { from: changed.id, to: callee.id },
      ],
    });
    expect([
      layerOf(layout, 'caller'),
      layerOf(layout, 'changed'),
      layerOf(layout, 'callee'),
    ]).toEqual([0, 1, 2]);
    expect(layout.columns.map((column) => column.label)).toEqual(['Callers', 'Changed', 'Callees']);
    expect(layout.edges.every((edge) => !edge.back)).toBe(true);
  });

  it('chains changed functions left to right and survives recursion', () => {
    const [a, b, c] = [node('a', true), node('b', true), node('c', true)];
    const layout = layoutImpact({
      nodes: [a, b, c],
      edges: [
        { from: a.id, to: b.id },
        { from: b.id, to: c.id },
        { from: c.id, to: a.id },
        { from: b.id, to: b.id },
      ],
    });
    expect([layerOf(layout, 'a'), layerOf(layout, 'b'), layerOf(layout, 'c')]).toEqual([0, 1, 2]);
    expect(layout.columns.map((column) => column.label)).toEqual(['Changed', 'Changed', 'Changed']);
    const back = layout.edges.filter((edge) => edge.back).map((edge) => [edge.from, edge.to]);
    expect(back).toEqual([
      [c.id, a.id],
      [b.id, b.id],
    ]);
  });

  it('orders a column to follow its neighbours, keeping file order on ties', () => {
    const [x, y] = [node('x', true, 'src/x.ts'), node('y', true, 'src/y.ts')];
    // Callers sorted by path would be [callsY, callsX]; the barycenter pass swaps them.
    const [callsY, callsX] = [node('callsY', false, 'src/1.ts'), node('callsX', false, 'src/2.ts')];
    const layout = layoutImpact({
      nodes: [x, y, callsX, callsY],
      edges: [
        { from: callsX.id, to: x.id },
        { from: callsY.id, to: y.id },
      ],
    });
    const top = (name: string): number => layout.nodes.find((p) => p.node.name === name)?.y ?? -1;
    expect(top('callsX')).toBeLessThan(top('callsY'));
    expect(top('x')).toBeLessThan(top('y'));
  });

  it('lays out a lone changed function with no edges', () => {
    const layout = layoutImpact({ nodes: [node('alone', true)], edges: [] });
    expect(layout.nodes).toHaveLength(1);
    expect(layout.columns).toEqual([{ x: 20, label: 'Changed' }]);
    expect(layout.width).toBeGreaterThan(0);
  });
});
