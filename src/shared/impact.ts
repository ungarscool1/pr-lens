/** A local, syntax-level view of how changed TypeScript symbols connect to the repository. */
export interface ImpactNode {
  id: string;
  name: string;
  path: string;
  startLine: number;
  endLine: number;
  changed: boolean;
  test: boolean;
}

export interface ImpactEdge {
  /** The function containing the call. */
  from: string;
  /** The function being called. */
  to: string;
}

export interface ImpactImport {
  path: string;
  module: string;
  /** Present for a repository-local relative import. */
  resolvedPath: string | null;
}

export interface ImpactTest {
  path: string;
  /** Changed functions directly called by the test, when statically resolvable. */
  relatedNodeIds: string[];
}

export interface ImpactMap {
  /** Changed functions and their direct callers and callees. */
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  /** Imports made by files that contain a changed function. */
  imports: ImpactImport[];
  /** Test files that import or directly call changed code. */
  tests: ImpactTest[];
  scannedFiles: number;
  skippedFiles: number;
}
