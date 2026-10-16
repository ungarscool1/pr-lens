import { z } from 'zod';

export const DEFAULT_NOISE_GLOBS = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/uv.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/go.sum',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.generated.*',
  '**/*.pb.go',
];

const AbsPath = z
  .string()
  .max(1000)
  .refine((p) => p.startsWith('/'), 'Must be an absolute path');

export const Settings = z.object({
  ghPath: AbsPath.nullable().default(null),
  claudePath: AbsPath.nullable().default(null),
  noiseGlobs: z.array(z.string().min(1).max(200)).max(100).default(DEFAULT_NOISE_GLOBS),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:[\]-]{1,80}$/)
    .nullable()
    .default(null),
  /** Open-PR auto-run only when the estimate is under this many input tokens. 0 = never. */
  autoRunMaxTokens: z.number().int().min(0).max(1_000_000).default(60_000),
  maxNotes: z.number().int().min(1).max(10).default(8),
  reviewTimeoutSec: z.number().int().min(30).max(3600).default(600),
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = Settings.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** What the renderer sees: never the token itself. */
export type SettingsView = Settings & { hasOAuthToken: boolean };

export const OAuthTokenInput = z.object({ token: z.string().trim().min(20).max(500).nullable() });
