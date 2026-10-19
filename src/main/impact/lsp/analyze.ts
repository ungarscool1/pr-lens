import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DiffModel } from '../../../shared/diff';
import type { ImpactEdge, ImpactMap, ImpactNode, ImpactTest } from '../../../shared/impact';
import { LSP_LANGUAGES } from '../../../shared/lsp';
import type { LspLanguage } from '../../../shared/lsp';
import type { SpawnStdio } from '../../exec/exec';
import { changedLines, MAX_CHANGED_FUNCTIONS } from '../changes';
import { SERVER_PRESETS } from './presets';
import { createRpc } from './rpc';

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}
interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
interface SymbolInformation {
  name: string;
  kind: number;
  location: { uri: string; range: Range };
}
interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: Range;
  selectionRange: Range;
}

/** LSP SymbolKind values, for labels. */
const KINDS: Record<number, string> = {
  2: 'module',
  5: 'class',
  6: 'method',
  9: 'constructor',
  11: 'interface',
  12: 'function',
  23: 'struct',
};
const CALLABLE = new Set([5, 6, 9, 12, 23]);

export interface LspRun {
  language: LspLanguage;
  /** The server binary the user set in Settings. */
  command: string;
  /** A checkout of the head commit (real path, no trailing slash). */
  root: string;
  env: NodeJS.ProcessEnv;
  diff: DiffModel;
  scannedFiles: number;
  spawn: SpawnStdio;
  timeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks a language server for the call hierarchy of every changed function, as an editor would:
 * `documentSymbol` finds the innermost function or method around each added or deleted line,
 * then `prepareCallHierarchy` and incoming/outgoing calls give its callers and callees. Items
 * outside the checkout (standard library, dependencies) are not drawn.
 */
export async function analyzeWithServer(run: LspRun): Promise<ImpactMap> {
  const info = LSP_LANGUAGES[run.language];
  const preset = SERVER_PRESETS[run.language];
  const changes = changedLines(run.diff, (path) => info.extensions.test(path));
  const empty: ImpactMap = {
    nodes: [],
    edges: [],
    imports: [],
    tests: [],
    scannedFiles: run.scannedFiles,
    skippedFiles: 0,
    omittedChanged: 0,
    languages: [],
  };
  if (!changes.size) return empty;

  const rootUri = pathToFileURL(run.root).href;
  const uriOf = (path: string): string => pathToFileURL(join(run.root, path)).href;
  const pathOf = (uri: string): string | null => {
    if (!uri.startsWith('file:')) return null;
    const rel = relative(run.root, fileURLToPath(uri));
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), run.timeoutMs ?? 180_000);
  const child = run.spawn({
    file: run.command,
    args: preset.args,
    cwd: run.root,
    env: run.env,
    signal: abort.signal,
  });
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new Error(
          err.code === 'ENOENT' || err.code === 'EACCES'
            ? `Could not run ${info.server} at ${run.command}.`
            : abort.signal.aborted
              ? `${info.server} took too long and was stopped.`
              : `${info.server} failed to start.`,
        ),
      ),
    );
  });
  failed.catch(() => undefined);
  child.stderr.resume(); // servers log here; it must be drained, not shown
  const rpc = createRpc(child.stdout, child.stdin);
  child.stdin.on('error', () => undefined);

  const progress = new Set<string | number>();
  let lastProgress = Date.now();
  rpc.onNotification((method, params) => {
    if (method !== '$/progress') return;
    const { token, value } = params as { token: string | number; value?: { kind?: string } };
    if (value?.kind === 'begin') progress.add(token);
    if (value?.kind === 'end') progress.delete(token);
    lastProgress = Date.now();
  });
  rpc.onRequest((method, params) => {
    if (method === 'workspace/configuration') {
      const { items } = params as { items: { section?: string }[] };
      return items.map((item) =>
        item.section ? (preset.configuration[item.section] ?? null) : null,
      );
    }
    if (method === 'workspace/workspaceFolders') return [{ uri: rootUri, name: 'repo' }];
    // window/workDoneProgress/create, client/registerCapability and the rest: acknowledge.
    return null;
  });

  const session = async (): Promise<ImpactMap> => {
    await rpc.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'PR Lens' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'repo' }],
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: { dynamicRegistration: false },
          },
        },
        initializationOptions: preset.initializationOptions,
      },
      120_000,
    );
    rpc.notify('initialized', {});

    const texts = new Map<string, string>();
    for (const path of changes.keys()) {
      const abs = join(run.root, path);
      if (pathOf(pathToFileURL(abs).href) !== path) continue;
      const stat = await lstat(abs).catch(() => null);
      if (!stat?.isFile()) continue;
      const text = await readFile(abs, 'utf8');
      texts.set(path, text);
      rpc.notify('textDocument/didOpen', {
        textDocument: { uri: uriOf(path), languageId: preset.languageId(path), version: 1, text },
      });
    }
    // Let the server finish loading or indexing; its requests are answered either way.
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(100)) {
      if (!progress.size && Date.now() - lastProgress >= 500) break;
    }

    const changed: { path: string; position: Position; startLine: number; anchorLineId: string }[] =
      [];
    for (const [path, lines] of changes) {
      if (!texts.has(path)) continue;
      const symbols = await rpc
        .request<(DocumentSymbol | SymbolInformation)[] | null>('textDocument/documentSymbol', {
          textDocument: { uri: uriOf(path) },
        })
        .catch(() => null);
      const flat: { kind: number; range: Range; selection: Position }[] = [];
      const walk = (list: (DocumentSymbol | SymbolInformation)[]): void => {
        for (const symbol of list) {
          if ('location' in symbol) {
            flat.push({
              kind: symbol.kind,
              range: symbol.location.range,
              selection: symbol.location.range.start,
            });
          } else {
            flat.push({
              kind: symbol.kind,
              range: symbol.range,
              selection: symbol.selectionRange.start,
            });
            walk(symbol.children ?? []);
          }
        }
      };
      walk(symbols ?? []);
      const callables = flat.filter((symbol) => CALLABLE.has(symbol.kind));
      const anchors = new Map<(typeof callables)[number], string>();
      for (const { line, lineId } of lines) {
        const at = line - 1;
        let inner: (typeof callables)[number] | null = null;
        for (const symbol of callables) {
          if (at < symbol.range.start.line || at > symbol.range.end.line) continue;
          const size = symbol.range.end.line - symbol.range.start.line;
          if (!inner || size < inner.range.end.line - inner.range.start.line) inner = symbol;
        }
        if (inner && !anchors.has(inner)) anchors.set(inner, lineId);
      }
      for (const [symbol, anchorLineId] of anchors)
        changed.push({
          path,
          position: symbol.selection,
          startLine: symbol.range.start.line,
          anchorLineId,
        });
    }
    changed.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

    const idOf = (path: string, at: Position): string => `${path}#${at.line}:${at.character}`;
    const changedAnchors = new Map(changed.map((c) => [idOf(c.path, c.position), c.anchorLineId]));
    const nodes = new Map<string, ImpactNode>();
    const edges = new Map<string, ImpactEdge>();
    const addItem = (item: CallHierarchyItem): string | null => {
      const path = pathOf(item.uri);
      if (!path) return null;
      const id = idOf(path, item.selectionRange.start);
      if (!nodes.has(id)) {
        const anchorLineId = changedAnchors.get(id) ?? null;
        nodes.set(id, {
          id,
          name: item.name,
          kind: KINDS[item.kind] ?? 'symbol',
          container: null,
          path,
          startLine: item.range.start.line + 1,
          endLine: item.range.end.line + 1,
          changed: anchorLineId !== null,
          test: info.tests.test(path),
          anchorLineId,
        });
      }
      return id;
    };
    const addEdge = (from: string | null, to: string | null): void => {
      if (from && to) edges.set(`${from}\u0000${to}`, { from, to });
    };

    for (const { path, position, anchorLineId } of changed.slice(0, MAX_CHANGED_FUNCTIONS)) {
      const prepared = await rpc
        .request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', {
          textDocument: { uri: uriOf(path) },
          position,
        })
        .catch(() => null);
      const item = prepared?.[0];
      if (!item) continue;
      const self = addItem(item);
      const node = self ? nodes.get(self) : undefined;
      if (self && node && !node.changed) {
        changedAnchors.set(self, anchorLineId);
        Object.assign(node, { changed: true, anchorLineId });
      }
      const incoming = await rpc
        .request<{ from: CallHierarchyItem }[] | null>('callHierarchy/incomingCalls', { item })
        .catch(() => null);
      for (const call of incoming ?? []) addEdge(addItem(call.from), self);
      const outgoing = await rpc
        .request<{ to: CallHierarchyItem }[] | null>('callHierarchy/outgoingCalls', { item })
        .catch(() => null);
      for (const call of outgoing ?? []) addEdge(self, addItem(call.to));
    }

    await rpc.request('shutdown', null, 5_000).catch(() => undefined);
    rpc.notify('exit', null);

    const nodeList = [...nodes.values()].sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    );
    const edgeList = [...edges.values()];
    const tests: ImpactTest[] = [
      ...new Set(nodeList.filter((node) => node.test).map((node) => node.path)),
    ]
      .sort()
      .map((path) => ({
        path,
        relatedNodeIds: [
          ...new Set(
            edgeList
              .filter((e) => nodes.get(e.from)?.path === path && nodes.get(e.to)?.changed)
              .map((e) => e.to),
          ),
        ],
      }))
      .filter((test) => test.relatedNodeIds.length);
    return {
      ...empty,
      nodes: nodeList,
      edges: edgeList,
      tests,
      omittedChanged: Math.max(0, changed.length - MAX_CHANGED_FUNCTIONS),
    };
  };

  try {
    return await Promise.race([session(), failed]);
  } catch (err) {
    if (abort.signal.aborted)
      throw new Error(`${info.server} took too long and was stopped.`, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
    rpc.close('done');
    // Give the server a moment to exit on its own after `exit`, then make sure it is gone.
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  }
}
