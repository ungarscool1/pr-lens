import { describe, expect, it } from 'vitest';
import type { DiffFile, DiffLine } from '../../shared/diff';
import { analyzeImpact } from './analysis';
import { changedLines } from './changes';
import type { SourceText } from './analysis';

/** A one-hunk diff of `path` where `added` new lines are additions and the rest context. */
function diffFile(
  fid: string,
  path: string,
  text: string,
  added: number[],
  deletedBefore: number[] = [],
): DiffFile {
  const lines: DiffLine[] = [];
  let n = 0;
  text.split('\n').forEach((content, index) => {
    const line = index + 1;
    if (deletedBefore.includes(line))
      lines.push({
        id: `${fid}-${String(++n).padStart(3, '0')}`,
        kind: 'del',
        old: line,
        text: 'gone',
      });
    lines.push({
      id: `${fid}-${String(++n).padStart(3, '0')}`,
      kind: added.includes(line) ? 'add' : 'ctx',
      ...(added.includes(line) ? {} : { old: line }),
      new: line,
      text: content,
    });
  });
  return {
    fid,
    path,
    status: 'modified',
    binary: false,
    additions: added.length,
    deletions: deletedBefore.length,
    noise: null,
    hunks: [{ header: '@@', lines }],
  };
}

const analyze = (sources: SourceText[], files: DiffFile[], configs: SourceText[] = []) =>
  analyzeImpact({ sources, diff: { files }, skippedFiles: 0, configs });

const math = [
  "import { format } from '@lib/format';",
  '',
  'export function changed(input: string) {',
  '  return format(input);',
  '}',
  '',
  'export function neighbour() {',
  "  return 'unchanged';",
  '}',
].join('\n');

describe('analyzeImpact', () => {
  it('builds callers and callees with the language service, through path aliases', () => {
    const map = analyze(
      [
        { path: 'src/math.ts', text: math },
        {
          path: 'src/lib/format.ts',
          text: 'export function format(input: string) { return input; }\n',
        },
        {
          path: 'src/client.ts',
          text: "import { changed } from './math';\n\nexport const caller = () => changed(' value ');\n",
        },
        {
          path: 'src/math.test.ts',
          text: "import { changed } from './math';\n\nchanged('top level');\n",
        },
      ],
      // Line 6 is context next to the change; it must not make `neighbour` look changed.
      [diffFile('F1', 'src/math.ts', math, [4])],
      [
        { path: 'tsconfig.json', text: '{ "extends": "./tsconfig.base.json" }' },
        {
          path: 'tsconfig.base.json',
          text: '{ // comments are allowed\n "compilerOptions": { "paths": { "@lib/*": ["./src/lib/*"] } } }',
        },
      ],
    );

    const byName = new Map(map.nodes.map((node) => [node.name, node]));
    const changed = byName.get('changed');
    expect(changed).toMatchObject({
      changed: true,
      path: 'src/math.ts',
      startLine: 3,
      anchorLineId: 'F1-004',
    });
    expect(byName.has('neighbour')).toBe(false);
    expect(byName.get('caller')?.changed).toBe(false);
    expect(byName.get('math.test.ts')?.kind).toBe('module');
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: byName.get('caller')?.id, to: changed?.id },
        { from: byName.get('math.test.ts')?.id, to: changed?.id },
        { from: changed?.id, to: byName.get('format')?.id },
      ]),
    );
    expect(map.imports).toEqual([
      { path: 'src/math.ts', module: '@lib/format', resolvedPath: 'src/lib/format.ts' },
    ]);
    expect(map.tests).toEqual([{ path: 'src/math.test.ts', relatedNodeIds: [changed?.id] }]);
  });

  it('resolves calls through an interface to an object-literal implementation', () => {
    const service = [
      'export interface Store {',
      '  load(key: string): string;',
      '}',
      '',
      'export function createStore(): Store {',
      '  return {',
      '    load(key) {',
      '      return key.trim();',
      '    },',
      '  };',
      '}',
    ].join('\n');
    const map = analyze(
      [
        { path: 'src/store.ts', text: service },
        {
          path: 'src/use.ts',
          text: "import type { Store } from './store';\n\nexport function read(store: Store) {\n  return store.load('k');\n}\n",
        },
      ],
      [diffFile('F1', 'src/store.ts', service, [8])],
    );
    const load = map.nodes.find((node) => node.changed);
    expect(load).toMatchObject({ name: 'load', startLine: 7 });
    const read = map.nodes.find((node) => node.name === 'read');
    expect(map.edges).toContainEqual({ from: read?.id, to: load?.id });
  });

  it('counts JSX usage of a changed component as a call', () => {
    const button = 'export function Button() {\n  return <button>ok</button>;\n}\n';
    const map = analyze(
      [
        { path: 'src/Button.tsx', text: button },
        {
          path: 'src/Page.tsx',
          text: "import { Button } from './Button';\n\nexport const Page = () => <Button />;\n",
        },
      ],
      [diffFile('F1', 'src/Button.tsx', button, [2])],
    );
    const page = map.nodes.find((node) => node.name === 'Page');
    const target = map.nodes.find((node) => node.name === 'Button');
    expect(target?.changed).toBe(true);
    expect(map.edges).toContainEqual({ from: page?.id, to: target?.id });
  });

  it('attributes a pure deletion to the declaration that contained it', () => {
    const text = 'export class Box {\n  constructor() {\n    this.ready();\n  }\n  ready() {}\n}\n';
    const map = analyze(
      [{ path: 'src/box.ts', text }],
      [diffFile('F1', 'src/box.ts', text, [], [3])],
    );
    // The call hierarchy reports a constructor as its class.
    const box = map.nodes.find((node) => node.changed);
    expect(box).toMatchObject({ kind: 'class', name: 'Box', startLine: 1, anchorLineId: 'F1-003' });
    expect(map.edges).toContainEqual({
      from: box?.id,
      to: map.nodes.find((node) => node.name === 'ready')?.id,
    });
  });

  it('marks a recursive call as a self edge and never invents nodes for unknown code', () => {
    const text =
      "import { external } from 'some-package';\n\nexport function walk(n: number): number {\n  external(n);\n  return n ? walk(n - 1) : 0;\n}\n";
    const map = analyze(
      [{ path: 'src/walk.ts', text }],
      [diffFile('F1', 'src/walk.ts', text, [5])],
    );
    expect(map.nodes.map((node) => node.name)).toEqual(['walk']);
    expect(map.edges).toEqual([{ from: map.nodes[0]?.id, to: map.nodes[0]?.id }]);
    expect(map.imports).toEqual([
      { path: 'src/walk.ts', module: 'some-package', resolvedPath: null },
    ]);
  });
});

describe('changedLines', () => {
  it('places deletions on the following new line and ignores context', () => {
    const file = diffFile('F1', 'a.ts', 'a\nb\nc', [2], [3]);
    expect(changedLines({ files: [file] }).get('a.ts')).toEqual([
      { line: 2, lineId: 'F1-002' },
      { line: 3, lineId: 'F1-003' },
    ]);
  });
});
