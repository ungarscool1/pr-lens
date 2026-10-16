import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsPatch } from '../../shared/settings';
import { createJsonStore } from '../store/json-store';
import { createSettings } from './settings';
import type { SecretCipher } from './settings';

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => b.toString().replace(/^enc:/, ''),
};

describe('settings', () => {
  it('a patch only carries the keys it names', () => {
    expect(SettingsPatch.parse({ model: 'opus' })).toEqual({ model: 'opus' });
  });

  it('a partial update keeps every other setting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-settings-'));
    const s = await createSettings(createJsonStore(dir), cipher, join(dir, 'tok.bin'));
    await s.update({ maxNotes: 5, terminalApp: 'iTerm' });
    await s.update(SettingsPatch.parse({ model: 'opus' }));
    expect(s.current()).toMatchObject({ maxNotes: 5, terminalApp: 'iTerm', model: 'opus' });
  });

  it('stores the OAuth token encrypted and only reports that it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pr-lens-settings-'));
    const s = await createSettings(createJsonStore(dir), cipher, join(dir, 'tok.bin'));
    const view = await s.setOAuthToken('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
    expect(view.hasOAuthToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain('abcdefghijklmnop');
    expect(await s.oauthToken()).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz');
    expect((await s.setOAuthToken(null)).hasOAuthToken).toBe(false);
  });

  it('rejects a terminal app name that is not a plain name', () => {
    expect(SettingsPatch.safeParse({ terminalApp: 'Terminal; rm -rf ~' }).success).toBe(false);
    expect(SettingsPatch.safeParse({ terminalApp: '-a' }).success).toBe(false);
    expect(SettingsPatch.safeParse({ terminalApp: 'iTerm' }).success).toBe(true);
  });
});
