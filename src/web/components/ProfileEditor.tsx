import { useState, type KeyboardEvent } from 'react';
import type { Profile } from '../../service/profiles';
import { checkField, checkPairs, DICTIONARIES, factorySettings, FIELDS, GROUP_LABELS, type FieldDef, type FieldGroup, type ProfileSettings } from '../../service/profileSettings';
import type { StreamStatus } from '../../service/streams';
import { api, ApiError } from '../api';
import { plural } from '../format';
import { classifyMessage, fromForm, parseNumber, toForm, type FormValues } from '../tuning';
import { NumberField } from './NumberField';
import { PatternChips } from './PatternChips';

const GROUPS = (Object.keys(GROUP_LABELS) as FieldGroup[]).filter((g) => FIELDS.some((f) => f.group === g && !f.basic));
const BASIC = FIELDS.filter((f) => f.basic);
const BY_PATH = new Map(FIELDS.map((f) => [f.path, f]));
const KNOWN_PATHS = new Set<string>(['name', ...FIELDS.map((f) => f.path), ...DICTIONARIES.map((d) => d.path)]);
const PROBE_LABEL = { laugh: 'смех', reaction: 'реакция' } as const;

const changedKeys = (a: FormValues, b: FormValues) => Object.keys(a).filter((k) => a[k] !== b[k]);
const lines = (text: string | undefined) => (text ? text.split('\n') : []);
const read = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined), root);

/** `factory`: the values the service ships with; a field that differs from them gets a dot and «вернуть». */
export function ProfileEditor({ profile, streams, factory = factorySettings(), onSaved }: {
  profile: Profile; streams: StreamStatus[]; factory?: ProfileSettings; onSaved?: (p: Profile) => void;
}) {
  const [seen, setSeen] = useState(profile);
  const [base, setBase] = useState(profile);
  const [name, setName] = useState(profile.name);
  const [form, setForm] = useState<FormValues>(() => toForm(profile.settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<Partial<Record<FieldGroup, boolean>>>({});
  const [probe, setProbe] = useState('');

  const reset = (p: Profile) => {
    setBase(p);
    setName(p.name);
    setForm(toForm(p.settings));
    setErrors({});
    setFormError('');
  };

  const baseForm = toForm(base.settings);
  const unsaved = changedKeys(form, baseForm).length + (name !== base.name ? 1 : 0);
  const dirty = unsaved > 0;

  // Derived reset: another profile replaces the form; an outside update of the same one only if nothing is edited.
  if (seen !== profile) {
    setSeen(profile);
    if (seen.id !== profile.id) {
      reset(profile);
      setStatus('');
    } else if (seen.updatedAt !== profile.updatedAt) {
      if (dirty) setBase(profile);
      else reset(profile);
    }
  }

  const used = streams.filter((s) => s.profile.id === profile.id);
  const badPatterns = [...new Set(used.flatMap((s) => s.profileBadPatterns))];

  const edit = (path: string, value: string) => {
    setForm((f) => ({ ...f, [path]: value }));
    setErrors((e) => ({ ...e, [path]: '' }));
    setStatus('');
  };

  /** Shows the error at its field, opening the group that holds it. */
  const failAt = (path: string, message: string) => {
    setErrors({ [path]: message });
    const def = BY_PATH.get(path);
    if (def && !def.basic) setOpen((o) => ({ ...o, [def.group]: true }));
  };

  const save = async () => {
    if (!dirty || saving) return;
    setFormError('');
    setStatus('');
    const parsed = fromForm(form);
    if (!parsed.ok) return failAt(parsed.path, parsed.error);
    for (const def of FIELDS) {
      const problem = checkField(def, read(parsed.value, def.path));
      if (problem) return failAt(def.path, problem);
    }
    const pair = checkPairs((path) => read(parsed.value, path) as number);
    if (pair) return failAt(pair.path, pair.error);
    setErrors({});
    setSaving(true);
    try {
      const saved = await api.updateProfile(profile.id, { name, settings: parsed.value });
      setBase(saved);
      setName(saved.name);
      setForm(toForm(saved.settings));
      setStatus(used.length > 0 ? `применено к эфирам: ${used.length}` : 'сохранено');
      onSaved?.(saved);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const path = e instanceof ApiError ? e.path : undefined;
      if (path !== undefined && KNOWN_PATHS.has(path)) failAt(path, message);
      else setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLInputElement;
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type === 'text' && !t.classList.contains('probe')) {
      e.preventDefault();
      void save();
    }
  };

  const differsFromFactory = (def: FieldDef) => {
    const v = parseNumber(form[def.path] ?? '');
    const f = toForm(factory)[def.path];
    return v !== null && form[def.path] !== f && v !== parseNumber(f ?? '');
  };
  const field = (def: FieldDef) => (
    <NumberField
      key={def.path} def={def} value={form[def.path] ?? ''} factory={read(factory, def.path) as number}
      error={errors[def.path] || undefined} onChange={(text) => edit(def.path, text)}
    />
  );
  const [laughPath, reactionPath] = DICTIONARIES.map((d) => d.path) as [string, string];
  const kind = classifyMessage(probe, lines(form[laughPath]), lines(form[reactionPath]));
  const verdict: string = probe.trim() === '' ? '' : kind ? PROBE_LABEL[kind] : 'не триггер';

  return (
    <div className="profile-editor" onKeyDown={onKeyDown}>
      {used.length > 0 && (
        <div className="banner">Изменения сразу подействуют на эфиры: {used.map((s) => s.channel).join(', ')}</div>
      )}
      {badPatterns.length > 0 && (
        <div className="banner">Не используется детектором: {badPatterns.join(', ')}</div>
      )}
      <div className="field">
        <label htmlFor="pf-name">Название</label>
        <input id="pf-name" type="text" value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: '' })); setStatus(''); }} />
        {errors.name && <div className="error">{errors.name}</div>}
      </div>

      <section className="card editor-basic">
        <h3>Основное</h3>
        <p className="muted">Клип создаётся, когда чат ускорился (всплеск) и этот всплеск состоит из смеха и реакций (состав). Звук только добавляет баллы к оценке.</p>
        {BASIC.map(field)}
      </section>

      {GROUPS.map((g) => {
        const fields = FIELDS.filter((f) => f.group === g && !f.basic);
        const changed = fields.filter(differsFromFactory).length;
        return (
          <details
            key={g} className="card editor-group" open={open[g] ?? false}
            onToggle={(e) => { const now = e.currentTarget.open; setOpen((o) => (Boolean(o[g]) === now ? o : { ...o, [g]: now })); }}
          >
            <summary>{GROUP_LABELS[g]}{changed > 0 ? ` · изменено ${changed}` : ''}</summary>
            {fields.map(field)}
          </details>
        );
      })}

      <section className="card editor-words">
        <h3>Словари</h3>
        <p className="muted">Какие сообщения считаются триггерными. Один шаблон — одно слово чата; действует на новые сообщения.</p>
        {DICTIONARIES.map((d) => (
          <PatternChips
            key={d.path} label={d.label} patterns={lines(form[d.path])} bad={badPatterns}
            error={errors[d.path] || undefined} onChange={(next) => edit(d.path, next.join('\n'))}
          />
        ))}
        <div className="field">
          <label htmlFor="pf-probe">Проверить сообщение</label>
          <div className="nf-row">
            <input id="pf-probe" className="probe" type="text" placeholder="например: ахахах" value={probe} onChange={(e) => setProbe(e.target.value)} />
            <span data-testid="probe-result" className={verdict === 'не триггер' ? 'muted' : 'probe-hit'}>{verdict}</span>
          </div>
        </div>
      </section>

      {status && <div className="muted editor-status">{status}</div>}
      {formError && <div className="error">{formError}</div>}
      {dirty && (
        <div className="save-bar">
          <span>изменено {unsaved} {plural(unsaved, 'поле', 'поля', 'полей')}</span>
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>Сохранить</button>
          <button type="button" disabled={saving} onClick={() => { reset(base); setStatus(''); }}>Отменить</button>
        </div>
      )}
    </div>
  );
}
