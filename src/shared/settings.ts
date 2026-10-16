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

// Validation and defaults are kept apart: in zod 4 a default inside .partial() still fills in
// missing keys, which would turn every partial update into a reset of the other settings.
const fields = {
  ghPath: AbsPath.nullable(),
  claudePath: AbsPath.nullable(),
  noiseGlobs: z.array(z.string().min(1).max(200)).max(100),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:[\]-]{1,80}$/)
    .nullable(),
  /** Open-PR auto-run only when the estimate is under this many input tokens. 0 = never. */
  autoRunMaxTokens: z.number().int().min(0).max(1_000_000),
  maxNotes: z.number().int().min(1).max(10),
  reviewTimeoutSec: z.number().int().min(30).max(3600),
  /** macOS app that opens Ask Claude sessions (`open -a <app> launch.command`). */
  /** Off by default: lets "Promote to comment" add notes to your pending GitHub review. */
  promoteEnabled: z.boolean(),
  terminalApp: z
    .string()
    .regex(/^(?!-)[A-Za-z0-9 ._-]{1,60}$/, 'An app name like Terminal or iTerm'),
};

export const Settings = z.object({
  ghPath: fields.ghPath.default(null),
  claudePath: fields.claudePath.default(null),
  noiseGlobs: fields.noiseGlobs.default(DEFAULT_NOISE_GLOBS),
  model: fields.model.default(null),
  autoRunMaxTokens: fields.autoRunMaxTokens.default(60_000),
  maxNotes: fields.maxNotes.default(8),
  reviewTimeoutSec: fields.reviewTimeoutSec.default(600),
  terminalApp: fields.terminalApp.default('Terminal'),
  promoteEnabled: fields.promoteEnabled.default(false),
});
export type Settings = z.infer<typeof Settings>;

/** Only the keys it names; nothing else is touched. */
export const SettingsPatch = z.object(fields).partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** What the renderer sees: never the token itself. */
export type SettingsView = Settings & { hasOAuthToken: boolean };

export const OAuthTokenInput = z.object({ token: z.string().trim().min(20).max(500).nullable() });
