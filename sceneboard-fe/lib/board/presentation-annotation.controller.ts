export type PresentationAnnotationToolV1 = 'pointer' | 'pen' | 'eraser';

export type PresentationAnnotationPointV1 = Readonly<{
  x: number;
  y: number;
}>;

export type PresentationAnnotationStrokeV1 = Readonly<{
  id: string;
  points: readonly PresentationAnnotationPointV1[];
  color: string;
  width: number;
}>;

export type PresentationAnnotationHistoryV1 = Readonly<{
  past: readonly (readonly PresentationAnnotationStrokeV1[])[];
  present: readonly PresentationAnnotationStrokeV1[];
  future: readonly (readonly PresentationAnnotationStrokeV1[])[];
}>;

export type PresentationAnnotationHistoryCommandV1 = 'undo' | 'redo';
export type PresentationAnnotationArtifactPageV1 = Readonly<{
  hostInstanceId: string;
  incarnationKey: string;
  pageId: string;
}>;
export type PresentationAnnotationGestureTransitionV1 =
  | 'tool-change'
  | 'pointer-cancel'
  | 'presentation-exit';

export const presentationAnnotationGestureDispositionV1 = (
  transition: PresentationAnnotationGestureTransitionV1,
): 'commit' | 'discard' => (transition === 'tool-change' ? 'commit' : 'discard');

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export const createPresentationAnnotationHistoryV1 = (): PresentationAnnotationHistoryV1 => ({
  past: [],
  present: [],
  future: [],
});

export const createPresentationAnnotationPageHistoryV1 = ({
  readOnly,
  externalStrokes,
}: Readonly<{
  readOnly: boolean;
  externalStrokes: readonly PresentationAnnotationStrokeV1[];
}>): PresentationAnnotationHistoryV1 => ({
  past: [],
  present: readOnly ? externalStrokes : [],
  future: [],
});

export const presentationAnnotationPageKeyV1 = (
  outerPageKey: string,
  artifactPage: PresentationAnnotationArtifactPageV1 | null,
): string =>
  artifactPage === null
    ? outerPageKey
    : [
        outerPageKey,
        'artifact-page-v1',
        artifactPage.hostInstanceId,
        artifactPage.incarnationKey,
        artifactPage.pageId,
      ].join('\u0000');

export const normalizePresentationAnnotationPointV1 = ({
  x,
  y,
  width,
  height,
}: Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>): PresentationAnnotationPointV1 => ({
  x: clampUnit(width > 0 ? x / width : 0),
  y: clampUnit(height > 0 ? y / height : 0),
});

const sameStrokeSequence = (
  left: readonly PresentationAnnotationStrokeV1[],
  right: readonly PresentationAnnotationStrokeV1[],
): boolean =>
  left.length === right.length && left.every((stroke, index) => stroke === right[index]);

export const commitPresentationAnnotationSnapshotV1 = (
  history: PresentationAnnotationHistoryV1,
  next: readonly PresentationAnnotationStrokeV1[],
): PresentationAnnotationHistoryV1 =>
  sameStrokeSequence(history.present, next)
    ? history
    : {
        past: [...history.past, history.present],
        present: next,
        future: [],
      };

export const commitPresentationAnnotationStrokeV1 = (
  history: PresentationAnnotationHistoryV1,
  stroke: PresentationAnnotationStrokeV1,
): PresentationAnnotationHistoryV1 =>
  stroke.points.length === 0
    ? history
    : commitPresentationAnnotationSnapshotV1(history, [...history.present, stroke]);

export const undoPresentationAnnotationV1 = (
  history: PresentationAnnotationHistoryV1,
): PresentationAnnotationHistoryV1 => {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
};

export const redoPresentationAnnotationV1 = (
  history: PresentationAnnotationHistoryV1,
): PresentationAnnotationHistoryV1 => {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
};

const squaredDistanceToSegment = (
  pointX: number,
  pointY: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number => {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  if (deltaX === 0 && deltaY === 0) return (pointX - startX) ** 2 + (pointY - startY) ** 2;
  const ratio = Math.min(
    1,
    Math.max(
      0,
      ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / (deltaX ** 2 + deltaY ** 2),
    ),
  );
  const nearestX = startX + ratio * deltaX;
  const nearestY = startY + ratio * deltaY;
  return (pointX - nearestX) ** 2 + (pointY - nearestY) ** 2;
};

export const presentationAnnotationStrokeIsHitV1 = ({
  stroke,
  point,
  width,
  height,
  threshold,
}: Readonly<{
  stroke: PresentationAnnotationStrokeV1;
  point: PresentationAnnotationPointV1;
  width: number;
  height: number;
  threshold: number;
}>): boolean => {
  const targetX = point.x * width;
  const targetY = point.y * height;
  const points = stroke.points;
  if (points.length === 0) return false;
  if (points.length === 1) {
    const only = points[0]!;
    return (targetX - only.x * width) ** 2 + (targetY - only.y * height) ** 2 <= threshold ** 2;
  }
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    if (
      squaredDistanceToSegment(
        targetX,
        targetY,
        start.x * width,
        start.y * height,
        end.x * width,
        end.y * height,
      ) <=
      threshold ** 2
    )
      return true;
  }
  return false;
};

export const erasePresentationAnnotationStrokesV1 = ({
  strokes,
  point,
  width,
  height,
  threshold,
}: Readonly<{
  strokes: readonly PresentationAnnotationStrokeV1[];
  point: PresentationAnnotationPointV1;
  width: number;
  height: number;
  threshold: number;
}>): readonly PresentationAnnotationStrokeV1[] => {
  const next = strokes.filter(
    (stroke) => !presentationAnnotationStrokeIsHitV1({ stroke, point, width, height, threshold }),
  );
  return next.length === strokes.length ? strokes : next;
};

export const presentationAnnotationPathV1 = (
  points: readonly PresentationAnnotationPointV1[],
  width: number,
  height: number,
): string => {
  const first = points[0];
  if (first === undefined) return '';
  const commands = [`M ${first.x * width} ${first.y * height}`];
  if (points.length === 1) commands.push(`L ${first.x * width + 0.01} ${first.y * height}`);
  else
    for (const point of points.slice(1)) commands.push(`L ${point.x * width} ${point.y * height}`);
  return commands.join(' ');
};

export const presentationAnnotationHistoryCommandV1 = ({
  key,
  ctrlKey,
  metaKey,
  shiftKey,
  altKey,
  defaultPrevented,
  isComposing,
  editableContext,
}: Readonly<{
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  editableContext: boolean;
}>): PresentationAnnotationHistoryCommandV1 | null => {
  if (defaultPrevented || isComposing || altKey || editableContext || (!ctrlKey && !metaKey))
    return null;
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'z') return shiftKey ? 'redo' : 'undo';
  if (normalizedKey === 'y' && !shiftKey) return 'redo';
  return null;
};
