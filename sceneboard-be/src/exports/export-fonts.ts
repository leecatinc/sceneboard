import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { ExportFontResourceV1 } from './export-projection.service.js';

const require = createRequire(import.meta.url);

const LOCKED_FONTS_V1 = Object.freeze([
  Object.freeze({
    path: '@fontsource/noto-sans-kr/files/noto-sans-kr-korean-400-normal.woff2',
    sha256: '2d289d2d456dbd2c7764384ed40c7a98c630fdda50b0a9e6f751533727ec59fe',
    subset: 'korean' as const,
  }),
  Object.freeze({
    path: '@fontsource/noto-sans-kr/files/noto-sans-kr-latin-400-normal.woff2',
    sha256: '00b30a809a30a8ce77c4ca4a6f3b0216526ca910b37fc75a528253ab3b96acad',
    subset: 'latin' as const,
  }),
]);

export const loadExportFontResourcesV1 = (): readonly ExportFontResourceV1[] =>
  Object.freeze(
    LOCKED_FONTS_V1.map((locked) => {
      const bytes = readFileSync(require.resolve(locked.path));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== locked.sha256)
        throw new TypeError(`locked export font digest mismatch: ${locked.subset}`);
      return Object.freeze({
        sha256: locked.sha256,
        bytes,
        subset: locked.subset,
      });
    }),
  );
