import { describe, expect, it } from 'vitest';
import type { DiffFile } from '../../shared/diff';
import { ImpactMap } from '../../shared/impact';
import type { SourceText } from './analysis';
import { isGitHubActionsPath, MAX_CHANGED_FUNCTIONS } from './changes';
import { analyzeGitHubActions } from './github-actions';

const file = (path: string, line = 1): DiffFile => ({
  fid: 'F1',
  path,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 0,
  noise: null,
  hunks: [{ header: '@@', lines: [{ id: 'F1-001', kind: 'add', new: line, text: 'x' }] }],
});
const analyze = (sources: SourceText[], files: DiffFile[]) =>
  analyzeGitHubActions({ sources, diff: { files }, skippedFiles: 0 });
const edge = (from: string, to: string) => ({ from: `${from}#0`, to: `${to}#0` });

const workflow: SourceText = {
  path: '.github/workflows/ci.yml',
  text: `name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: './.github/actions/build'
      - uses: ./.github/actions/build
  reuse:
    uses: ./.github/workflows/reusable.yaml
`,
};
const composite: SourceText = {
  path: '.github/actions/build/action.yaml',
  text: `name: Build
runs:
  using: composite
  steps:
    - uses: ./tools/setup
    - uses: owner/repo/action@v1
`,
};
const setup: SourceText = {
  path: 'tools/setup/action.yml',
  text: 'name: Setup\nruns: { using: node24, main: index.js }\n',
};
const reusable: SourceText = {
  path: '.github/workflows/reusable.yaml',
  text: 'on: workflow_call\njobs: {}\n',
};

describe('GitHub Actions impact', () => {
  it('maps a changed workflow to local actions and reusable workflows, deduplicating calls', () => {
    const map = analyze([workflow, composite, setup, reusable], [file(workflow.path, 8)]);
    expect(ImpactMap.safeParse(map).success).toBe(true);
    expect(map.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CI',
          kind: 'workflow',
          path: workflow.path,
          startLine: 1,
          changed: true,
          anchorLineId: 'F1-001',
        }),
        expect.objectContaining({ name: 'Build', kind: 'action', changed: false }),
        expect.objectContaining({ name: 'reusable.yaml', kind: 'workflow', changed: false }),
      ]),
    );
    expect(map.nodes).toHaveLength(3); // Direct neighbours only.
    expect(map.edges).toEqual([
      edge(workflow.path, composite.path),
      edge(workflow.path, reusable.path),
    ]);
    expect(map.scannedFiles).toBe(4);
    expect(map.skippedFiles).toBe(0);
  });

  it('finds callers of changed composite actions and resolves nested uses from the repo root', () => {
    const map = analyze([workflow, composite, setup, reusable], [file(composite.path, 6)]);
    expect(map.nodes.map((node) => node.path)).toEqual([composite.path, workflow.path, setup.path]);
    expect(map.edges).toEqual([
      edge(workflow.path, composite.path),
      edge(composite.path, setup.path),
    ]);
  });

  it('finds callers of changed reusable workflows and represents standalone actions', () => {
    expect(analyze([workflow, reusable], [file(reusable.path)]).edges).toEqual([
      edge(workflow.path, reusable.path),
    ]);
    const map = analyze([setup], [file(setup.path)]);
    expect(map.nodes[0]).toMatchObject({ name: 'Setup', kind: 'action', changed: true });
    expect(map.edges).toEqual([]);
  });

  it('parses flow syntax, multiline scalars and YAML aliases without matching shell text', () => {
    const source = {
      path: '.github/workflows/aliases.yaml',
      text: `name: >-
  Build and test
jobs:
  build:
    steps:
      - &setup { uses: ./tools/setup }
      - *setup
      - run: |
          echo 'uses: ./.github/actions/build'
        env: { uses: ./.github/actions/build }
`,
    };
    const map = analyze([source, setup, composite], [file(source.path)]);
    expect(map.nodes[0]?.name).toBe('Build and test');
    expect(map.edges).toEqual([edge(source.path, setup.path)]);
  });

  it('ignores remote, dynamic, missing, traversal and wrong-kind targets', () => {
    const source = {
      path: '.github/workflows/invalid-refs.yml',
      text: `jobs:
  build:
    steps:
      - uses: owner/repo/tools/setup@main
      - uses: docker://alpine:3
      - uses: ./missing
      - uses: ./tools/../tools/setup
      - uses: ./tools/\u0024{{ inputs.action }}
      - uses: ./.github/workflows/reusable.yaml
  reuse:
    uses: ./tools/setup
`,
    };
    const map = analyze([source, setup, reusable], [file(source.path)]);
    expect(map.edges).toEqual([]);
    expect(map.nodes.map((node) => node.path)).toEqual([source.path]);
  });

  it('counts invalid YAML as skipped without losing valid files', () => {
    const bad = { path: '.github/workflows/bad.yml', text: 'jobs: [\n' };
    const map = analyzeGitHubActions({
      sources: [bad, setup],
      diff: { files: [file(bad.path), file(setup.path)] },
      skippedFiles: 2,
    });
    expect(map.nodes.map((node) => node.path)).toEqual([setup.path]);
    expect(map.scannedFiles).toBe(1);
    expect(map.skippedFiles).toBe(3);
  });

  it('bounds YAML alias expansion', () => {
    const bomb = {
      path: '.github/workflows/bomb.yml',
      text: [
        'a: &a [x, x, x, x, x, x, x, x, x, x]',
        'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
        'c: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      ].join('\n'),
    };
    expect(analyze([bomb], [file(bomb.path)])).toMatchObject({ nodes: [], skippedFiles: 1 });
  });

  it('anchors pure deletions and ignores context, binary and deleted files', () => {
    const deleted = file(setup.path);
    deleted.hunks[0]!.lines = [
      { id: 'F1-001', kind: 'del', old: 1, text: '# removed' },
      { id: 'F1-002', kind: 'ctx', old: 2, new: 1, text: 'name: Setup' },
    ];
    expect(analyze([setup], [deleted]).nodes[0]?.anchorLineId).toBe('F1-001');
    deleted.hunks[0]!.lines.shift();
    expect(analyze([setup], [deleted]).nodes).toEqual([]);
    expect(analyze([setup], [{ ...file(setup.path), binary: true }]).nodes).toEqual([]);
    expect(analyze([setup], [{ ...file(setup.path), status: 'deleted' }]).nodes).toEqual([]);
  });

  it('bounds changed definitions and keeps cycles finite', () => {
    const sources = Array.from({ length: MAX_CHANGED_FUNCTIONS + 2 }, (_, i) => ({
      path: `actions/${i}/action.yml`,
      text: `runs: { using: composite, steps: [{ uses: ./actions/${i} }] }`,
    }));
    const map = analyze(
      sources,
      sources.map((source) => file(source.path)),
    );
    expect(map.nodes).toHaveLength(MAX_CHANGED_FUNCTIONS);
    expect(map.edges).toHaveLength(MAX_CHANGED_FUNCTIONS);
    expect(map.omittedChanged).toBe(2);
  });
});

describe('GitHub Actions file detection', () => {
  it('accepts workflow definitions and root or nested action metadata only', () => {
    for (const path of [workflow.path, reusable.path, setup.path, 'action.yaml'])
      expect(isGitHubActionsPath(path), path).toBe(true);
    for (const path of [
      '.github/workflows/nested/ci.yml',
      '.github/actions/build/config.yml',
      'docs/workflow.yml',
      'action.yml.bak',
    ])
      expect(isGitHubActionsPath(path), path).toBe(false);
  });
});
