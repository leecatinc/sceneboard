import Link from 'next/link';

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 6.5h13.5a3 3 0 0 1 3 3V25.5H10a3 3 0 0 1-3-3v-16Z" />
      <path
        className="brand-spark"
        d="M24 2c.55 3.72 2.28 5.45 6 6-3.72.55-5.45 2.28-6 6-.55-3.72-2.28-5.45-6-6 3.72-.55 5.45-2.28 6-6Z"
      />
    </svg>
  );
}

export function Brand({
  linked = false,
  label = 'SceneBoard boards',
}: {
  linked?: boolean;
  label?: string;
}) {
  const content = (
    <>
      <BrandMark />
      SceneBoard
    </>
  );
  return linked ? (
    <Link className="brand" href="/boards" aria-label={label}>
      {content}
    </Link>
  ) : (
    <div className="brand">{content}</div>
  );
}
