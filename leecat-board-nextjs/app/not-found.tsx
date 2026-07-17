export const dynamic = 'force-dynamic';

export default function NotFound() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: '0.5rem' }}>
      <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>404</h1>
      <p>Page not found.</p>
    </main>
  );
}
