import picomatch from 'picomatch';
import type { GitHubOwnership, GitHubOwnershipRule } from '../../shared/github-context';

interface Rule {
  pattern: string;
  owners: string[];
  matches(path: string): boolean;
}

/**
 * Resolves the subset of CODEOWNERS syntax accepted by GitHub. Unsupported negated rules are
 * ignored (GitHub itself does not support them); the final matching rule wins.
 */
export function resolveCodeowners(
  text: string | null,
  changedPaths: readonly string[],
  sourcePath: string | null,
): GitHubOwnership {
  if (!text || !sourcePath) return { sourcePath: null, rules: [], unownedPaths: [...changedPaths] };

  const rules = parseRules(text);
  const grouped = new Map<string, GitHubOwnershipRule>();
  const unownedPaths: string[] = [];
  for (const path of changedPaths) {
    let owner: Rule | undefined;
    for (const rule of rules) if (rule.matches(path)) owner = rule;
    if (!owner) {
      unownedPaths.push(path);
      continue;
    }
    const key = `${owner.pattern}\u0000${owner.owners.join('\u0000')}`;
    const group = grouped.get(key) ?? { pattern: owner.pattern, owners: owner.owners, paths: [] };
    group.paths.push(path);
    grouped.set(key, group);
  }
  return { sourcePath, rules: [...grouped.values()], unownedPaths };
}

function parseRules(text: string): Rule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const [pattern, ...owners] = trimmed.split(/\s+/);
    // GitHub CODEOWNERS does not support `!` pattern negation or character ranges.
    if (!pattern || pattern.startsWith('!') || pattern.includes('[') || !owners.length) return [];
    try {
      return [{ pattern, owners, matches: codeownersMatcher(pattern) }];
    } catch {
      // A malformed rule is skipped just as an unsupported pattern should not hide all ownership.
      return [];
    }
  });
}

function codeownersMatcher(pattern: string): (path: string) => boolean {
  let glob = pattern.replace(/^\//, '');
  if (glob.endsWith('/')) glob += '**';
  // A pattern without a slash applies at every directory level in CODEOWNERS.
  return picomatch(glob, { dot: true, matchBase: !glob.includes('/') });
}
