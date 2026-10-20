import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import type { DiffModel } from '../../shared/diff';
import type { ImpactEdge, ImpactMap, ImpactNode } from '../../shared/impact';
import type { SourceText } from './analysis';
import {
  changedLines,
  isGitHubActionsPath,
  isWorkflowPath,
  MAX_CHANGED_FUNCTIONS,
} from './changes';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface Reference {
  uses: string;
  kind: 'workflow' | 'action';
}

const stepsOf = (steps: unknown): Reference[] =>
  Array.isArray(steps)
    ? steps.flatMap((step: unknown) => {
        const uses = record(step).uses;
        return typeof uses === 'string' ? [{ uses, kind: 'action' as const }] : [];
      })
    : [];

function references(config: Record<string, unknown>, workflow: boolean): Reference[] {
  if (workflow)
    return Object.values(record(config.jobs)).flatMap((value) => {
      const job = record(value);
      const calls: Reference[] =
        typeof job.uses === 'string' ? [{ uses: job.uses, kind: 'workflow' }] : [];
      return [...calls, ...stepsOf(job.steps)];
    });
  const runs = record(config.runs);
  return runs.using === 'composite' ? stepsOf(runs.steps) : [];
}

/** Local `uses` paths are rooted at the repository, including inside composite actions. */
function resolve(ref: Reference, nodes: Map<string, ImpactNode>): string | null {
  if (!ref.uses.startsWith('./') || ref.uses.includes('${{')) return null;
  if (ref.uses.split('/').includes('..')) return null;
  const path = posix.normalize(ref.uses).replace(/\/$/, '');
  const candidates =
    ref.kind === 'workflow'
      ? [path]
      : [posix.join(path, 'action.yml'), posix.join(path, 'action.yaml')];
  return candidates.find((candidate) => nodes.get(candidate)?.kind === ref.kind) ?? null;
}

/**
 * File-level calls between workflows, reusable workflows and repository-local actions.
 * Reads YAML as data only; never evaluates expressions, shells, actions or workflow code.
 */
export function analyzeGitHubActions(input: {
  sources: SourceText[];
  diff: DiffModel;
  skippedFiles: number;
}): ImpactMap {
  const changes = changedLines(input.diff, isGitHubActionsPath);
  const nodes = new Map<string, ImpactNode>();
  const calls = new Map<string, Reference[]>();
  let skippedFiles = input.skippedFiles;
  for (const { path, text } of input.sources) {
    if (!isGitHubActionsPath(path)) continue;
    let config: Record<string, unknown>;
    try {
      const doc = parseDocument(text);
      if (doc.errors.length) throw new Error('Invalid YAML');
      config = record(doc.toJS({ maxAliasCount: 100 }) as unknown);
    } catch {
      skippedFiles++;
      continue;
    }
    const workflow = isWorkflowPath(path);
    const anchorLineId = changes.get(path)?.[0]?.lineId ?? null;
    nodes.set(path, {
      id: `${path}#0`,
      name:
        typeof config.name === 'string' && config.name.trim()
          ? config.name
          : workflow
            ? posix.basename(path)
            : posix.basename(posix.dirname(path)) === '.'
              ? 'action'
              : posix.basename(posix.dirname(path)),
      kind: workflow ? 'workflow' : 'action',
      container: null,
      path,
      startLine: 1,
      endLine: text.split('\n').length,
      changed: anchorLineId !== null,
      test: false,
      anchorLineId,
    });
    calls.set(path, references(config, workflow));
  }

  const changed = [...nodes.values()]
    .filter((node) => node.changed)
    .sort((a, b) => a.path.localeCompare(b.path));
  const seeds = new Set(changed.slice(0, MAX_CHANGED_FUNCTIONS).map((node) => node.path));
  const omitted = new Set(changed.slice(MAX_CHANGED_FUNCTIONS).map((node) => node.path));
  const included = new Set(seeds);
  const edges = new Map<string, ImpactEdge>();
  for (const [path, refs] of calls) {
    for (const ref of refs) {
      const target = resolve(ref, nodes);
      if (!target || omitted.has(path) || omitted.has(target)) continue;
      if (!seeds.has(path) && !seeds.has(target)) continue;
      included.add(path);
      included.add(target);
      const edge = { from: `${path}#0`, to: `${target}#0` };
      edges.set(`${edge.from}\u0000${edge.to}`, edge);
    }
  }
  return {
    nodes: [...nodes.values()]
      .filter((node) => included.has(node.path))
      .sort((a, b) => Number(b.changed) - Number(a.changed) || a.path.localeCompare(b.path)),
    edges: [...edges.values()],
    imports: [],
    tests: [],
    scannedFiles: nodes.size,
    skippedFiles,
    omittedChanged: omitted.size,
    languages: [],
  };
}
