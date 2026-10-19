import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isAllowedExternalUrl } from '../../../../shared/external';
import type { RepoRef } from '../../../../shared/subject';
import { openExternal } from '../../lib/api';
import { hidesText, remarkGithubRefs, resolveHref } from '../../lib/markdown';

/**
 * Opens allow-listed links (GitHub and a few docs hosts) in the browser, the same rule as the
 * rest of the app; any other link copies its address instead of leaving the app.
 */
function LinkOut({ href, children }: { href: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const opens = isAllowedExternalUrl(href);
  return (
    <a
      href={href}
      className={opens ? undefined : 'md-copy-link'}
      title={opens ? href : `Copy link: ${href}`}
      onClick={(event) => {
        event.preventDefault();
        if (opens) return openExternal(href);
        void navigator.clipboard.writeText(href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {children}
      {copied && <span className="md-copied"> (link copied)</span>}
    </a>
  );
}

/**
 * GitHub-flavored markdown from an untrusted PR or issue body. It renders to React elements,
 * never to HTML: raw HTML in the source is dropped (PR templates' `<!-- -->` hints included),
 * images become links because remote images are blocked by the CSP, and headings start at h3
 * so the page keeps one h1. When skipped HTML held text (an unclosed `<script>` hides the rest
 * of the document), a notice offers the original plain text, so nothing can be hidden from the
 * reviewer.
 */
export function Markdown({ text, repo, base }: { text: string; repo: RepoRef; base: string }) {
  const [raw, setRaw] = useState(false);
  const [hidden, setHidden] = useState(false);
  // Set by the plugin while the markdown renders, read once that render is committed.
  const found = useRef(false);
  const plugins = useMemo(
    () => [
      remarkGfm,
      remarkGithubRefs({ owner: repo.owner, repo: repo.repo }),
      () => (tree: Parameters<typeof hidesText>[0]) => {
        found.current = hidesText(tree);
      },
    ],
    [repo.owner, repo.repo],
  );
  useEffect(() => {
    if (!raw) setHidden(found.current);
  }, [text, raw]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const url = resolveHref(href, base);
        return url ? <LinkOut href={url}>{children}</LinkOut> : <span>{children}</span>;
      },
      img: ({ src, alt }) => {
        const url = typeof src === 'string' ? resolveHref(src, base) : null;
        const label = `Image${alt ? `: ${alt}` : ''}`;
        return url ? <LinkOut href={url}>{label}</LinkOut> : <span>{label}</span>;
      },
      h1: ({ children }) => <h3>{children}</h3>,
      h2: ({ children }) => <h4>{children}</h4>,
      h3: ({ children }) => <h5>{children}</h5>,
      h4: ({ children }) => <h6>{children}</h6>,
      h5: ({ children }) => <h6>{children}</h6>,
      h6: ({ children }) => <h6>{children}</h6>,
    }),
    [base],
  );
  return (
    <>
      {hidden && (
        <p className="md-hidden-note" role="note">
          {raw
            ? 'Showing the original text.'
            : 'Some HTML in this text is not shown, and text inside it is hidden.'}{' '}
          <button className="link" onClick={() => setRaw(!raw)}>
            {raw ? 'Show formatted' : 'Show raw text'}
          </button>
        </p>
      )}
      {raw ? (
        <p className="desc-text">{text}</p>
      ) : (
        <div className="markdown">
          <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>
            {text}
          </ReactMarkdown>
        </div>
      )}
    </>
  );
}
