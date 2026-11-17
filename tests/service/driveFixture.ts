import { join } from 'node:path';
import type { Db } from '../../src/main/db';
import type { OAuthLike } from '../../src/main/drive/auth';
import type { DriveClient, DriveFolderLookup } from '../../src/main/drive/driveClient';
import type { createClipRepo } from '../../src/service/clipRepo';
import { ServiceDriveAuth } from '../../src/service/driveAuth';
import { createDriveSettings } from '../../src/service/driveSettings';
import { DriveSync } from '../../src/service/driveSync';
import type { DriveDeps } from '../../src/service/http';

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;

export class FakeOAuth implements OAuthLike {
  generateAuthUrl(o: Record<string, unknown>) {
    return `https://accounts.example/auth?${new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString()}`;
  }
  async getToken(_o: { code: string }) {
    return { tokens: { access_token: 'at-SECRET', refresh_token: 'rt-SECRET', id_token: idToken('user@example.com') } };
  }
  setCredentials() {}
  on() {}
  async revokeToken() {}
  request = async () => ({ data: {}, headers: {} });
}

export type FakeFolders = Record<string, { name: string; path: string; canAddChildren: boolean }>;

/** Real settings, auth and sync over fakes of Google: an OAuth client that always grants and a Drive with `folders`. */
export function driveFixture(db: Db, clips: ReturnType<typeof createClipRepo>, dir: string, folders: FakeFolders = {}) {
  const settings = createDriveSettings(db);
  const auth = new ServiceDriveAuth({ settings, tokenFile: join(dir, 'drive-token.json'), createClient: () => new FakeOAuth() });
  const uploads: string[] = [];
  const state = { failWith: null as unknown };
  const client: DriveClient & DriveFolderLookup = {
    ensureFolder: async () => { throw new Error('not used'); },
    uploadFile: async (a) => {
      if (state.failWith) throw state.failWith;
      uploads.push(a.name);
      return { id: `id-${a.name}`, version: '1', md5: '' };
    },
    getFolder: async (id) => {
      if (state.failWith) throw state.failWith;
      return folders[id] ? { id, ...folders[id]! } : null;
    },
    findFolders: async (name) => Object.entries(folders).filter(([, f]) => f.name === name).map(([id, f]) => ({ id, name: f.name, path: f.path })),
  };
  const getClient = async () => ((await auth.status()).connected ? client : null);
  const sync = new DriveSync({ clips, settings, getClient, onAuthLost: () => auth.invalidate() });
  const deps: DriveDeps = { settings, auth, sync, client: getClient };
  return { deps, settings, auth, sync, uploads, state };
}
