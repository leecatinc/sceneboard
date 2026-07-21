import type { NextPageContext } from 'next';

function ErrorPage({ statusCode }: { statusCode: number }) {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        gap: '0.5rem',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700 }}>{statusCode || 'Error'}</h1>
      <p>{statusCode === 404 ? 'Page not found.' : 'Something went wrong.'}</p>
    </main>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
