import { posix } from 'node:path';
import type { DiffModel } from '../../shared/diff';
import type { ImpactEdge, ImpactMap, ImpactNode } from '../../shared/impact';
import { changedLines, MAX_CHANGED_FUNCTIONS } from './changes';

export interface TerraformSource {
  path: string;
  text: string;
}

export interface TerraformImpactInput {
  sources: TerraformSource[];
  diff: DiffModel;
  skippedFiles: number;
}

type TokenKind = 'word' | 'string' | 'symbol';

interface Token {
  kind: TokenKind;
  value: string;
  raw: string;
  start: number;
  end: number;
  line: number;
}

interface TerraformBlock {
  id: string;
  path: string;
  directory: string;
  kind: string;
  address: string;
  aliases: string[];
  startLine: number;
  endLine: number;
  body: Token[];
}

const BLOCK_LABELS: Record<string, number> = {
  resource: 2,
  data: 2,
  module: 1,
  output: 1,
  variable: 1,
  provider: 1,
  check: 1,
  terraform: 0,
  locals: 0,
};

const referencePattern =
  /\b(?:data\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|(?:module|var|local)\.[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*)\b/g;

/** Terraform files are parsed in memory. JSON configurations need a different parser. */
export const isTerraformSource = (path: string): boolean => /\.tf$/i.test(path);

const lineCount = (text: string): number => (text.match(/\n/g) ?? []).length;

/**
 * A deliberately small HCL lexer. It only needs block boundaries and traversals, but still
 * skips comments, quoted strings and heredocs so braces in user text cannot corrupt the map.
 */
function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  const advance = (end: number): void => {
    line += lineCount(text.slice(index, end));
    index = end;
  };

  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      advance(index + 1);
      continue;
    }
    if (char === '#' || (char === '/' && text[index + 1] === '/')) {
      const end = text.indexOf('\n', index);
      advance(end < 0 ? text.length : end);
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      advance(close < 0 ? text.length : close + 2);
      continue;
    }

    const tokenLine = line;
    if (char === '"') {
      const start = index;
      let value = '';
      index++;
      while (index < text.length) {
        const current = text.charAt(index);
        if (current === '\\' && index + 1 < text.length) {
          value += text.charAt(index + 1);
          index += 2;
          continue;
        }
        if (current === '"') {
          index++;
          break;
        }
        value += current;
        index++;
      }
      const raw = text.slice(start, index);
      line += lineCount(raw);
      tokens.push({ kind: 'string', value, raw, start, end: index, line: tokenLine });
      continue;
    }

    if (text.startsWith('<<', index)) {
      const header = /^<<-?([A-Za-z_][\w-]*)[^\n]*(?:\n|$)/.exec(text.slice(index));
      if (header) {
        const start = index;
        const marker = header[1];
        if (!marker) continue;
        let end = index + header[0].length;
        while (end < text.length) {
          const lineEnd = text.indexOf('\n', end);
          const next = lineEnd < 0 ? text.length : lineEnd + 1;
          if (text.slice(end, lineEnd < 0 ? text.length : lineEnd).trim() === marker) {
            end = next;
            break;
          }
          end = next;
        }
        const raw = text.slice(start, end);
        tokens.push({ kind: 'string', value: raw, raw, start, end, line: tokenLine });
        advance(end);
        continue;
      }
    }

    const word = /^[A-Za-z_][\w-]*/.exec(text.slice(index));
    if (word) {
      const start = index;
      const value = word[0];
      index += value.length;
      tokens.push({ kind: 'word', value, raw: value, start, end: index, line: tokenLine });
      continue;
    }

    tokens.push({ kind: 'symbol', value: char, raw: char, start: index, end: index + 1, line });
    index++;
  }
  return tokens;
}

function addressOf(kind: string, labels: string[]): { address: string; aliases: string[] } {
  if (kind === 'resource') {
    const address = `${labels[0]}.${labels[1]}`;
    return { address, aliases: [address] };
  }
  if (kind === 'data') {
    const address = `data.${labels[0]}.${labels[1]}`;
    return { address, aliases: [address] };
  }
  if (kind === 'module' || kind === 'variable') {
    const prefix = kind === 'variable' ? 'var' : kind;
    const address = `${prefix}.${labels[0]}`;
    return { address, aliases: [address] };
  }
  if (kind === 'output' || kind === 'provider' || kind === 'check') {
    const address = `${kind}.${labels[0]}`;
    return { address, aliases: [address] };
  }
  return { address: kind, aliases: [kind] };
}

function blocksOf(source: TerraformSource): TerraformBlock[] {
  const tokens = tokensOf(source.text);
  const blocks: TerraformBlock[] = [];
  let depth = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.value === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token.value === '{') {
      depth++;
      continue;
    }
    if (depth !== 0 || token.kind !== 'word') continue;
    const labelCount = BLOCK_LABELS[token.value];
    if (labelCount === undefined) continue;
    const labels = tokens.slice(index + 1, index + 1 + labelCount);
    if (labels.length !== labelCount || labels.some((label) => label.kind !== 'string')) continue;
    const openIndex = index + 1 + labelCount;
    if (tokens[openIndex]?.value !== '{') continue;

    let closeIndex = openIndex + 1;
    let blockDepth = 1;
    for (; closeIndex < tokens.length && blockDepth > 0; closeIndex++) {
      if (tokens[closeIndex]?.value === '{') blockDepth++;
      if (tokens[closeIndex]?.value === '}') blockDepth--;
    }
    if (blockDepth !== 0) continue;
    const close = tokens[closeIndex - 1];
    if (!close) continue;
    const { address, aliases } = addressOf(
      token.value,
      labels.map((label) => label.value),
    );
    blocks.push({
      id: `${source.path}#${token.start}`,
      path: source.path,
      directory: posix.dirname(source.path),
      kind: token.value,
      address,
      aliases,
      startLine: token.line,
      endLine: close.line,
      body: tokens.slice(openIndex + 1, closeIndex - 1),
    });
    index = closeIndex - 1;
  }
  return blocks;
}

function referencesOf(tokens: Token[]): Set<string> {
  const references = new Set<string>();
  const addMatches = (value: string): void => {
    for (const match of value.matchAll(referencePattern)) references.add(match[0]);
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === 'string') {
      // A quoted template can still contain a traversal: "${module.api.url}".
      if (token.raw.includes('${')) addMatches(token.raw);
      continue;
    }
    if (token.kind !== 'word' || tokens[index + 1]?.value !== '.') continue;
    const second = tokens[index + 2];
    if (!second || second.kind !== 'word') continue;
    if (token.value === 'data' && tokens[index + 3]?.value === '.') {
      const third = tokens[index + 4];
      if (third?.kind === 'word') references.add(`data.${second.value}.${third.value}`);
    } else if (token.value === 'module' || token.value === 'var' || token.value === 'local') {
      references.add(`${token.value}.${second.value}`);
    } else {
      references.add(`${token.value}.${second.value}`);
    }
  }
  return references;
}

const isTerraformTest = (path: string): boolean =>
  /(?:^|\/)tests?\//i.test(path) || /\.tftest\.hcl$/i.test(path);

/**
 * Builds a block-level dependency graph without running Terraform or reading remote state. A
 * `terraform_remote_state` data source is an ordinary local node: consumers point to that node,
 * while the state behind it deliberately remains outside the repository graph.
 */
export function analyzeTerraformImpact(input: TerraformImpactInput): ImpactMap {
  const blocks = input.sources.flatMap(blocksOf);
  const byAddress = new Map<string, TerraformBlock>();
  for (const block of blocks) {
    for (const alias of block.aliases) byAddress.set(`${block.directory}\0${alias}`, block);
  }

  const allEdges = new Map<string, ImpactEdge>();
  for (const block of blocks) {
    for (const reference of referencesOf(block.body)) {
      const target = byAddress.get(`${block.directory}\0${reference}`);
      if (target && target.id !== block.id)
        allEdges.set(`${block.id}\0${target.id}`, { from: block.id, to: target.id });
    }
  }

  const changes = changedLines(input.diff, isTerraformSource);
  const changed = new Map<string, string>();
  for (const [path, lines] of changes) {
    const candidates = blocks.filter((block) => block.path === path);
    for (const { line, lineId } of lines) {
      const block = candidates.find(
        (candidate) => line >= candidate.startLine && line <= candidate.endLine,
      );
      if (block && !changed.has(block.id)) changed.set(block.id, lineId);
    }
  }

  const keptChanged = new Set([...changed.keys()].slice(0, MAX_CHANGED_FUNCTIONS));
  const included = new Set(keptChanged);
  for (const edge of allEdges.values()) {
    if (keptChanged.has(edge.from)) included.add(edge.to);
    if (keptChanged.has(edge.to)) included.add(edge.from);
  }
  const nodes: ImpactNode[] = blocks
    .filter((block) => included.has(block.id))
    .map((block) => ({
      id: block.id,
      name: block.address,
      kind: block.kind,
      container: null,
      path: block.path,
      startLine: block.startLine,
      endLine: block.endLine,
      changed: keptChanged.has(block.id),
      test: isTerraformTest(block.path),
      anchorLineId: keptChanged.has(block.id) ? (changed.get(block.id) ?? null) : null,
    }))
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    );
  const edges = [...allEdges.values()].filter(
    (edge) => included.has(edge.from) && included.has(edge.to),
  );

  return {
    nodes,
    edges,
    imports: [],
    tests: nodes
      .filter((node) => node.test && !node.changed)
      .map((node) => ({
        path: node.path,
        relatedNodeIds: edges
          .filter((edge) => edge.from === node.id && keptChanged.has(edge.to))
          .map((edge) => edge.to),
      }))
      .filter((test) => test.relatedNodeIds.length > 0),
    scannedFiles: input.sources.length,
    skippedFiles: input.skippedFiles,
    omittedChanged: Math.max(0, changed.size - MAX_CHANGED_FUNCTIONS),
    languages: [],
  };
}
