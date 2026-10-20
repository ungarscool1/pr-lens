import { z } from 'zod';

/**
 * A call graph around changed functions, workflows and internal actions, built locally from
 * language call hierarchies and GitHub Actions `uses` references. No model is involved.
 */
export const ImpactNode = z.object({
  /** `<path>#<declaration offset>`; whole-file workflow/action nodes use offset 0. */
  id: z.string(),
  name: z.string(),
  /** `function`, `method`, `class`, `module` (top-level code), `workflow`, `action`… */
  kind: z.string(),
  /** Enclosing class or namespace, when the language service names one. */
  container: z.string().nullable(),
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  changed: z.boolean(),
  test: z.boolean(),
  /** Changed nodes only: the first added or deleted diff line inside the declaration/file. */
  anchorLineId: z.string().nullable(),
});
export type ImpactNode = z.infer<typeof ImpactNode>;

export const ImpactEdge = z.object({
  /** The caller. */
  from: z.string(),
  /** The function being called, JSX component rendered, or local workflow/action used. */
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

export const ImpactLanguage = z.object({
  /** `typescript`, `github-actions`, or an LSP language id. */
  language: z.string(),
  label: z.string(),
  /** `off`: changed files in this language, but no language server is set up for it. */
  status: z.enum(['mapped', 'failed', 'off']),
  detail: z.string().nullable(),
});
export type ImpactLanguage = z.infer<typeof ImpactLanguage>;

export const ImpactMap = z.object({
  /** Changed declarations/files and their direct callers and callees. */
  nodes: z.array(ImpactNode),
  edges: z.array(ImpactEdge),
  /** Imports made by files that contain a changed function. */
  imports: z.array(ImpactImport),
  /** Test files that import or directly call changed code. */
  tests: z.array(ImpactTest),
  scannedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  /** Changed declarations/files left out of the graph to keep it bounded. */
  omittedChanged: z.number().int().nonnegative(),
  /** One entry per language with changed source files. */
  languages: z.array(ImpactLanguage),
});
export type ImpactMap = z.infer<typeof ImpactMap>;
