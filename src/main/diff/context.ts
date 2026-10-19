import { AppError } from '../../shared/errors';
import { canExpand } from '../../shared/diff';
import { repoOf } from '../../shared/subject';
import type { GitService } from '../git/git';
import type { ReviewService } from '../review/service';

export interface ContextService {
  /** Every line of one diff file at the head SHA, for expanding the unchanged lines around its hunks. */
  fileLines(targetKey: string, fid: string): Promise<string[]>;
}

/** Splits file text into lines the way the diff numbers them: no empty line after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function createContextService({
  git,
  review,
}: {
  git: GitService;
  review: ReviewService;
}): ContextService {
  return {
    async fileLines(targetKey, fid) {
      const loaded = review.loaded(targetKey);
      if (!loaded) throw new AppError('BAD_INPUT', 'Open it again before expanding the diff.');
      // Only a file of this diff, never a path the renderer names.
      const file = loaded.diff.files.find((f) => f.fid === fid);
      if (!file || !canExpand(file))
        throw new AppError('BAD_INPUT', 'This file has no hidden lines to show.');
      const { subject, headSha } = loaded.target;
      const [read] = await git.filesAt(repoOf(subject), headSha, [file.path]);
      if (!read)
        throw new AppError('BAD_INPUT', 'This file is too large or not text, so it cannot expand.');
      return splitLines(read.text);
    },
  };
}
