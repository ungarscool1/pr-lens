import { z } from 'zod';

/**
 * A function-level call graph around the changed code, built locally by the TypeScript language
 * service (the call hierarchy an editor's LSP shows). No model is involved.
 */
export const ImpactNode = z.object({
  /** `<path>#<offset of the declaration name>`: unique and stable for one head SHA. */
  id: z.string(),
  name: z.string(),
  /** The language service's kind: `function`, `method`, `class`, `module` (top-level code)… */
  kind: z.string(),
  /** Enclosing class or namespace, when the language service names one. */
  container: z.string().nullable(),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  changed: z.boolean(),
  test: z.boolean(),
  /** Changed nodes only: the first added or deleted diff line inside the declaration. */
  anchorLineId: z.string().nullable(),
});
export type ImpactNode = z.infer<typeof ImpactNode>;

export const ImpactEdge = z.object({
  /** The caller. */
  from: z.string(),
  /** The function being called (or rendered, for a JSX element). */
  to: z.string(),
});
export type ImpactEdge = z.infer<typeof ImpactEdge>;

export const ImpactImport = z.object({
  path: z.string(),
  module: z.string(),
  /** Present when the specifier resolves to a file in the repository (relative or `paths`). */
  resolvedPath: z.string().nullable(),
});
export type ImpactImport = z.infer<typeof ImpactImport>;

export const ImpactTest = z.object({
  path: z.string(),
  /** Changed functions called from the test file. */
  relatedNodeIds: z.array(z.string()),
});
export type ImpactTest = z.infer<typeof ImpactTest>;

export const ImpactMap = z.object({
  /** Changed functions and their direct callers and callees. */
  nodes: z.array(ImpactNode),
  edges: z.array(ImpactEdge),
  /** Imports made by files that contain a changed function. */
  imports: z.array(ImpactImport),
  /** Test files that import or directly call changed code. */
  tests: z.array(ImpactTest),
  scannedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  /** Changed functions left out of the graph to keep it bounded. */
  omittedChanged: z.number().int().nonnegative(),
});
export type ImpactMap = z.infer<typeof ImpactMap>;
