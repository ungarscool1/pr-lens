import type { RepoRef } from '../../../shared/subject';

/** The few mdast fields this plugin reads or writes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Code and existing links keep their text as written. */
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'definition', 'html']);
// `#123` or `@login`, not inside a word, path or email address.
const REF = /(^|[^\w/@.-])(#(\d+)|@([A-Za-z\d](?:[A-Za-z\d-]{0,38})))(?![\w-])/g;

const split = (text: string, repo: RepoRef): MdNode[] => {
  const out: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(REF)) {
    const [, lead = '', ref = '', issue, login] = match;
    const start = (match.index ?? 0) + lead.length;
    if (start > last) out.push({ type: 'text', value: text.slice(last, start) });
    out.push({
      type: 'link',
      url: issue
        ? `https://github.com/${repo.owner}/${repo.repo}/issues/${issue}`
        : `https://github.com/${login}`,
      children: [{ type: 'text', value: ref }],
    });
    last = start + ref.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
};

/**
 * A remark plugin that links `#123` to the repository's issue or pull request (GitHub redirects
 * between the two) and `@login` to the profile, as GitHub renders them.
 */
export function remarkGithubRefs(repo: RepoRef) {
  const walk = (node: MdNode): void => {
    if (!node.children || SKIP.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return split(child.value, repo);
      walk(child);
      return [child];
    });
  };
  return () => walk;
}

/**
 * Whether skipped raw HTML held text the reader would otherwise miss: a `<details>` summary, or
 * everything after a `<script>` that is never closed. Comments and bare tags alone hide nothing.
 */
export function hidesText(tree: MdNode): boolean {
  if (tree.type === 'html') {
    const text = (tree.value ?? '')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<\/?[A-Za-z][^>]*>/g, '');
    return text.trim() !== '';
  }
  return (tree.children ?? []).some(hidesText);
}

/**
 * Where a link in a description goes: absolute http(s) as is, a relative path into the repository
 * at the reviewed commit, and anything else (in-page anchors, other schemes) nowhere.
 */
export function resolveHref(href: string | undefined, base: string): string | null {
  if (!href || href.startsWith('#')) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
