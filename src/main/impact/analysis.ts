import { posix } from 'node:path';
import ts from 'typescript';
import type { DiffModel } from '../../shared/diff';
import type {
  ImpactEdge,
  ImpactImport,
  ImpactMap,
  ImpactNode,
  ImpactTest,
} from '../../shared/impact';
import { changedLines, isImpactSource, isTestPath, MAX_CHANGED_FUNCTIONS } from './changes';

export interface SourceText {
  path: string;
  text: string;
}

export interface ImpactInput {
  sources: SourceText[];
  diff: DiffModel;
  skippedFiles: number;
  /** Root `tsconfig*.json` / `jsconfig.json` texts by path, for `paths` and `baseUrl`. */
  configs: SourceText[];
}

const ROOT = '/repo/';

/** Only module resolution settings are taken from the repository's config; nothing else. */
function compilerOptions(configs: SourceText[]): ts.CompilerOptions {
  const options: ts.CompilerOptions = {
    noLib: true,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.Latest,
    noEmit: true,
    types: [],
  };
  const byPath = new Map(configs.map((config) => [config.path, config.text]));
  const chain: Record<string, unknown>[] = [];
  let path: string | null = byPath.has('tsconfig.json') ? 'tsconfig.json' : 'jsconfig.json';
  for (let hops = 0; path && hops < 4; hops++) {
    const text = byPath.get(path);
    if (text === undefined) break;
    const parsed = ts.parseConfigFileTextToJson(path, text).config as unknown;
    if (!parsed || typeof parsed !== 'object') break;
    const config = parsed as { extends?: unknown; compilerOptions?: unknown };
    if (config.compilerOptions && typeof config.compilerOptions === 'object')
      chain.unshift(config.compilerOptions as Record<string, unknown>);
    path =
      typeof config.extends === 'string' && config.extends.startsWith('.')
        ? posix.normalize(
            config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`,
          )
        : null;
  }
  for (const co of chain) {
    if (typeof co.baseUrl === 'string') options.baseUrl = posix.join(ROOT, co.baseUrl);
    if (co.paths && typeof co.paths === 'object') {
      const paths: ts.MapLike<string[]> = {};
      for (const [key, value] of Object.entries(co.paths as Record<string, unknown>)) {
        if (Array.isArray(value))
          paths[key] = value.filter((v): v is string => typeof v === 'string');
      }
      options.paths = paths;
    }
  }
  return options;
}

type Callable =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ClassDeclaration;

/**
 * Where the language service should be asked about a declaration: its name, if it has one.
 * Constructors are not listed: the call hierarchy reports them as their class.
 */
function namePosition(node: ts.Node, source: ts.SourceFile): number | null {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (
      (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)
    )
      return parent.name.getStart(source);
    return node.name ? node.name.getStart(source) : null;
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node)
  )
    return node.name ? node.name.getStart(source) : null;
  return null;
}

interface Declaration {
  node: Callable;
  namePos: number;
  startLine: number;
  endLine: number;
}

function declarationsOf(source: ts.SourceFile): Declaration[] {
  const found: Declaration[] = [];
  const line = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node)
    ) {
      const namePos = namePosition(node, source);
      if (namePos !== null) {
        // A `const f = () => …` declaration starts at the variable, so its first line counts.
        const outer =
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          ts.isVariableDeclaration(node.parent)
            ? node.parent.parent
            : node;
        found.push({
          node,
          namePos,
          startLine: line(outer.getStart(source)),
          endLine: line(node.getEnd()),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const relPath = (file: string): string => file.slice(ROOT.length);
const nodeId = (path: string, offset: number): string => `${path}#${offset}`;

/**
 * Builds the graph with the TypeScript language service's call hierarchy, over an in-memory
 * snapshot of the head commit: the same analysis an editor's "Show call hierarchy" runs, so
 * imports through `paths`, re-exports, interface methods and JSX usage resolve without a
 * checkout, type libraries or `node_modules`. What cannot be resolved that way is left out.
 */
export function analyzeImpact(input: ImpactInput): ImpactMap {
  const files = new Map(
    input.sources
      .filter((source) => isImpactSource(source.path))
      .map((source) => [ROOT + source.path, source.text]),
  );
  const directories = new Set<string>();
  for (const file of files.keys()) {
    for (let dir = posix.dirname(file); dir.length >= ROOT.length - 1; dir = posix.dirname(dir)) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
  }
  const options = compilerOptions(input.configs);
  const fileExists = (file: string): boolean => files.has(file);
  const readFile = (file: string): string | undefined => files.get(file);
  const directoryExists = (dir: string): boolean => directories.has(dir.replace(/\/$/, ''));
  const getCurrentDirectory = (): string => ROOT.slice(0, -1);
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists,
    readFile,
    directoryExists,
    getCurrentDirectory,
  };
  const service = ts.createLanguageService(
    {
      fileExists,
      readFile,
      directoryExists,
      getCompilationSettings: () => options,
      getScriptFileNames: () => [...files.keys()],
      getScriptVersion: () => '0',
      getScriptSnapshot: (file) => {
        const text = files.get(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory,
      getDefaultLibFileName: () => '/lib.d.ts',
      getDirectories: () => [],
    },
    ts.createDocumentRegistry(),
  );
  const program = service.getProgram();
  if (!program) throw new Error('The TypeScript language service did not start.');

  // Each changed line belongs to the innermost named declaration around it.
  const changes = changedLines(input.diff);
  const changed: { file: string; decl: Declaration; anchorLineId: string }[] = [];
  for (const [path, lines] of changes) {
    const source = program.getSourceFile(ROOT + path);
    if (!source) continue;
    const declarations = declarationsOf(source);
    const anchors = new Map<Declaration, string>();
    for (const { line, lineId } of lines) {
      let inner: Declaration | null = null;
      for (const decl of declarations) {
        if (line < decl.startLine || line > decl.endLine) continue;
        if (!inner || decl.endLine - decl.startLine < inner.endLine - inner.startLine) inner = decl;
      }
      if (inner && !anchors.has(inner)) anchors.set(inner, lineId);
    }
    for (const [decl, anchorLineId] of anchors)
      changed.push({ file: ROOT + path, decl, anchorLineId });
  }
  changed.sort((a, b) => a.file.localeCompare(b.file) || a.decl.startLine - b.decl.startLine);
  const changedAnchors = new Map(
    changed.map(({ file, decl, anchorLineId }) => [
      nodeId(relPath(file), decl.namePos),
      anchorLineId,
    ]),
  );

  const nodes = new Map<string, ImpactNode>();
  const edges = new Map<string, ImpactEdge>();
  const addItem = (item: ts.CallHierarchyItem): string | null => {
    const source = program.getSourceFile(item.file);
    if (!source || !files.has(item.file)) return null;
    const path = relPath(item.file);
    const id = nodeId(path, item.selectionSpan.start);
    if (!nodes.has(id)) {
      const module =
        item.kind === ts.ScriptElementKind.moduleElement ||
        item.kind === ts.ScriptElementKind.scriptElement;
      const line = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
      const anchorLineId = changedAnchors.get(id) ?? null;
      nodes.set(id, {
        id,
        name: module ? posix.basename(path) : item.name,
        kind: module ? 'module' : item.kind,
        container: item.containerName || null,
        path,
        startLine: line(item.span.start),
        endLine: line(item.span.start + item.span.length),
        changed: anchorLineId !== null,
        test: isTestPath(path),
        anchorLineId,
      });
    }
    return id;
  };
  const addEdge = (from: string | null, to: string | null): void => {
    if (from && to) edges.set(`${from}\u0000${to}`, { from, to });
  };

  for (const { file, decl, anchorLineId } of changed.slice(0, MAX_CHANGED_FUNCTIONS)) {
    try {
      const prepared = service.prepareCallHierarchy(file, decl.namePos);
      const item = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!item) continue;
      const self = addItem(item);
      const node = self ? nodes.get(self) : undefined;
      if (self && node && !node.changed) {
        // The service may name a declaration by another span (an object property's key).
        changedAnchors.set(self, anchorLineId);
        Object.assign(node, { changed: true, anchorLineId });
      }
      for (const call of service.provideCallHierarchyIncomingCalls(file, decl.namePos))
        addEdge(addItem(call.from), self);
      for (const call of service.provideCallHierarchyOutgoingCalls(file, decl.namePos))
        addEdge(self, addItem(call.to));
    } catch (err) {
      // One declaration the language service cannot handle must not lose the whole map.
      console.warn('[impact] call hierarchy failed:', err instanceof Error ? err.name : 'unknown');
    }
  }

  const resolved = new Map<string, string | null>();
  const resolve = (module: string, fromFile: string): string | null => {
    const key = `${fromFile}\u0000${module}`;
    if (!resolved.has(key)) {
      const target = ts.resolveModuleName(module, fromFile, options, moduleHost).resolvedModule;
      resolved.set(
        key,
        target && files.has(target.resolvedFileName) ? relPath(target.resolvedFileName) : null,
      );
    }
    return resolved.get(key) ?? null;
  };
  const importsOf = (file: string): ImpactImport[] => {
    const source = program.getSourceFile(file);
    if (!source) return [];
    return source.statements.flatMap((statement) =>
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? [
            {
              path: relPath(file),
              module: statement.moduleSpecifier.text,
              resolvedPath: resolve(statement.moduleSpecifier.text, file),
            },
          ]
        : [],
    );
  };

  const nodeList = [...nodes.values()].sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine,
  );
  const changedPaths = new Set(nodeList.filter((node) => node.changed).map((node) => node.path));
  const imports = [...changedPaths]
    .flatMap((path) => importsOf(ROOT + path))
    .filter(
      (imp, index, all) =>
        all.findIndex((other) => other.path === imp.path && other.module === imp.module) === index,
    );

  const edgeList = [...edges.values()];
  const tests: ImpactTest[] = [...files.keys()]
    .map(relPath)
    .filter(isTestPath)
    .sort()
    .flatMap((path) => {
      const relatedNodeIds = [
        ...new Set(
          edgeList
            .filter((edge) => nodes.get(edge.from)?.path === path && nodes.get(edge.to)?.changed)
            .map((edge) => edge.to),
        ),
      ];
      const importsChanged = importsOf(ROOT + path).some(
        (imp) => imp.resolvedPath !== null && changedPaths.has(imp.resolvedPath),
      );
      return relatedNodeIds.length || importsChanged ? [{ path, relatedNodeIds }] : [];
    });

  return {
    nodes: nodeList,
    edges: edgeList,
    imports,
    tests,
    scannedFiles: files.size,
    skippedFiles: input.skippedFiles,
    omittedChanged: Math.max(0, changed.length - MAX_CHANGED_FUNCTIONS),
    languages: [],
  };
}
