import { useEffect, useMemo, useState } from 'react';
import type { DetectorSignals } from '../../service/detectorProcess';
import type { Profile } from '../../service/profiles';
import type { StreamStatus } from '../../service/streams';
import type { TuningEntry } from '../../service/tuningLog';
import { api } from '../api';
import { clockTime, duration, num, numM, plural, signed } from '../format';
import { conditionRows, entryText, mergeFrames, verdict } from '../tuning';
import { ProfileEditor } from './ProfileEditor';
import { Sparkline } from './Sparkline';

const shareOf = (f: DetectorSignals) => f.detail?.chat.triggerShare ?? f.triggerShare ?? 0;

/** `streams`: every running stream, so the editor names all that use the profile. */
export function TuningPanel({ stream, streams, profile, liveEntries }: {
  stream: StreamStatus; streams: StreamStatus[]; profile: Profile | undefined; liveEntries: TuningEntry[];
}) {
  const [frames, setFrames] = useState<DetectorSignals[]>([]);
  const [history, setHistory] = useState<TuningEntry[]>([]);
  const [editing, setEditing] = useState(false);

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
    const seen = new Set<string>();
    const all = [...history, ...liveEntries].filter((e) => {
      const key = `${e.at}|${e.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return all.reverse();
  }, [history, liveEntries]);

  const d = stream.signals?.detail;
  const s = profile?.settings;
  const shares = frames.map(shareOf);
  const speeds = frames.map((f) => f.chatSpike);

  return (
    <div className="tuning">
      {!d ? (
        <div className="muted">ждём данные детектора…</div>
      ) : (
        <>
          <section>
            <h4>Срабатывание</h4>
            {s ? (
              conditionRows(d, s).map((r) => (
                <div key={r.label} className={`cond ${r.ok ? 'ok' : 'bad'}`}>
                  <span>{r.label}</span>
                  <span>{r.value}</span>
                  <span className="muted">{r.need}</span>
                </div>
              ))
            ) : (
              <div className="muted">
                прогрев: идёт {duration(d.sinceStartMs)} · чат ×{num(d.chat.spike)} · состав {num(d.chat.triggerShare * 100)} % · сообщений {d.chat.triggerMessages} · авторов {d.chat.triggerAuthors}
              </div>
            )}
            <div>{verdict(d)}</div>
          </section>
          <section>
            <h4>Чат</h4>
            <div>
              {d.chat.messages} {plural(d.chat.messages, 'сообщение', 'сообщения', 'сообщений')} за {s ? num(s.detector.chat.windowS) : '—'} с · фон {num(d.chat.baseline)} · скорость ×{num(d.chat.spike)} · смех {d.chat.laughMessages} · реакции {d.chat.reactionMessages}
            </div>
          </section>
          <section>
            <h4>Звук</h4>
            <div>
              {numM(d.audio.db)} дБ · фон {numM(d.audio.baselineDb)} дБ · {signed(d.audio.deltaDb)} дБ (всплеск от +{s ? num(s.detector.audio.spikeDb) : '—'}) · голос {num(d.audio.vad, 2)} (от {s ? num(s.detector.audio.spikeVad, 2) : '—'})
            </div>
          </section>
          <section>
            <h4>Оценка</h4>
            <div>
              1 + скорость {num(d.score.speed)} + состав {num(d.score.share)} + звук {num(d.score.audio)} = {num(d.score.total)}
            </div>
            {d.event && (
              <div>
                событие идёт {duration(d.event.durationMs)} · оценка {num(d.event.score.total)}
              </div>
            )}
          </section>
          <section>
            <h4>За 5 минут</h4>
            <div className="spark-row">
              <span className="muted">состав</span>
              <Sparkline label="состав" values={shares} threshold={s?.detector.chat.minTriggerShare ?? 0} max={Math.max(s?.detector.score.shareFull ?? 0, ...shares)} />
            </div>
            <div className="spark-row">
              <span className="muted">скорость</span>
              <Sparkline label="скорость" values={speeds} threshold={s?.detector.chat.endSpike ?? 0} max={Math.max(s?.detector.score.spikeFull ?? 0, ...speeds)} />
            </div>
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
          <button type="button" onClick={() => setEditing((v) => !v)}>Изменить профиль</button>
          {editing && <ProfileEditor key={profile.id} profile={profile} streams={streams} />}
        </div>
      )}
    </div>
  );
}
