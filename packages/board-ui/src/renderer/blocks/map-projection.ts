export const projectMapPositionV1 = (
  position: readonly [number, number],
  viewport: { longitude: number; latitude: number; zoom: number },
): { x: number; y: number; visible: boolean } => {
  const scale = Math.max(1, 2 ** Math.min(viewport.zoom, 8));
  const x = 50 + ((position[0] - viewport.longitude) / 360) * 100 * scale;
  const y = 50 - ((position[1] - viewport.latitude) / 180) * 100 * scale;
  return {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y)),
    visible: Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 100,
  };
};
