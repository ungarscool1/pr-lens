import { describe, expect, it, vi } from 'vitest';
import type { Exec } from '../exec/exec';
import type { ToolchainService } from '../exec/toolchain';
import { createGhClient } from './gh';

const toolchain: ToolchainService = {
  get: async () => ({ gh: '/gh', claude: null, git: null, path: '' }),
  reset: () => undefined,
};

const searchItem = {
  number: 12,
  title: 'Avoid SAML outage',
  html_url: 'https://github.com/acme/api/pull/12',
  updated_at: '2026-10-17T10:00:00Z',
  user: { login: 'sam' },
  repository_url: 'https://api.github.com/repos/acme/api',
};

describe('GitHub Inbox', () => {
  it('keeps accessible sources when an organization rejects the OAuth token', async () => {
    const exec: Exec = vi.fn(async ({ args }) => {
      if (args.join(' ') === 'api user --jq .login') return { code: 0, stdout: 'me\n', stderr: '' };
      if (args.includes('user/orgs?per_page=100'))
        return { code: 0, stdout: JSON.stringify([{ login: 'acme', name: 'Acme' }]), stderr: '' };
      if (args.includes('search/issues') && args.includes('q=is:pr is:open author:@me'))
        return { code: 0, stdout: JSON.stringify({ items: [searchItem] }), stderr: '' };
      if (args.includes('search/issues'))
        return { code: 1, stdout: '', stderr: 'Resource protected by organization SAML enforcement' };
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    });

    await expect(createGhClient(exec, toolchain).inbox()).resolves.toEqual({
      viewer: 'me',
      organizations: [{ login: 'acme', name: 'Acme', url: 'https://github.com/acme' }],
      authored: [
        {
          owner: 'acme', repo: 'api', number: 12, title: 'Avoid SAML outage',
          url: 'https://github.com/acme/api/pull/12', author: 'sam', updatedAt: '2026-10-17T10:00:00Z',
          reviewDecision: null, reviewRequestCount: 0,
        },
      ],
      requested: [],
      unavailable: ['requested'],
    });
  });
});
