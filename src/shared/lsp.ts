import { z } from 'zod';

/**
 * Languages whose impact map comes from a language server the user installed and named in
 * Settings. PR Lens never ships, installs or searches for one. Each has a vetted launch recipe
 * in `src/main/impact/lsp/presets.ts`; an arbitrary command line is deliberately not offered.
 */
export const LspLanguage = z.enum(['go', 'python']);
export type LspLanguage = z.infer<typeof LspLanguage>;

export interface LspLanguageInfo {
  label: string;
  /** The server binary the path should point to. */
  server: string;
  example: string;
  extensions: RegExp;
  tests: RegExp;
}

export const LSP_LANGUAGES: Record<LspLanguage, LspLanguageInfo> = {
  go: {
    label: 'Go',
    server: 'gopls',
    example: '/Users/you/go/bin/gopls',
    extensions: /\.go$/,
    tests: /_test\.go$/,
  },
  python: {
    label: 'Python',
    server: 'pyright-langserver or basedpyright-langserver',
    example: '/opt/homebrew/bin/pyright-langserver',
    extensions: /\.pyi?$/,
    tests: /(?:^|\/)tests?\/|(?:^|\/)test_[^/]*\.py$|_test\.py$|(?:^|\/)conftest\.py$/,
  },
};

export const lspLanguageOf = (path: string): LspLanguage | null =>
  LspLanguage.options.find((language) => LSP_LANGUAGES[language].extensions.test(path)) ?? null;
