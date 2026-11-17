import { useEffect, useMemo, useState } from 'react';
import type { DetectorSignals } from '../../service/detectorProcess';
import type { Profile } from '../../service/profiles';
import { FIELDS, type ProfileSettings } from '../../service/profileSettings';
import type { StreamStatus } from '../../service/streams';
import type { TuningEntry } from '../../service/tuningLog';
import { api } from '../api';
import { clockTime, duration, num, numM, plural, signed } from '../format';
import { entryText, firingStarts, mergeFrames, thresholdsOf, type Thresholds } from '../tuning';
import { ProfileEditor } from './ProfileEditor';
import { ThresholdChart } from './ThresholdChart';
import { TriggerChain } from './TriggerChain';

const SPIKE = FIELDS.find((f) => f.path === 'detector.chat.minSpike')!;
const SHARE = FIELDS.find((f) => f.path === 'detector.chat.minTriggerShare')!;
const KEYS: Array<keyof Thresholds> = ['minSpike', 'minTriggerShare', 'minTriggerMessages', 'minTriggerAuthors'];
const same = (a: Thresholds, b: Thresholds) => KEYS.every((k) => a[k] === b[k]);
const firings = (n: number) => `${n} ${plural(n, 'срабатывание', 'срабатывания', 'срабатываний')}`;

/** `streams`: every running stream, so the panel names all that use the profile. */
export function TuningPanel({ stream, streams, profile, factory, liveEntries }: {
  stream: StreamStatus; streams: StreamStatus[]; profile: Profile | undefined; factory?: ProfileSettings; liveEntries: TuningEntry[];
}) {
  const [frames, setFrames] = useState<DetectorSignals[]>([]);
  const [history, setHistory] = useState<TuningEntry[]>([]);
  const [editing, setEditing] = useState(false);
  // Thresholds being tried in this browser only; null: nothing changed. The detector gets them on «Применить».
  const [draft, setDraft] = useState<Thresholds | null>(null);
  const [seen, setSeen] = useState(profile ? `${profile.id}|${profile.updatedAt}` : '');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setFrames([]);
    setHistory([]);
    api
      .tuning(stream.id)
      .then((r) => {
        if (!alive) return;
        setFrames((f) => mergeFrames(r.frames, f));
        setHistory(r.entries);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [stream.id]);

  useEffect(() => {
    const s = stream.signals;
    if (s) setFrames((f) => mergeFrames(f, [s]));
  }, [stream.signals]);

  const entries = useMemo(() => {
    const seenKeys = new Set<string>();
    const all = [...history, ...liveEntries].filter((e) => {
      const key = `${e.at}|${e.kind}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
    return all.reverse();
  }, [history, liveEntries]);

  // The profile was saved somewhere else (or another one was chosen for the stream).
  const version = profile ? `${profile.id}|${profile.updatedAt}` : '';
  const changedElsewhere = version !== seen;
  if (changedElsewhere && (draft === null || applying || version.split('|')[0] !== seen.split('|')[0])) {
    setSeen(version);
    if (version.split('|')[0] !== seen.split('|')[0]) setDraft(null);
  }

  const d = stream.signals?.detail;
  const s = profile?.settings;
  const saved = s ? thresholdsOf(s) : null;
  const cur = draft ?? saved;
  const others = profile ? streams.filter((x) => x.profile.id === profile.id && x.id !== stream.id) : [];

  const change = (key: keyof Thresholds, value: number) => {
    if (!saved || !cur) return;
    const next = { ...cur, [key]: value };
    setDraft(same(next, saved) ? null : next);
    setError('');
  };

  const apply = async () => {
    if (!profile || !draft || applying) return;
    const settings = structuredClone(profile.settings);
    Object.assign(settings.detector.chat, draft);
    setApplying(true);
    setError('');
    try {
      await api.updateProfile(profile.id, { settings });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const speeds = frames.map((f) => f.detail?.chat.spike ?? f.chatSpike);
  const shares = frames.map((f) => f.detail?.chat.triggerShare ?? 0);
  const marks = cur ? firingStarts(frames, cur) : [];
  const savedCount = saved ? firingStarts(frames, saved).length : 0;

  return (
    <div className="tuning">
      {!d ? (
        <div className="muted">ждём данные детектора…</div>
      ) : (
        <>
          {s && saved && cur ? (
            <>
              <TriggerChain detail={d} draft={cur} saved={saved} warmupS={s.detector.events.warmupS} />
              <ThresholdChart
                label="Скорость чата" values={speeds} marks={marks} def={SPIKE}
                threshold={cur.minSpike} savedThreshold={saved.minSpike}
                min={s.detector.chat.endSpike} max={s.detector.score.spikeFull - SPIKE.step}
                secondary={{ value: s.detector.chat.endSpike, label: 'конец события' }}
                onChange={(v) => change('minSpike', v)}
              />
              <ThresholdChart
                label="Состав" values={shares} marks={marks} def={SHARE}
                threshold={cur.minTriggerShare} savedThreshold={saved.minTriggerShare}
                max={s.detector.score.shareFull - 0.01}
                onChange={(v) => change('minTriggerShare', v)}
              />
              <div className="tuning-count">
                С этими порогами за 5 минут: {firings(marks.length)}
                {draft && ` (с сохранёнными — ${savedCount})`}
                <span className="muted"> · слияние событий и часовой лимит не учитываются</span>
              </div>
              {changedElsewhere && draft && !applying && (
                <div className="banner">
                  Профиль изменён в другом окне{' '}
                  <button type="button" onClick={() => setSeen(version)}>Оставить мои пороги</button>{' '}
                  <button type="button" onClick={() => { setDraft(null); setSeen(version); }}>Взять новые</button>
                </div>
              )}
              <div className="row">
                <button type="button" className="primary" disabled={!draft || applying} onClick={() => void apply()}>Применить к профилю</button>
                <button type="button" disabled={!draft || applying} onClick={() => { setDraft(null); setError(''); }}>Сбросить</button>
                {draft && <span className="muted">изменения ещё не применены</span>}
              </div>
              {draft && others.length > 0 && (
                <div className="muted">Изменения сразу подействуют и на эфиры: {others.map((x) => x.channel).join(', ')}</div>
              )}
              {error && <div className="error">{error}</div>}
            </>
          ) : (
            <div className="muted">
              чат ×{num(d.chat.spike)} · состав {num(d.chat.triggerShare * 100)} % · сообщений {d.chat.triggerMessages} · авторов {d.chat.triggerAuthors}
            </div>
          )}
          <section>
            <h4>Сейчас</h4>
            <div>
              Чат: {d.chat.messages} {plural(d.chat.messages, 'сообщение', 'сообщения', 'сообщений')} за {s ? num(s.detector.chat.windowS) : '—'} с · фон {num(d.chat.baseline)} · смех {d.chat.laughMessages} · реакции {d.chat.reactionMessages}
            </div>
            <div>
              Звук: {numM(d.audio.db)} дБ · фон {numM(d.audio.baselineDb)} дБ · {signed(d.audio.deltaDb)} дБ (всплеск от +{s ? num(s.detector.audio.spikeDb) : '—'}) · голос {num(d.audio.vad, 2)} (от {s ? num(s.detector.audio.spikeVad, 2) : '—'})
            </div>
            <div>
              Оценка: 1 + скорость {num(d.score.speed)} + состав {num(d.score.share)} + звук {num(d.score.audio)} = {num(d.score.total)}
            </div>
            {d.event && (
              <div>
                событие идёт {duration(d.event.durationMs)} · оценка {num(d.event.score.total)}
              </div>
            )}
          </section>
        </>
      )}
      <section>
        <h4>Журнал</h4>
        {entries.length === 0 ? (
          <div className="muted">пока пусто</div>
        ) : (
          entries.map((e) => (
            <div key={`${e.at}|${e.kind}`} className="log-entry">
              <span className="muted">{clockTime(e.at, true)}</span> {entryText(e)}
            </div>
          ))
        )}
      </section>
      {profile && (
        <div>
          <button type="button" onClick={() => setEditing((v) => !v)}>Все настройки профиля</button>
          {editing && <ProfileEditor key={profile.id} profile={profile} streams={streams} {...(factory ? { factory } : {})} />}
        </div>
      )}
    </div>
  );
}
