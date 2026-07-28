import type { NextConfig } from 'next';

const canonicalOrigin = (value: string | undefined, label: string): string => {
  if (value === undefined || value.length === 0 || value !== value.trim())
    throw new TypeError(`${label} is required`);
  const url = new URL(value);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new TypeError(`${label} must be a canonical origin`);
  return value;
};

export const buildSceneBoardContentSecurityPolicyV1 = (input: {
  apiOrigin: string;
  runtimeOrigin: string;
  mediaOrigin: string;
}): string => {
  const apiOrigin = canonicalOrigin(input.apiOrigin, 'API origin');
  const runtimeOrigin = canonicalOrigin(input.runtimeOrigin, 'artifact runtime origin');
  const mediaOrigin = canonicalOrigin(input.mediaOrigin, 'media origin');
  if (apiOrigin === runtimeOrigin)
    throw new TypeError('API and artifact runtime origins must differ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `media-src 'self' ${mediaOrigin}`,
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    `frame-src ${runtimeOrigin}`,
    "frame-ancestors 'self'",
    "form-action 'self'",
    "worker-src 'none'",
  ].join('; ');
};

const config: NextConfig = {
  distDir: process.env.SCENEBOARD_NEXT_DIST_DIR === '.next-check' ? '.next-check' : '.next',
  transpilePackages: [
    '@sceneboard/board-schema',
    '@sceneboard/board-sdk',
    '@sceneboard/board-ui',
    '@sceneboard/artifact-runtime',
  ],
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.tsx', '.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return webpackConfig;
  },
  async headers() {
    const contentSecurityPolicy = buildSceneBoardContentSecurityPolicyV1({
      apiOrigin: canonicalOrigin(
        process.env.NEXT_PUBLIC_BOARD_API_URL,
        'NEXT_PUBLIC_BOARD_API_URL',
      ),
      runtimeOrigin: canonicalOrigin(
        process.env.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN,
        'NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN',
      ),
      mediaOrigin: canonicalOrigin(
        process.env.NEXT_PUBLIC_SCENEBOARD_MEDIA_ORIGIN ?? 'https://media.sceneboard.dev',
        'NEXT_PUBLIC_SCENEBOARD_MEDIA_ORIGIN',
      ),
    });
    return [
      {
        source: '/((?!s(?:/|$)).*)',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

export default config;
