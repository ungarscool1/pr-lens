const ALLOWED_HOSTS = new Set([
  'github.com',
  'cli.github.com',
  'docs.github.com',
  'docs.anthropic.com',
  'code.claude.com',
]);

/** Only plain https links to a short list of hosts may leave the app. */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    ALLOWED_HOSTS.has(url.hostname)
  );
}
