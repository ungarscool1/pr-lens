import { describe, expect, it } from 'vitest';
import { analyzeImpact } from './analysis';

describe('analyzeImpact', () => {
  it('maps changed functions to local callers, callees, imports and tests', () => {
    const map = analyzeImpact({
      sources: [
        {
          path: 'src/math.ts',
          text: "import { format } from './format';\n\nexport function changed(input: string) {\n  return format(input);\n}\n",
        },
        {
          path: 'src/format.ts',
          text: 'export function format(input: string) { return input.trim(); }\n',
        },
        {
          path: 'src/client.ts',
          text: "import { changed } from './math';\n\nexport function caller() {\n  return changed(' value ');\n}\n",
        },
        {
          path: 'src/math.test.ts',
          text: "import { changed } from './math';\n\nexport function exercisesChanged() {\n  return changed('value');\n}\n",
        },
      ],
      diff: {
        files: [
          {
            fid: 'F1',
            path: 'src/math.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 1,
            noise: null,
            hunks: [
              {
                header: '@@ -1,4 +1,4 @@',
                lines: [
                  {
                    id: 'F1-001',
                    kind: 'ctx',
                    old: 1,
                    new: 1,
                    text: "import { format } from './format';",
                  },
                  {
                    id: 'F1-002',
                    kind: 'add',
                    new: 3,
                    text: 'export function changed(input: string) {',
                  },
                  { id: 'F1-003', kind: 'ctx', old: 3, new: 4, text: '  return format(input);' },
                ],
              },
            ],
          },
        ],
      },
      skippedFiles: 0,
    });

    const changed = map.nodes.find((node) => node.name === 'changed');
    const caller = map.nodes.find((node) => node.name === 'caller');
    const format = map.nodes.find((node) => node.name === 'format');
    const test = map.nodes.find((node) => node.name === 'exercisesChanged');
    expect(changed?.changed).toBe(true);
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: caller?.id, to: changed?.id },
        { from: changed?.id, to: format?.id },
        { from: test?.id, to: changed?.id },
      ]),
    );
    expect(map.imports).toEqual(
      expect.arrayContaining([
        { path: 'src/math.ts', module: './format', resolvedPath: 'src/format.ts' },
      ]),
    );
    expect(map.tests).toEqual([{ path: 'src/math.test.ts', relatedNodeIds: [changed?.id] }]);
  });
});
