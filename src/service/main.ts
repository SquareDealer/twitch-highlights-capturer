import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../main/db';
import { createClipRepo } from './clipRepo';
import { bufferDirProblem, defaultConfig, loadConfig, type ServiceConfig } from './config';
import { publicClip, startHttp } from './http';
import { Janitor } from './janitor';
import { settingsFromConfig } from './profileSettings';
import { ProfileService } from './profiles';
import { StreamRegistry, type StreamRegistryDeps } from './streams';
import type { FeedClip } from './types';

const RESTARTED = 'Сервис был перезапущен до завершения нарезки';
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export interface RunServiceOptions {
  configFile: string;
  dataDir: string;
  overrides?: Partial<StreamRegistryDeps>;
  /** Overrides config.port (0 picks a free port). */
  port?: number;
  /** Interface to listen on; all interfaces by default. */
  host?: string;
  /** Built web UI; defaults to out/web of the repository. */
  webDir?: string;
}

function generatePassword(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)];
  return s;
}

/** Writes a config file with the defaults and a fresh password. Paths are left out so they follow the data directory. */
function createConfigFile(file: string, dataDir: string): void {
  const { dataDir: _d, libraryDir: _l, bufferDir: _b, ...rest } = defaultConfig(dataDir);
  const password = generatePassword();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...rest, password }, null, 2) + '\n', 'utf8');
  console.log(`Создан файл конфигурации ${file}. Пароль для входа: ${password}`);
}

export async function runService(opts: RunServiceOptions): Promise<{ port: number; shutdown(): Promise<void> }> {
  // Absolute paths: the detector runs with its own working directory and gets the config path as an argument.
  const configFile = resolve(opts.configFile);
  const dataDir = resolve(opts.dataDir);
  if (!existsSync(configFile)) createConfigFile(configFile, dataDir);
  // One shared object: StreamRegistry.setMultiStream mutates it in place.
  const cfg: ServiceConfig = loadConfig(configFile, dataDir);
  const config = () => cfg;
  // Checked before anything touches the disk: bufferDir is wiped below.
  const unsafeBuffer = bufferDirProblem(cfg);
  if (unsafeBuffer) throw new Error(unsafeBuffer);

  mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(join(cfg.dataDir, 'service.sqlite'));
  const profiles = new ProfileService(db, () => settingsFromConfig(cfg));
  const clips = createClipRepo(db);
  clips.failPending(RESTARTED);

  // Buffers of a previous run are useless; the registry clears their table rows itself.
  rmSync(cfg.bufferDir, { recursive: true, force: true });
  mkdirSync(cfg.bufferDir, { recursive: true });

  const janitor = new Janitor({ clips, config });
  const registry = new StreamRegistry({
    ...opts.overrides,
    db,
    config,
    configFile,
    cuttingPaused: () => janitor.state().paused,
    profiles,
  });

  let http: Awaited<ReturnType<typeof startHttp>>;
  try {
    http = await startHttp(
      { registry, clips, config, webDir: opts.webDir ?? join(__dirname, '..', '..', 'out', 'web'), cuttingPaused: () => janitor.state() },
      opts.port ?? cfg.port,
      opts.host,
    );
  } catch (err) {
    await registry.shutdown();
    db.close();
    throw err;
  }
  // Registry events ('streams', 'clip', 'notice') are forwarded by startHttp itself.
  janitor.on('cutting', (state: unknown) => http.broadcast('cutting', state));
  janitor.on('clip', (clip: FeedClip) => http.broadcast('clip', publicClip(clip)));
  janitor.start();

  console.log(`Сервис запущен: http://localhost:${http.port}`);

  let stopping: Promise<void> | null = null;
  const shutdown = () =>
    (stopping ??= (async () => {
      // Each step runs even if an earlier one fails: http and the database must always be closed.
      try {
        await registry.shutdown(); // flushes pending clips
      } finally {
        janitor.stop();
        try {
          await http.close();
        } finally {
          db.close();
        }
      }
    })());
  return { port: http.port, shutdown };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(__filename);
}

if (isDirectRun()) {
  runService({ configFile: process.env.HL_CONFIG || './config.json', dataDir: process.env.HL_DATA || './data' }).then(
    (svc) => {
      const stop = (signal: string) => {
        console.log(`Получен ${signal}, сервис останавливается…`);
        svc.shutdown().then(
          () => process.exit(0),
          (err) => {
            console.error('Ошибка при остановке сервиса', err);
            process.exit(1);
          },
        );
      };
      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
    },
    (err) => {
      console.error('Не удалось запустить сервис:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
