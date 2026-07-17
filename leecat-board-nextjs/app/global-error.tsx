'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: '0.75rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Something went wrong</h1>
          <button onClick={() => reset()} style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}>Try again</button>
        </main>
      </body>
    </html>
  );
}
