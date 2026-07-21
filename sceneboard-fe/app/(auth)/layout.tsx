import type { ReactNode } from 'react';

import { Brand } from '../../components/app/Brand';

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <main className="auth-grid" id="main-content">
      <div>
        <Brand />
        {children}
      </div>
    </main>
  );
}
