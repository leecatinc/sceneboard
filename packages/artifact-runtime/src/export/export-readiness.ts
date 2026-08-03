export type ExportReadinessResultV1 =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: 'unsupported' | 'pending' }>;

export const inspectExportReadinessV1 = (root: ParentNode): ExportReadinessResultV1 => {
  if (root.querySelector('[data-export-unsupported]') !== null)
    return Object.freeze({ ready: false, reason: 'unsupported' });
  if (root.querySelector('[data-export-pending]') !== null)
    return Object.freeze({ ready: false, reason: 'pending' });
  const images = [...root.querySelectorAll('img')];
  if (images.some((image) => !image.complete || image.naturalWidth < 1))
    return Object.freeze({ ready: false, reason: 'pending' });
  const artifacts = [...root.querySelectorAll('[data-artifact-capture]')];
  if (artifacts.some((artifact) => !artifact.classList.contains('artifact-active')))
    return Object.freeze({ ready: false, reason: 'pending' });
  return Object.freeze({ ready: true });
};
