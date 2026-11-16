import { useState, type KeyboardEvent } from 'react';
import type { Profile } from '../../service/profiles';
import { DICTIONARIES, FIELDS, GROUP_LABELS, type FieldGroup } from '../../service/profileSettings';
import type { StreamStatus } from '../../service/streams';
import { api, ApiError } from '../api';
import { fromForm, toForm, type FormValues } from '../tuning';

const APPLIES = { now: 'со следующей секунды', window: 'по мере набора данных' } as const;
const GROUPS = Object.keys(GROUP_LABELS) as FieldGroup[];
const KNOWN_PATHS = new Set<string>(['name', ...FIELDS.map((f) => f.path), ...DICTIONARIES.map((d) => d.path)]);

const sameForm = (a: FormValues, b: FormValues) => Object.keys(a).every((k) => a[k] === b[k]);
const isDirty = (base: Profile, name: string, form: FormValues) => name !== base.name || !sameForm(form, toForm(base.settings));

export function ProfileEditor({ profile, streams, onSaved }: { profile: Profile; streams: StreamStatus[]; onSaved?: (p: Profile) => void }) {
  const [seen, setSeen] = useState(profile);
  const [base, setBase] = useState(profile);
  const [name, setName] = useState(profile.name);
  const [form, setForm] = useState<FormValues>(() => toForm(profile.settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = (p: Profile) => {
    setBase(p);
    setName(p.name);
    setForm(toForm(p.settings));
    setErrors({});
    setFormError('');
  };

  // Derived reset: another profile replaces the form; an outside update of the same one only if nothing is edited.
  if (seen !== profile) {
    setSeen(profile);
    if (seen.id !== profile.id) {
      reset(profile);
      setStatus('');
    } else if (seen.updatedAt !== profile.updatedAt) {
      if (isDirty(base, name, form)) setBase(profile);
      else reset(profile);
    }
  }

  const dirty = isDirty(base, name, form);
  const used = streams.filter((s) => s.profile.id === profile.id);
  const badPatterns = [...new Set(used.flatMap((s) => s.profileBadPatterns))];

  const edit = (path: string, value: string) => {
    setForm((f) => ({ ...f, [path]: value }));
    setErrors((e) => ({ ...e, [path]: '' }));
    setStatus('');
  };

  const save = async () => {
    if (!dirty || saving) return;
    setFormError('');
    setStatus('');
    const parsed = fromForm(form);
    if (!parsed.ok) {
      setErrors({ [parsed.path]: parsed.error });
      return;
    }
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
      if (path !== undefined && KNOWN_PATHS.has(path)) setErrors({ [path]: message });
      else setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      void save();
    }
  };

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
      {GROUPS.map((g) => (
        <fieldset key={g} className="card">
          <legend>{GROUP_LABELS[g]}</legend>
          {FIELDS.filter((f) => f.group === g).map((f) => (
            <div className="field" key={f.path}>
              <label htmlFor={`pf-${f.path}`}>{f.label}</label>
              <div className="field-input">
                <input
                  id={`pf-${f.path}`}
                  type="text"
                  inputMode="decimal"
                  aria-describedby={`pf-${f.path}-hint`}
                  value={form[f.path] ?? ''}
                  onChange={(e) => edit(f.path, e.target.value)}
                />
                <span className="muted unit">{f.unit}</span>
              </div>
              <div id={`pf-${f.path}-hint`} className="muted hint">{f.hint} ({APPLIES[f.applies]})</div>
              {errors[f.path] && <div className="error">{errors[f.path]}</div>}
            </div>
          ))}
        </fieldset>
      ))}
      <fieldset className="card">
        <legend>Словари</legend>
        {DICTIONARIES.map((d) => (
          <div className="field" key={d.path}>
            <label htmlFor={`pf-${d.path}`}>{d.label}</label>
            <textarea id={`pf-${d.path}`} rows={5} value={form[d.path] ?? ''} onChange={(e) => edit(d.path, e.target.value)} />
            <div className="muted hint">по шаблону на строку; действует на новые сообщения</div>
            {errors[d.path] && <div className="error">{errors[d.path]}</div>}
          </div>
        ))}
      </fieldset>
      <div className="row">
        <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>Сохранить</button>
        <button type="button" disabled={!dirty || saving} onClick={() => { reset(base); setStatus(''); }}>Отменить изменения</button>
        {status && <span className="muted">{status}</span>}
      </div>
      {formError && <div className="error">{formError}</div>}
    </div>
  );
}
