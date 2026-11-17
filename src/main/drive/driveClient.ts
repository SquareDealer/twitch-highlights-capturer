import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export interface DriveClient {
  /** Finds a folder by name under `parentId` (null = My Drive root) or creates it. */
  ensureFolder(name: string, parentId: string | null): Promise<string>;
  uploadFile(a: { localPath: string; name: string; parentId: string; mimeType: string; existingFileId?: string }): Promise<{ id: string; version: string; md5: string }>;
}

/** Looking up folders the app did not create (needs the full `drive` scope). */
export interface DriveFolderLookup {
  /** A folder the account can see, with its path from the top; null when it does not exist or is not a folder. */
  getFolder(id: string): Promise<{ id: string; name: string; path: string; canAddChildren: boolean } | null>;
  /** Folders with exactly this name (not trashed), at most 20, each with its path. */
  findFolders(name: string): Promise<Array<{ id: string; name: string; path: string }>>;
}

/** The subset of `OAuth2Client.request` this module relies on. */
export type DriveRequest = (opts: {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  params?: Record<string, string>;
  data?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ data: unknown; headers: unknown }>;

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** HTTP status of a failed Google API call, whichever way the HTTP layer reports it. */
export function httpStatus(e: unknown): number | null {
  const err = e as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [err?.status, err?.response?.status, err?.code]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

const ALL_DRIVES = { supportsAllDrives: 'true' } as const;
const ROOT_LABEL = 'Мой диск';
const MAX_DEPTH = 10;

/** The folder id in a pasted link (`…/folders/<id>`, `…open?id=<id>`) or a bare id; null for anything else. */
export function folderIdFromLink(text: string): string | null {
  const t = text.trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(t)) return t;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname)) return null;
  const id = /\/folders\/([A-Za-z0-9_-]{10,})(?:\/|$)/.exec(url.pathname)?.[1] ?? (url.pathname.endsWith('/open') ? url.searchParams.get('id') : null);
  return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const header = (headers: unknown, name: string): string | null => {
  if (!headers) return null;
  const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>;
  const value = typeof h.get === 'function' ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
  return typeof value === 'string' && value ? value : null;
};

export function createDriveClient(request: DriveRequest): DriveClient & DriveFolderLookup {
  async function upload(a: { localPath: string; name: string; parentId: string; mimeType: string }, existingFileId?: string) {
    const size = (await stat(a.localPath)).size;
    // Resumable protocol: open a session with the metadata, then send the bytes as one streamed request.
    const session = await request({
      url: existingFileId ? `${UPLOAD}/${encodeURIComponent(existingFileId)}` : UPLOAD,
      method: existingFileId ? 'PATCH' : 'POST',
      params: { uploadType: 'resumable', fields: 'id,version,md5Checksum', ...ALL_DRIVES },
      data: existingFileId ? { name: a.name } : { name: a.name, parents: [a.parentId] },
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': a.mimeType, 'X-Upload-Content-Length': String(size) },
    });
    const location = header(session.headers, 'location');
    if (!location) throw new Error('Google Drive не выдал адрес загрузки');
    const done = await request({
      url: location,
      method: 'PUT',
      data: createReadStream(a.localPath),
      headers: { 'Content-Type': a.mimeType, 'Content-Length': String(size) },
    });
    const file = (done.data ?? {}) as { id?: string; version?: string | number; md5Checksum?: string };
    if (!file.id) throw new Error('Google Drive не подтвердил загрузку файла');
    return { id: file.id, version: String(file.version ?? ''), md5: file.md5Checksum ?? '' };
  }

  type Meta = { id?: string; name?: string; mimeType?: string; parents?: string[]; capabilities?: { canAddChildren?: boolean } };
  const meta = async (id: string): Promise<Meta | null> => {
    try {
      const r = await request({
        url: `${FILES}/${encodeURIComponent(id)}`,
        params: { fields: 'id,name,mimeType,parents,capabilities(canAddChildren)', ...ALL_DRIVES },
      });
      return (r.data ?? {}) as Meta;
    } catch (e) {
      if (httpStatus(e) === 404) return null;
      throw e;
    }
  };
  /** `Мой диск / A / B` for a folder named B; a parent that cannot be read ends the walk with `…`. */
  const pathOf = async (name: string, parents: string[] | undefined): Promise<string> => {
    const parts = [name];
    let parent = parents?.[0];
    for (let depth = 0; parent && depth < MAX_DEPTH; depth++) {
      let m: Meta | null = null;
      try {
        m = await meta(parent);
      } catch {
        m = null;
      }
      if (!m) {
        parts.unshift('…');
        break;
      }
      const next = m.parents?.[0];
      parts.unshift(next ? (m.name ?? '…') : ROOT_LABEL);
      parent = next;
    }
    return parts.join(' / ');
  };

  return {
    async getFolder(id) {
      const m = await meta(id);
      if (!m || m.mimeType !== FOLDER_MIME) return null;
      const name = m.name ?? '';
      return { id, name, path: await pathOf(name, m.parents), canAddChildren: m.capabilities?.canAddChildren === true };
    },

    async findFolders(name) {
      const found = await request({
        url: FILES,
        params: {
          q: `name = ${quote(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`,
          fields: 'files(id,name,parents)',
          pageSize: '20',
          ...ALL_DRIVES,
          includeItemsFromAllDrives: 'true',
        },
      });
      const files = ((found.data as { files?: Array<{ id: string; name?: string; parents?: string[] }> })?.files ?? []).filter((f) => f?.id);
      const out: Array<{ id: string; name: string; path: string }> = [];
      for (const f of files) out.push({ id: f.id, name: f.name ?? name, path: await pathOf(f.name ?? name, f.parents) });
      return out;
    },

    async ensureFolder(name, parentId) {
      const parent = parentId ?? 'root';
      const found = await request({
        url: FILES,
        params: {
          q: `name = ${quote(name)} and ${quote(parent)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
          fields: 'files(id)',
          spaces: 'drive',
          pageSize: '1',
        },
      });
      const existing = (found.data as { files?: Array<{ id: string }> })?.files?.[0]?.id;
      if (existing) return existing;
      const created = await request({ url: FILES, method: 'POST', params: { fields: 'id' }, data: { name, mimeType: FOLDER_MIME, parents: [parent] } });
      const id = (created.data as { id?: string })?.id;
      if (!id) throw new Error('Google Drive не создал папку');
      return id;
    },

    async uploadFile(a) {
      if (a.existingFileId) {
        try {
          return await upload(a, a.existingFileId);
        } catch (e) {
          if (httpStatus(e) !== 404) throw e; // deleted in Drive: fall through and create it again
        }
      }
      // An earlier attempt may have uploaded the file without us learning its id (lost response, crash):
      // reuse that copy instead of creating a second file with the same name.
      const found = await request({
        url: FILES,
        params: {
          q: `name = ${quote(a.name)} and ${quote(a.parentId)} in parents and mimeType != '${FOLDER_MIME}' and trashed = false`,
          fields: 'files(id)',
          spaces: 'drive',
          pageSize: '1',
          ...ALL_DRIVES,
          includeItemsFromAllDrives: 'true',
        },
      });
      const orphan = (found.data as { files?: Array<{ id: string }> })?.files?.[0]?.id;
      return upload(a, orphan);
    },
  };
}
