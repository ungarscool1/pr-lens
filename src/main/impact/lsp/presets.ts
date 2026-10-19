import type { LspLanguage } from '../../../shared/lsp';

export interface ServerPreset {
  args: string[];
  /**
   * Fixed environment on top of the base allow-list. Values here close the ways a checked-out
   * PR could make the user's own tools run or download code while the server loads it.
   */
  env: Record<string, string>;
  initializationOptions?: unknown;
  /** Replies to `workspace/configuration`, by section; anything else gets null (defaults). */
  configuration: Record<string, unknown>;
  languageId: (path: string) => string;
}

/**
 * Only languages whose server can load an untrusted checkout without running its code. Rust is
 * left out on purpose: rust-analyzer's `cargo metadata` honours a repository's
 * `.cargo/config.toml` (`rustc-wrapper`), and build scripts and proc macros are PR code.
 */
export const SERVER_PRESETS: Record<LspLanguage, ServerPreset> = {
  go: {
    args: [],
    env: {
      // A `toolchain` line in go.mod must not download and run another Go toolchain.
      GOTOOLCHAIN: 'local',
      // Modules missing from the user's cache or vendor/ stay missing; calls into them are not
      // drawn anyway.
      GOPROXY: 'off',
      // cgo would hand the PR's #cgo flags to the C compiler.
      CGO_ENABLED: '0',
    },
    configuration: {},
    languageId: () => 'go',
  },
  python: {
    args: ['--stdio'],
    env: {},
    configuration: {
      'python.analysis': { diagnosticMode: 'openFilesOnly', autoSearchPaths: true },
    },
    languageId: () => 'python',
  },
};
