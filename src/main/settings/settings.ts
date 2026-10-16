import { readFile, rm, writeFile } from 'node:fs/promises';
import { AppError } from '../../shared/errors';
import { Settings } from '../../shared/settings';
import type { SettingsPatch, SettingsView } from '../../shared/settings';
import type { JsonStore } from '../store/json-store';

/** The subset of Electron's safeStorage we use, so tests can fake it. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SettingsService {
  current(): Settings;
  view(): Promise<SettingsView>;
  update(patch: SettingsPatch): Promise<SettingsView>;
  setOAuthToken(token: string | null): Promise<SettingsView>;
  /** Decrypted only at the moment a claude child is spawned. Never logged, never sent to the renderer. */
  oauthToken(): Promise<string | null>;
}

const FILE = 'settings.json';

export async function createSettings(
  store: JsonStore,
  cipher: SecretCipher,
  tokenPath: string,
): Promise<SettingsService> {
  let settings = await store.read(FILE, Settings, Settings.parse({}));

  const readToken = async (): Promise<string | null> => {
    try {
      return cipher.decryptString(await readFile(tokenPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AppError(
        'SECRET_STORE_UNAVAILABLE',
        'The stored Claude token could not be decrypted.',
        {
          cause: err,
        },
      );
    }
  };
  const view = async (): Promise<SettingsView> => ({
    ...settings,
    hasOAuthToken: (await readToken().catch(() => null)) !== null,
  });

  return {
    current: () => settings,
    view,
    async update(patch) {
      settings = Settings.parse({ ...settings, ...patch });
      await store.write(FILE, settings);
      return view();
    },
    async setOAuthToken(token) {
      if (token === null) {
        await rm(tokenPath, { force: true });
        return view();
      }
      if (!cipher.isEncryptionAvailable()) throw new AppError('SECRET_STORE_UNAVAILABLE');
      await writeFile(tokenPath, cipher.encryptString(token), { mode: 0o600 });
      return view();
    },
    oauthToken: readToken,
  };
}
