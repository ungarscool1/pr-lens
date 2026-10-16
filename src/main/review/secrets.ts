// `keep`: groups 1 and 2 (the key and closing quote) stay, so the redacted code still reads.
const PATTERNS: readonly { kind: string; re: RegExp; keep?: true }[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'stripe-key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'assigned-secret',
    re: /(\b(?:api[_-]?key|secret|token|passwd|password|client[_-]?secret)\b["']?\s*[:=]\s*["'])(?!\[REDACTED)[^"'\s]{12,}(["'])/gi,
    keep: true,
  },
];

export interface Redaction {
  text: string;
  kinds: string[];
}

/**
 * Masks likely secrets before text leaves the machine. Heuristic: it catches the common
 * formats, not every secret. Callers surface the findings so the user sees what was masked.
 */
export function redactSecrets(text: string): Redaction {
  const kinds: string[] = [];
  let out = text;
  for (const { kind, re, keep } of PATTERNS) {
    out = out.replace(re, (...m: string[]) => {
      kinds.push(kind);
      return keep ? `${m[1]}[REDACTED:${kind}]${m[2]}` : `[REDACTED:${kind}]`;
    });
  }
  return { text: out, kinds };
}
