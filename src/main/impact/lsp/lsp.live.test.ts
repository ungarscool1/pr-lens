import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffFile } from '../../../shared/diff';
import { spawnStdio } from '../../exec/exec';
import { analyzeWithServer } from './analyze';
import { SERVER_PRESETS } from './presets';

/**
 * Live check against real language servers on a scratch project:
 *   PR_LENS_GOPLS=/path/to/gopls PR_LENS_PYRIGHT=/path/to/pyright-langserver pnpm test lsp.live
 */
const added = (fid: string, path: string, lines: number[]): DiffFile => ({
  fid,
  path,
  status: 'modified',
  binary: false,
  additions: lines.length,
  deletions: 0,
  noise: null,
  hunks: [
    {
      header: '@@',
      lines: lines.map((line, i) => ({
        id: `${fid}-${String(i + 1).padStart(3, '0')}`,
        kind: 'add' as const,
        new: line,
        text: '',
      })),
    },
  ],
});

const project = async (files: Record<string, string>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-lens-lsp-')));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...extra,
});

describe.skipIf(!process.env.PR_LENS_GOPLS)('live gopls', () => {
  it('maps callers and callees of a changed Go function, across packages and through interfaces', async () => {
    const root = await project({
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
      'store/store.go': [
        'package store',
        '',
        'type Loader interface {',
        '\tLoad(key string) string',
        '}',
        '',
        'type Disk struct{}',
        '',
        'func (Disk) Load(key string) string {',
        '\treturn clean(key)',
        '}',
        '',
        'func clean(s string) string { return s }',
        '',
      ].join('\n'),
      'app/app.go': [
        'package app',
        '',
        'import "example.com/demo/store"',
        '',
        'func Run(l store.Loader) string {',
        '\treturn l.Load("k")',
        '}',
        '',
        'func Direct() string { return store.Disk{}.Load("x") }',
        '',
      ].join('\n'),
      'store/store_test.go': [
        'package store',
        '',
        'import "testing"',
        '',
        'func TestLoad(t *testing.T) { _ = Disk{}.Load("t") }',
        '',
      ].join('\n'),
    });
    const map = await analyzeWithServer({
      language: 'go',
      command: process.env.PR_LENS_GOPLS ?? '',
      root,
      env: env(SERVER_PRESETS.go.env),
      diff: { files: [added('F1', 'store/store.go', [10])] },
      scannedFiles: 3,
      spawn: spawnStdio,
    });
    const byName = (name: string) => map.nodes.filter((n) => n.name.endsWith(name));
    const load = map.nodes.find((n) => n.changed);
    expect(load).toMatchObject({ path: 'store/store.go', startLine: 9, anchorLineId: 'F1-001' });
    const callers = map.edges
      .filter((e) => e.to === load?.id)
      .map((e) => map.nodes.find((n) => n.id === e.from)?.name);
    expect(callers).toEqual(expect.arrayContaining(['Run', 'Direct', 'TestLoad']));
    expect(byName('clean')).toHaveLength(1);
    expect(map.tests).toEqual([{ path: 'store/store_test.go', relatedNodeIds: [load?.id] }]);
  }, 180_000);
});

describe.skipIf(!process.env.PR_LENS_PYRIGHT)('live pyright', () => {
  it('maps callers and callees of a changed Python method', async () => {
    const root = await project({
      'pkg/__init__.py': '',
      'pkg/store.py': [
        'def clean(s):',
        '    return s.strip()',
        '',
        '',
        'class Store:',
        '    def load(self, key):',
        '        return clean(key)',
        '',
      ].join('\n'),
      'pkg/app.py': [
        'from pkg.store import Store',
        '',
        '',
        'def run():',
        "    return Store().load('k')",
        '',
      ].join('\n'),
      'tests/test_store.py': [
        'from pkg.store import Store',
        '',
        '',
        'def test_load():',
        "    assert Store().load(' a ') == 'a'",
        '',
      ].join('\n'),
    });
    const map = await analyzeWithServer({
      language: 'python',
      command: process.env.PR_LENS_PYRIGHT ?? '',
      root,
      env: env(SERVER_PRESETS.python.env),
      diff: { files: [added('F1', 'pkg/store.py', [7])] },
      scannedFiles: 4,
      spawn: spawnStdio,
    });
    const load = map.nodes.find((n) => n.changed);
    expect(load).toMatchObject({ name: 'load', path: 'pkg/store.py', startLine: 6 });
    const names = (ids: string[]) => ids.map((id) => map.nodes.find((n) => n.id === id)?.name);
    expect(names(map.edges.filter((e) => e.to === load?.id).map((e) => e.from))).toEqual(
      expect.arrayContaining(['run', 'test_load']),
    );
    expect(names(map.edges.filter((e) => e.from === load?.id).map((e) => e.to))).toEqual(['clean']);
  }, 180_000);
});
