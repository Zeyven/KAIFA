'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearSession, loadSession, type SessionState } from '../../lib/api';

/**
 * FrontDesk shell: session guard + store switcher (server re-authorizes every
 * request through X-Store-Id — the switcher only changes the header, never
 * grants access by itself).
 */
export default function FrontDeskLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<SessionState | null>(null);
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState('');

  useEffect(() => {
    const s = loadSession();
    if (!s) {
      router.replace('/login');
      return;
    }
    setSession(s);
    setReady(true);
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      );
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [router]);

  if (!ready) return null;

  function switchStore(storeId: string): void {
    if (!session) return;
    const next = { ...session, storeId };
    window.localStorage.setItem('lanxu.session', JSON.stringify(next));
    setSession(next);
    router.refresh();
  }

  function logout(): void {
    clearSession();
    router.replace('/login');
  }

  return (
    <div className="fd-shell">
      <header className="fd-top">
        <div className="fd-brand">
          <strong>澜序 · 门店</strong>
          <span className="fd-clock" aria-label="当前时间">
            {clock}
          </span>
        </div>
        <nav aria-label="FrontDesk">
          <Link href="/frontdesk/rooms" className={pathname === '/frontdesk/rooms' ? 'on' : ''}>
            房态大屏
          </Link>
          <Link href="/frontdesk/clock" className={pathname === '/frontdesk/clock' ? 'on' : ''}>
            钟房
          </Link>
        </nav>
        <div className="fd-session">
          <label>
            门店
            <select
              value={session?.storeId ?? ''}
              onChange={(e) => switchStore(e.target.value)}
              aria-label="切换门店"
            >
              {(session?.stores ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.code}）
                </option>
              ))}
            </select>
          </label>
          <span className="fd-user">{session?.username}</span>
          <button type="button" onClick={logout}>
            退出
          </button>
        </div>
      </header>
      <div className="fd-body">{children}</div>
    </div>
  );
}
