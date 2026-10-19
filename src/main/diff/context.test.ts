import { describe, expect, it, vi } from 'vitest';
import type { DiffFile } from '../../shared/diff';
import type { GitService } from '../git/git';
import type { LoadedTarget, ReviewService } from '../review/service';
import { createContextService, splitLines } from './context';

const HEAD = 'c'.repeat(40);
const KEY = `o/r#1@${HEAD}`;
const file = (fid: string, path: string, over: Partial<DiffFile> = {}): DiffFile => ({
  fid,
  path,
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 0,
  noise: null,
  hunks: [{ header: '@@ -1 +1 @@', lines: [{ id: `${fid}-001`, kind: 'add', new: 1, text: 'x' }] }],
  ...over,
});

const setup = (read: { path: string; text: string }[]) => {
  const filesAt = vi.fn(async () => read);
  const loaded = {
    target: {
      key: KEY,
      headSha: HEAD,
      subject: { kind: 'pr', ref: { owner: 'o', repo: 'r', number: 1 } },
    },
    diff: { files: [file('F1', 'src/a.ts'), file('F2', 'src/new.ts', { status: 'added' })] },
  } as unknown as LoadedTarget;
  const review = { loaded: (k: string) => (k === KEY ? loaded : undefined) } as ReviewService;
  return {
    filesAt,
    context: createContextService({ git: { filesAt } as unknown as GitService, review }),
  };
};

describe('diff context', () => {
  it('splits lines like the diff numbers them', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('reads a diff file at the head SHA by its ID', async () => {
    const { filesAt, context } = setup([{ path: 'src/a.ts', text: 'one\ntwo\n' }]);
    await expect(context.fileLines(KEY, 'F1')).resolves.toEqual(['one', 'two']);
    expect(filesAt).toHaveBeenCalledWith({ owner: 'o', repo: 'r' }, HEAD, ['src/a.ts']);
  });

  it('refuses unknown targets, unknown files and files with nothing hidden', async () => {
    const { filesAt, context } = setup([]);
    await expect(context.fileLines(`o/r#2@${HEAD}`, 'F1')).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    await expect(context.fileLines(KEY, 'F9')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(context.fileLines(KEY, 'F2')).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(filesAt).not.toHaveBeenCalled();
    await expect(context.fileLines(KEY, 'F1')).rejects.toThrow(/too large or not text/);
  });
});
