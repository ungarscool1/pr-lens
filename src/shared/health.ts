export interface BinHealth {
  path: string | null;
  version: string | null;
  /** User-facing reason when something is wrong. */
  problem: string | null;
}

export interface Health {
  gh: BinHealth & { authenticated: boolean; user: string | null; scopes: string[] };
  claude: BinHealth & { loggedIn: boolean; authMethod: string | null };
}
