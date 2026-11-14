import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThrEvents } from '@shared/types';
import { createApp, type App } from '../../src/main/app';
import type { CaptureProcs, ProcessRunner } from '../../src/main/capture/processes';
import { tmpDir } from '../helpers';

type Sent = { [K in keyof ThrEvents]: { event: K; payload: ThrEvents[K] } }[keyof ThrEvents];

let root: string;
let app: App;
let sent: Sent[];
let epochDirs: string[];
let live: boolean;
let nextSeq: number;
let shown: string[];
let hangEncode: boolean;

const runner: ProcessRunner = {
  probe: async () => (live ? { live: true, streamId: '987654321' } : { live: false, reason: 'offline' }),
  checkBinaries: async () => null,
  spawnCapture(_channel, epochDir): CaptureProcs {
    epochDirs.push(epochDir);
    return { onExit: () => {}, stop: async () => {} };
  },
};

/** Simulates FFmpeg completing the next 2-second segment. */
function feed(count = 1) {
  const dir = epochDirs.at(-1)!;
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const seq = nextSeq++;
    const file = `seg_${String(seq).padStart(6, '0')}.ts`;
    writeFileSync(join(dir, file), 'x'.repeat(10));
    appendFileSync(join(dir, 'segments.csv'), `${file},${(seq * 2).toFixed(6)},${(seq * 2 + 2).toFixed(6)}\n`);
  }
}

async function build(dbFile = join(root, 'thr.sqlite')) {
  app = createApp({
    dbFile, userDataDir: root, videosDir: join(root, 'videos'),
    send: (event, payload) => void sent.push({ event, payload } as Sent),
    mediaOrigin: () => 'http://localhost:1234',
    showItemInFolder: (p) => void shown.push(p),
    shutdownTimeoutMs: 200,
    overrides: {
      runner, pollMs: 5,
      concat: async (segments, out) => writeFileSync(out, segments.join('\n')),
      encode: async (a) => {
        if (hangEncode) await new Promise(() => {});
        writeFileSync(a.output, `clip ${a.startMs}+${a.durationMs}`);
      },
      sleep: async () => {
        feed();
        await new Promise((r) => setTimeout(r, 15));
      },
    },
  });
  await app.start();
}

beforeEach(async () => {
  root = tmpDir();
  sent = [];
  epochDirs = [];
  shown = [];
  hangEncode = false;
  live = true;
  nextSeq = 0;
  await build();
});
afterEach(async () => {
  await app.shutdown();
});

const until = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true), { timeout: 5000, interval: 5 });
const events = <K extends keyof ThrEvents>(name: K) => sent.filter((s) => s.event === name).map((s) => s.payload as ThrEvents[K]);
const notices = () => events('notice').map((n) => `${n.level}: ${n.message}`);

async function record(segments = 10) {
  await app.api.capture.start('Foo');
  feed(segments);
  await until(() => app.status().session?.state === 'RECORDING' && app.status().bufferedMs === segments * 2000);
}

test('сквозной сценарий: маркер → F8 → редактор → Ctrl+S → клип на диске, маркеры обнулены', async () => {
  await record(10);
  expect((await app.api.settings.get()).lastChannel).toBe('foo');

  app.handleHotkey({ kind: 'marker', type: 2 }, Date.now());
  const marker = events('marker:prompt')[0]!;
  expect(marker).toMatchObject({ type: 2, comment: '', epoch: 0 });
  expect(marker.sourceTimeMs).toBeGreaterThan(15_000);
  await app.api.markers.setComment(marker.id, 'смешно');
  expect(app.status().markerCount).toBe(1);

  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().includes('info: Черновик сохранён'));
  const [draft] = await app.api.drafts.list();
  expect(draft).toMatchObject({ startMs: 0, epoch: 0 });

  await app.api.ui.setState({ mode: 'watch', textInputFocused: false });
  app.handleHotkey({ kind: 'toggleEditor' }, Date.now());
  await until(() => events('nav').length === 1);
  expect(events('nav')[0]).toEqual({ view: 'editor', draftId: draft!.id });
  const opened = (await app.api.drafts.open(null))!;
  expect(opened.draft.id).toBe(draft!.id);
  expect(opened.mediaUrl).toBe(`http://localhost:1234/media/drafts/${draft!.id}.mp4?v=${draft!.startMs}-${draft!.endMs}`);
  expect(opened.moment.markers.map((m) => m.comment)).toEqual(['смешно']);

  await app.api.ui.setState({ mode: 'editor', textInputFocused: true });
  app.handleHotkey({ kind: 'save' }, Date.now());
  expect(events('editor:save')).toHaveLength(1);
  const result = await app.api.clips.export({ draftId: draft!.id, trimStartMs: 1000, trimEndMs: draft!.endMs, title: 'Funny reaction' });
  if (!result.ok) throw new Error(result.error);
  // a marker pressed while the export is running belongs to the next clip
  app.handleHotkey({ kind: 'marker', type: 5 }, Date.now());
  await until(() => notices().some((n) => n.startsWith('info: Клип сохранён')));

  const [clip] = await app.api.clips.list();
  expect(clip).toMatchObject({ id: result.value.clipId, title: 'Funny reaction', syncStatus: 'pending' });
  expect(readdirSync(clip!.dir).sort()).toEqual(['funny-reaction.mp4', 'markers.json']);
  const json = JSON.parse(readFileSync(clip!.markersPath, 'utf8'));
  expect(json.markers).toEqual([{ id: marker.id, type: 2, timeMs: marker.sourceTimeMs - 1000, comment: 'смешно' }]);
  expect((await app.api.moment.active())!.markers.map((m) => m.type)).toEqual([5]);
  expect(await app.api.drafts.list()).toEqual([]);
  expect(events('clips:changed').length).toBeGreaterThan(0);
  await app.api.clips.showInFolder(clip!.id);
  expect(shown).toEqual([clip!.mp4Path]);
});

test('цифра и F8 без записи → предупреждение, ничего не создаётся', async () => {
  app.handleHotkey({ kind: 'marker', type: 1 }, Date.now());
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().length === 2);
  expect(notices()).toEqual(['warn: Запись не идёт — маркер не поставлен', 'warn: Буфер пуст — нечего сохранять']);
  expect(events('marker:prompt')).toEqual([]);
  expect(await app.api.drafts.list()).toEqual([]);
});

test('F9 без черновика и без записи → уведомление; из редактора → возврат к просмотру', async () => {
  app.handleHotkey({ kind: 'toggleEditor' }, Date.now());
  await until(() => notices().length === 1);
  expect(notices()).toEqual(['warn: Черновиков нет — нажмите F8 во время просмотра']);
  await app.api.ui.setState({ mode: 'editor', textInputFocused: false });
  app.handleHotkey({ kind: 'toggleEditor' }, Date.now());
  expect(events('nav')).toEqual([{ view: 'watch' }]);
});

test('F9 во время записи без черновика сначала сохраняет повтор', async () => {
  await record(5);
  app.handleHotkey({ kind: 'toggleEditor' }, Date.now());
  await until(() => events('nav').length === 1);
  const [draft] = await app.api.drafts.list();
  expect(events('nav')[0]).toEqual({ view: 'editor', draftId: draft!.id });
});

test('остановка записи с несохранёнными маркерами собирает черновик автоматически', async () => {
  await record(10);
  app.handleHotkey({ kind: 'marker', type: 3 }, Date.now());
  await app.api.capture.stop();
  const drafts = await app.api.drafts.list();
  expect(drafts).toHaveLength(1);
  expect(existsSync(drafts[0]!.filePath)).toBe(true);
  expect(app.status()).toMatchObject({ session: null, bufferedMs: 0 });
  const opened = (await app.api.drafts.open(drafts[0]!.id))!;
  expect(opened.moment.markers.map((m) => m.type)).toEqual([3]);
});

test('перезапуск: буфер очищен, черновик и его маркеры на месте, пустые моменты закрыты', async () => {
  await record(10);
  app.handleHotkey({ kind: 'marker', type: 3 }, Date.now());
  await app.api.capture.stop();
  const [draft] = await app.api.drafts.list();
  await app.shutdown();
  mkdirSync(join(root, 'buffer', 'stale', 'e0'), { recursive: true });
  writeFileSync(join(root, 'buffer', 'stale', 'e0', 'seg_000000.ts'), 'x');
  await build();
  expect(readdirSync(join(root, 'buffer'))).toEqual([]);
  expect((await app.api.drafts.list()).map((d) => d.id)).toEqual([draft!.id]);
  expect((await app.api.drafts.open(draft!.id))!.moment.markers).toHaveLength(1);
  expect(await app.api.moment.active()).toBeNull();
});

test('перезапуск удаляет записи о черновиках, файл которых пропал', async () => {
  await record(10);
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().includes('info: Черновик сохранён'));
  const [draft] = await app.api.drafts.list();
  await app.api.capture.stop();
  await app.shutdown();
  const { rmSync } = await import('node:fs');
  rmSync(draft!.filePath);
  await build();
  expect(await app.api.drafts.list()).toEqual([]);
});

test('ошибка экспорта → уведомление, момент в «Не сохранены», повтор возможен', async () => {
  await record(10);
  app.handleHotkey({ kind: 'marker', type: 2 }, Date.now());
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().includes('info: Черновик сохранён'));
  const [draft] = await app.api.drafts.list();
  await app.api.settings.set({ libraryDir: join(root, 'thr.sqlite') }); // a file, not a directory: mkdir fails
  expect((await app.api.clips.export({ draftId: draft!.id, trimStartMs: 0, trimEndMs: 5000, title: 't' })).ok).toBe(true);
  await until(() => notices().some((n) => n.startsWith('error: Не удалось сохранить клип')));
  const failed = await app.api.clips.failed();
  expect(failed.map((m) => [m.status, m.draftId, m.markers.length])).toEqual([['FAILED', draft!.id, 1]]);
  await app.api.settings.set({ libraryDir: join(root, 'videos') });
  expect((await app.api.clips.export({ draftId: draft!.id, trimStartMs: 0, trimEndMs: 5000, title: 't' })).ok).toBe(true);
  await until(() => notices().some((n) => n.startsWith('info: Клип сохранён')));
  expect(await app.api.clips.failed()).toEqual([]);
});

test('ui.setState и settings.set отбрасывают мусор', async () => {
  await app.api.ui.setState({ mode: 'hacked', textInputFocused: 'yes' } as never);
  expect(app.getUi()).toEqual({ mode: 'other', textInputFocused: true });
  const before = await app.api.settings.get();
  const after = await app.api.settings.set({ captureLatencyMs: 9_999_999, markerOffsetMs: -250, libraryDir: '  ', bufferSeconds: 5 } as never);
  expect(after).toEqual({ ...before, markerOffsetMs: -250 });
});

test('канал не в эфире → статус ERROR с текстом', async () => {
  live = false;
  await app.api.capture.start('foo');
  expect((await app.api.capture.status()).session).toMatchObject({ state: 'ERROR', error: 'Канал не в эфире' });
  expect(events('capture:status').at(-1)!.session!.state).toBe('ERROR');
});

test('Drive не настроен: статус и понятная ошибка подключения', async () => {
  expect(await app.api.drive.status()).toEqual({ connected: false });
  expect(await app.api.drive.connect()).toEqual({ ok: false, error: 'Укажите Client ID и Client Secret в настройках' });
});

test('маркер, поставленный после F8 за пределами черновика, при остановке получает собственный черновик', async () => {
  await record(5);
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().includes('info: Черновик сохранён'));
  feed(60); // two more minutes of stream
  await until(() => app.status().bufferedMs >= 120_000);
  app.handleHotkey({ kind: 'marker', type: 4 }, Date.now());
  const marker = events('marker:prompt')[0]!;
  await app.api.capture.stop();
  const drafts = await app.api.drafts.list();
  expect(drafts).toHaveLength(2);
  expect(drafts.some((d) => d.startMs <= marker.sourceTimeMs && marker.sourceTimeMs <= d.endMs)).toBe(true);
});

test('перезапуск не теряет маркеры второго черновика после экспорта первого', async () => {
  await record(5);
  app.handleHotkey({ kind: 'marker', type: 1 }, Date.now());
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().filter((n) => n === 'info: Черновик сохранён').length === 1);
  feed(120);
  await until(() => app.status().bufferedMs >= 240_000);
  app.handleHotkey({ kind: 'marker', type: 2 }, Date.now());
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().filter((n) => n === 'info: Черновик сохранён').length === 2);
  const [a, b] = await app.api.drafts.list();
  expect((await app.api.clips.export({ draftId: a!.id, trimStartMs: 0, trimEndMs: 5000, title: 'first' })).ok).toBe(true);
  await until(() => notices().some((n) => n.startsWith('info: Клип сохранён')));
  await app.api.capture.stop();
  await app.shutdown();
  await build();
  const reopened = (await app.api.drafts.open(b!.id))!;
  expect(reopened.moment.markers.map((m) => m.type)).toEqual([2]);
});

test('F8 сразу перед остановкой записи не теряется', async () => {
  await record(5);
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await app.api.capture.stop();
  expect(await app.api.drafts.list()).toHaveLength(1);
});

test('выход не зависает, если экспорт не завершается', async () => {
  await record(5);
  app.handleHotkey({ kind: 'replay' }, Date.now());
  await until(() => notices().includes('info: Черновик сохранён'));
  const [draft] = await app.api.drafts.list();
  hangEncode = true;
  await app.api.clips.export({ draftId: draft!.id, trimStartMs: 0, trimEndMs: 5000, title: 't' });
  const started = Date.now();
  await app.shutdown();
  expect(Date.now() - started).toBeLessThan(3000);
});

test('Client Secret не возвращается в окно приложения', async () => {
  await app.api.settings.set({ driveClientId: 'id', driveClientSecret: 'super-secret' });
  const seen = await app.api.settings.get();
  expect(seen.driveClientSecret).toBe('');
  expect(seen.driveClientId).toBe('id');
  expect(JSON.stringify(await app.api.settings.set({ markerOffsetMs: 10 }))).not.toContain('super-secret');
  expect(app.settings.get().driveClientSecret).toBe('super-secret');
});
