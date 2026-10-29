'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, saveSession, type StoreRef } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [orgCode, setOrgCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<{
        token: string;
        user: { id: string; username: string };
        stores: StoreRef[];
      }>('/auth/login', {
        method: 'POST',
        body: { orgCode: orgCode.trim(), username: username.trim(), password },
      });
      if (data.stores.length === 0) {
        setError('账号未绑定任何门店');
        setBusy(false);
        return;
      }
      saveSession({
        token: data.token,
        storeId: data.stores[0]!.id,
        stores: data.stores,
        username: data.user.username,
      });
      router.replace('/frontdesk/rooms');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title">澜序 · 门店登录</h1>
        <p className="sub">LanXu StoreOS — FrontDesk</p>
        <form onSubmit={onSubmit}>
          <label>
            门店组织代码
            <input
              value={orgCode}
              onChange={(e) => setOrgCode(e.target.value)}
              autoComplete="organization"
              required
            />
          </label>
          <label>
            账号
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error ? (
            <p role="alert" className="login-error">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}
