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

export interface SourceText {
  path: string;
  text: string;
}

export interface ImpactInput {
  sources: SourceText[];
  diff: DiffModel;
  skippedFiles: number;
}

interface ImportBinding {
  path: string | null;
  symbol: string | null;
  namespace: boolean;
}

interface ParsedImport extends ImpactImport {
  bindings: Map<string, ImportBinding>;
}

interface FunctionInfo extends ImpactNode {
  className: string | null;
  body: ts.ConciseBody | undefined;
  source: ts.SourceFile;
  imports: Map<string, ImportBinding>;
}

interface ParsedFile {
  path: string;
  test: boolean;
  functions: FunctionInfo[];
  imports: ParsedImport[];
}

const SOURCE_FILE = /\.(?:cts|mts|ts|tsx)$/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.(?:cts|mts|ts|tsx)$/i;

export const isImpactSource = (path: string): boolean =>
  SOURCE_FILE.test(path) && !/\.d\.ts$/i.test(path);

const isTestPath = (path: string): boolean => TEST_FILE.test(path);

const functionId = (path: string, name: string, line: number): string => `${path}:${line}:${name}`;

const classNameOf = (node: ts.Node): string | null => {
  let current = node.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name)
      return current.name.text;
    current = current.parent;
  }
  return null;
};

const propertyName = (name: ts.PropertyName | undefined): string | null => {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return null;
};

const functionName = (node: ts.FunctionLikeDeclarationBase): string | null => {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const name = propertyName(node.name);
    if (!name) return null;
    const className = classNameOf(node);
    return className ? `${className}.${name}` : name;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return null;
};

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

const isNestedFunction = (node: ts.Node): node is FunctionLike =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node);

const resolveRelativeImport = (
  path: string,
  module: string,
  known: ReadonlySet<string>,
): string | null => {
  if (!module.startsWith('.')) return null;
  const stem = posix.normalize(posix.join(posix.dirname(path), module));
  const candidates = [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
    `${stem}/index.mts`,
    `${stem}/index.cts`,
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
};

const importsOf = (
  source: ts.SourceFile,
  path: string,
  known: ReadonlySet<string>,
): ParsedImport[] => {
  const imports: ParsedImport[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    const resolvedPath = resolveRelativeImport(path, module, known);
    const bindings = new Map<string, ImportBinding>();
    const clause = statement.importClause;
    if (clause?.name)
      bindings.set(clause.name.text, { path: resolvedPath, symbol: 'default', namespace: false });
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) {
        bindings.set(item.name.text, {
          path: resolvedPath,
          symbol: item.propertyName?.text ?? item.name.text,
          namespace: false,
        });
      }
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, {
        path: resolvedPath,
        symbol: null,
        namespace: true,
      });
    }
    imports.push({ path, module, resolvedPath, bindings });
  }
  return imports;
};

const functionsOf = (
  source: ts.SourceFile,
  path: string,
  test: boolean,
  imports: ParsedImport[],
): FunctionInfo[] => {
  const functions: FunctionInfo[] = [];
  const bindings = new Map<string, ImportBinding>();
  for (const imp of imports)
    for (const [name, binding] of imp.bindings) bindings.set(name, binding);

  const visit = (node: ts.Node): void => {
    if (isNestedFunction(node)) {
      const name = functionName(node);
      if (name) {
        const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        functions.push({
          id: functionId(path, name, startLine),
          name,
          path,
          startLine,
          endLine,
          changed: false,
          test,
          className: classNameOf(node),
          body: node.body,
          source,
          imports: bindings,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
};

const changedRanges = (diff: DiffModel): Map<string, Set<number>> => {
  const lines = new Map<string, Set<number>>();
  for (const file of diff.files) {
    if (!isImpactSource(file.path) || file.binary) continue;
    const changed = new Set<number>();
    for (const hunk of file.hunks) {
      // Context lines deliberately count: a pure deletion still identifies the enclosing
      // surviving function, while the actual change remains visible in the diff.
      for (const line of hunk.lines) if (line.new !== undefined) changed.add(line.new);
    }
    if (changed.size) lines.set(file.path, changed);
  }
  return lines;
};

const hasChangedLine = (fn: FunctionInfo, changes: Map<string, Set<number>>): boolean => {
  const lines = changes.get(fn.path);
  if (!lines) return false;
  for (const line of lines) if (line >= fn.startLine && line <= fn.endLine) return true;
  return false;
};

const targetKey = (path: string, symbol: string): string => `${path}\u0000${symbol}`;

const targetOf = (
  call: ts.CallExpression,
  owner: FunctionInfo,
  byPathName: ReadonlyMap<string, FunctionInfo>,
): FunctionInfo | null => {
  const expression = call.expression;
  let path = owner.path;
  let name: string | null = null;
  if (ts.isIdentifier(expression)) {
    const imported = owner.imports.get(expression.text);
    if (imported?.path && imported.symbol) {
      path = imported.path;
      name = imported.symbol;
    } else {
      name = expression.text;
    }
  } else if (ts.isPropertyAccessExpression(expression)) {
    if (expression.expression.kind === ts.SyntaxKind.ThisKeyword && owner.className) {
      name = `${owner.className}.${expression.name.text}`;
    } else if (ts.isIdentifier(expression.expression)) {
      const imported = owner.imports.get(expression.expression.text);
      if (imported?.path && imported.namespace) {
        path = imported.path;
        name = expression.name.text;
      }
    }
  }
  return name ? (byPathName.get(targetKey(path, name)) ?? null) : null;
};

const callsOf = (
  owner: FunctionInfo,
  byPathName: ReadonlyMap<string, FunctionInfo>,
): FunctionInfo[] => {
  if (!owner.body) return [];
  const calls = new Map<string, FunctionInfo>();
  const visit = (node: ts.Node): void => {
    if (node !== owner.body && isNestedFunction(node)) return;
    if (ts.isCallExpression(node)) {
      const target = targetOf(node, owner, byPathName);
      if (target) calls.set(target.id, target);
    }
    ts.forEachChild(node, visit);
  };
  visit(owner.body);
  return [...calls.values()];
};

/**
 * Builds a bounded, syntax-only map. It resolves local and relative-import calls without type
 * checking, so dynamic dispatch and path aliases are intentionally left out rather than guessed.
 */
export function analyzeImpact(input: ImpactInput): ImpactMap {
  const sources = input.sources.filter((source) => isImpactSource(source.path));
  const knownPaths = new Set(sources.map((source) => source.path));
  const parsed = sources.map((file) => {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const imports = importsOf(source, file.path, knownPaths);
    return {
      path: file.path,
      test: isTestPath(file.path),
      imports,
      functions: functionsOf(source, file.path, isTestPath(file.path), imports),
    } satisfies ParsedFile;
  });
  const functions = parsed.flatMap((file) => file.functions);
  const byPathName = new Map<string, FunctionInfo>();
  for (const fn of functions) {
    const key = targetKey(fn.path, fn.name);
    if (!byPathName.has(key)) byPathName.set(key, fn);
  }

  const changes = changedRanges(input.diff);
  for (const fn of functions) fn.changed = hasChangedLine(fn, changes);
  const allEdges: ImpactEdge[] = [];
  for (const fn of functions) {
    for (const target of callsOf(fn, byPathName)) allEdges.push({ from: fn.id, to: target.id });
  }

  const changed = new Set(functions.filter((fn) => fn.changed).map((fn) => fn.id));
  const selected = new Set(changed);
  for (const edge of allEdges) {
    if (changed.has(edge.to)) selected.add(edge.from);
    if (changed.has(edge.from)) selected.add(edge.to);
  }
  const nodes = functions
    .filter((fn) => selected.has(fn.id))
    .map((fn) => ({
      id: fn.id,
      name: fn.name,
      path: fn.path,
      startLine: fn.startLine,
      endLine: fn.endLine,
      changed: fn.changed,
      test: fn.test,
    }))
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        a.path.localeCompare(b.path) ||
        a.startLine - b.startLine,
    );
  const edges = allEdges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));

  const changedPaths = new Set(nodes.filter((node) => node.changed).map((node) => node.path));
  const imports = parsed
    .filter((file) => changedPaths.has(file.path))
    .flatMap((file) =>
      file.imports.map((imp) => ({
        path: imp.path,
        module: imp.module,
        resolvedPath: imp.resolvedPath,
      })),
    )
    .filter(
      (imp, index, all) =>
        all.findIndex((other) => other.path === imp.path && other.module === imp.module) === index,
    );

  const tests: ImpactTest[] = parsed
    .filter((file) => file.test)
    .map((file) => {
      const called = new Set(
        edges
          .filter((edge) => {
            const caller = functions.find((fn) => fn.id === edge.from);
            return caller?.path === file.path && changed.has(edge.to);
          })
          .map((edge) => edge.to),
      );
      return {
        path: file.path,
        relatedNodeIds: [...called],
        importsChangedFile: file.imports.some(
          (imp) => imp.resolvedPath !== null && changedPaths.has(imp.resolvedPath),
        ),
      };
    })
    .filter((test) => test.relatedNodeIds.length > 0 || test.importsChangedFile)
    .map(({ path, relatedNodeIds }) => ({ path, relatedNodeIds }));

  return {
    nodes,
    edges,
    imports,
    tests,
    scannedFiles: sources.length,
    skippedFiles: input.skippedFiles,
  };
}
