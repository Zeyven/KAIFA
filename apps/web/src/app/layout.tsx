import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '澜序 LanXu StoreOS',
  description: '门店运营操作系统 — FrontDesk / Manager / Boss / Staff',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
