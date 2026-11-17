import type { DetectorDetail } from '../../service/detectorProcess';
import { duration, num, signed } from '../format';
import { conditionsWith, verdict, type Thresholds } from '../tuning';

const pct = (p: number) => `${num(p * 100)} %`;

function Bar({ value, threshold }: { value: number; threshold: number }) {
  const scale = Math.max(threshold * 2, value, 1e-9);
  const at = (v: number) => `${Math.max(0, Math.min(1, v / scale)) * 100}%`;
  return (
    <div className="chain-bar" aria-hidden="true">
      <div className="fill" style={{ width: at(value) }} />
      <div className="tick" style={{ left: at(threshold) }} />
    </div>
  );
}

/** The rule as it is checked: spike, then composition; sound only adds points. Judged by `draft`. */
export function TriggerChain({ detail: d, draft, saved, warmupS }: {
  detail: DetectorDetail; draft: Thresholds; saved: Thresholds; warmupS: number;
}) {
  const c = d.chat;
  const cond = conditionsWith(d, draft);
  const composed = cond.share && cond.messages && cond.authors;
  const drafted = (Object.keys(saved) as Array<keyof Thresholds>).some((k) => saved[k] !== draft[k]);
  const result = cond.fired && drafted ? 'сработало бы с этими порогами' : verdict({ ...d, conditions: cond });

  return (
    <div className="chain">
      {!cond.warm && <div className="chain-warm muted">прогрев: идёт {duration(d.sinceStartMs)}, нужно {num(warmupS)} с</div>}
      <div className="chain-steps">
        <div className={`chain-step ${cond.spike ? 'ok' : 'bad'}`}>
          <div className="chain-title"><span className="chain-n">1</span> <span>Всплеск</span></div>
          <div className="chain-value">×{num(c.spike)}</div>
          <Bar value={c.spike} threshold={draft.minSpike} />
          <div className="muted">нужно ≥ ×{num(draft.minSpike)}</div>
          <div className="muted">{c.messages} за окно · фон {num(c.baseline)}</div>
        </div>
        <div className={`chain-step ${composed ? 'ok' : 'bad'}${cond.spike ? '' : ' dim'}`}>
          <div className="chain-title"><span className="chain-n">2</span> <span>Состав</span></div>
          <div className="chain-value">{pct(c.triggerShare)}</div>
          <Bar value={c.triggerShare} threshold={draft.minTriggerShare} />
          <div className="muted">нужно ≥ {pct(draft.minTriggerShare)}</div>
          <div className="muted">{c.triggerMessages} из {c.messages} · авторов {c.triggerAuthors}</div>
        </div>
        <div className={`chain-step bonus${d.score.audio > 0 ? ' on' : ''}`}>
          <div className="chain-title"><span className="chain-n">3</span> <span>Звук</span> <span className="muted">бонус</span></div>
          <div className="chain-value">{signed(d.audio.deltaDb)} дБ</div>
          <div className="muted">голос {num(d.audio.vad, 2)}</div>
          <div className="muted">на срабатывание не влияет</div>
        </div>
      </div>
      <div className={`chain-verdict ${cond.fired ? 'ok' : ''}`}>{result}</div>
    </div>
  );
}
