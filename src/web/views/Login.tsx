import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card login" onSubmit={submit}>
      <h1>Хайлайты Twitch</h1>
      <input type="password" placeholder="Пароль" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="primary" type="submit" disabled={busy || !password}>Войти</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
