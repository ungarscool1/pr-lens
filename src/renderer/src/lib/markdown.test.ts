import { describe, expect, it } from 'vitest';
import { remarkGithubRefs, resolveHref } from './markdown';

const repo = { owner: 'acme', repo: 'api' };
const paragraph = (value: string) => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
});

describe('remarkGithubRefs', () => {
  it('links issue numbers and mentions, but not emails, paths or headings anchors', () => {
    const tree = paragraph('Fixes #12 for @octo-cat, not a@b.com, src/#3 or C#5.');
    remarkGithubRefs(repo)()(tree);
    expect(tree.children[0]?.children).toEqual([
      { type: 'text', value: 'Fixes ' },
      {
        type: 'link',
        url: 'https://github.com/acme/api/issues/12',
        children: [{ type: 'text', value: '#12' }],
      },
      { type: 'text', value: ' for ' },
      {
        type: 'link',
        url: 'https://github.com/octo-cat',
        children: [{ type: 'text', value: '@octo-cat' }],
      },
      { type: 'text', value: ', not a@b.com, src/#3 or C#5.' },
    ]);
  });

  it('leaves code and existing links alone', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'inlineCode', value: '#1' },
        { type: 'link', url: 'https://x', children: [{ type: 'text', value: '#2' }] },
      ],
    };
    const before = JSON.stringify(tree);
    remarkGithubRefs(repo)()(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('resolveHref', () => {
  const base = 'https://github.com/acme/api/blob/abc123/';
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['docs/setup.md', 'https://github.com/acme/api/blob/abc123/docs/setup.md'],
    ['#usage', null],
    ['javascript:alert(1)', null],
    ['mailto:a@b.com', null],
    [undefined, null],
  ])('%s → %s', (href, expected) => expect(resolveHref(href, base)).toBe(expected));
});
