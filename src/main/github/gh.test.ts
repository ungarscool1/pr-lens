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
        return {
          code: 1,
          stdout: '',
          stderr: 'Resource protected by organization SAML enforcement',
        };
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    });

    await expect(createGhClient(exec, toolchain).inbox()).resolves.toEqual({
      viewer: 'me',
      organizations: [{ login: 'acme', name: 'Acme', url: 'https://github.com/acme' }],
      authored: [
        {
          owner: 'acme',
          repo: 'api',
          number: 12,
          title: 'Avoid SAML outage',
          url: 'https://github.com/acme/api/pull/12',
          author: 'sam',
          updatedAt: '2026-10-17T10:00:00Z',
          reviewDecision: null,
          reviewRequestCount: 0,
        },
      ],
      requested: [],
      unavailable: ['requested'],
    });
  });
});

describe('GitHub PR context', () => {
  it('returns submitted reviews, unresolved threads and check status without a write', async () => {
    const exec: Exec = vi.fn(async ({ args }) => {
      if (args.includes('repos/acme/api/contents/.github/CODEOWNERS')) {
        return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
      }
      if (args.includes('repos/acme/api/contents/CODEOWNERS')) {
        return {
          code: 0,
          stdout: 'src/** @acme/platform\ndocs/ @writer\n',
          stderr: '',
        };
      }
      if (!args.includes('graphql')) throw new Error(`Unexpected call: ${args.join(' ')}`);
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewRequests: {
                  nodes: [
                    { requestedReviewer: { __typename: 'User', login: 'taylor' } },
                    {
                      requestedReviewer: {
                        __typename: 'Team',
                        slug: 'platform',
                        organization: { login: 'acme' },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
                reviews: {
                  nodes: [
                    {
                      author: { login: 'morgan' },
                      state: 'APPROVED',
                      submittedAt: '2026-10-17T11:00:00Z',
                      body: 'Looks good',
                      url: 'https://github.com/acme/api/pull/12#pullrequestreview-1',
                    },
                    {
                      author: { login: 'me' },
                      state: 'PENDING',
                      submittedAt: null,
                      body: '',
                      url: null,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/auth.ts',
                      line: 42,
                      comments: {
                        nodes: [
                          {
                            author: { login: 'sam' },
                            body: 'Handle retry',
                            createdAt: '2026-10-17T10:00:00Z',
                            url: 'https://github.com/acme/api/pull/12#discussion_r1',
                          },
                        ],
                      },
                    },
                    {
                      isResolved: true,
                      isOutdated: false,
                      path: 'src/old.ts',
                      line: 2,
                      comments: { nodes: [] },
                    },
                  ],
                  pageInfo: { hasNextPage: true },
                },
                files: {
                  nodes: [{ path: 'src/auth.ts' }, { path: 'docs/guide.md' }],
                  pageInfo: { hasNextPage: false },
                },
                baseRefOid: 'abc123',
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          contexts: {
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                name: 'unit',
                                status: 'COMPLETED',
                                conclusion: 'SUCCESS',
                                detailsUrl: 'https://github.com/acme/api/actions/runs/1',
                              },
                              {
                                __typename: 'StatusContext',
                                context: 'deploy',
                                state: 'PENDING',
                                targetUrl: null,
                              },
                            ],
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      };
    });

    await expect(
      createGhClient(exec, toolchain).prContext({ owner: 'acme', repo: 'api', number: 12 }),
    ).resolves.toEqual({
      requestedReviewers: [
        { kind: 'user', handle: 'taylor' },
        { kind: 'team', handle: 'acme/platform' },
      ],
      ownership: {
        sourcePath: 'CODEOWNERS',
        rules: [
          { pattern: 'src/**', owners: ['@acme/platform'], paths: ['src/auth.ts'] },
          { pattern: 'docs/', owners: ['@writer'], paths: ['docs/guide.md'] },
        ],
        unownedPaths: [],
      },
      reviews: [
        {
          author: 'morgan',
          state: 'APPROVED',
          submittedAt: '2026-10-17T11:00:00Z',
          body: 'Looks good',
          url: 'https://github.com/acme/api/pull/12#pullrequestreview-1',
        },
      ],
      unresolvedThreads: [
        {
          path: 'src/auth.ts',
          line: 42,
          outdated: false,
          author: 'sam',
          body: 'Handle retry',
          createdAt: '2026-10-17T10:00:00Z',
          url: 'https://github.com/acme/api/pull/12#discussion_r1',
        },
      ],
      checks: [
        {
          name: 'unit',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/acme/api/actions/runs/1',
        },
        { name: 'deploy', status: 'PENDING', conclusion: null, detailsUrl: null },
      ],
      truncated: true,
    });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['-F', 'number=12']) }),
    );
    const graphqlCall = vi.mocked(exec).mock.calls[0]?.[0];
    const query = graphqlCall?.args.find((arg) => arg.startsWith('query='));
    expect(query).toContain('baseRefOid');
    expect(query).not.toContain('file(path:');
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([
          '--method',
          'GET',
          'repos/acme/api/contents/CODEOWNERS',
          'ref=abc123',
        ]),
      }),
    );
  });
});
