import { describe, expect, it } from 'vitest';
import { resolveCodeowners } from './codeowners';

describe('resolveCodeowners', () => {
  it('uses the final matching rule and groups changed paths by effective owner', () => {
    expect(
      resolveCodeowners(
        '*.ts @typescript\nsrc/** @platform\nsrc/secret.ts @security\ndocs/ @docs\n',
        ['src/main.ts', 'src/secret.ts', 'test.ts', 'docs/guide.md', 'README.md'],
        '.github/CODEOWNERS',
      ),
    ).toEqual({
      sourcePath: '.github/CODEOWNERS',
      rules: [
        { pattern: 'src/**', owners: ['@platform'], paths: ['src/main.ts'] },
        { pattern: 'src/secret.ts', owners: ['@security'], paths: ['src/secret.ts'] },
        { pattern: '*.ts', owners: ['@typescript'], paths: ['test.ts'] },
        { pattern: 'docs/', owners: ['@docs'], paths: ['docs/guide.md'] },
      ],
      unownedPaths: ['README.md'],
    });
  });

  it('does not claim ownership if the base branch has no CODEOWNERS file', () => {
    expect(resolveCodeowners(null, ['src/main.ts'], null)).toEqual({
      sourcePath: null,
      rules: [],
      unownedPaths: ['src/main.ts'],
    });
  });
});
