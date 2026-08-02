export const MAX_ENVELOPE_BYTES = 1_048_576;
export const MAX_SCENE_BYTES = 786_432;
export const MAX_SCENE_DEPTH = 12;
export const MAX_SCENE_NODES = 500;
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_CONTAINER_ENTRIES = 10_000;
export const MAX_SPLIT_CHILDREN = 12;
export const MAX_GRID_COLUMNS = 24;
export const MAX_GRID_ROWS = 100;
export const MAX_GRID_ITEMS = 200;
export const MAX_TABS = 20;
export const MAX_CANVAS_ITEMS = 200;
export const MAX_CANVAS_EXTENT = 100_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_IMAGE_ALT_CHARS = 500;
export const MAX_MARKDOWN_CHARS = 100_000;
export const MAX_CODE_CHARS = 200_000;
export const MAX_TABLE_COLUMNS = 50;
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_CELLS = 10_000;
export const MAX_CHART_SERIES = 32;
export const MAX_CHART_POINTS = 10_000;
export const MAX_MAP_FEATURES = 5_000;
export const MAX_DRAWING_ELEMENTS = 5_000;
export const MAX_ARTIFACT_RESOURCES = 128;
export const MAX_ARTIFACT_RESOURCE_BYTES = 5_242_880;
export const MAX_ARTIFACT_TOTAL_BYTES = 10_485_760;
export const MAX_BOARD_ARTIFACTS = 100;
export const MAX_BOARD_ARTIFACT_VERSIONS = 1_000;
export const MAX_BOARD_ARTIFACT_RESOURCE_ROWS = 10_000;
export const MAX_BOARD_ARTIFACT_CHARGED_BYTES = 536_870_912;
export const MAX_HITL_OPTIONS = 50;
export const MAX_HITL_FIELDS = 50;
export const MAX_HITL_TEXT_CHARS = 60_000;
export const MAX_HITL_RESPONSE_BYTES = 65_536;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_CURSOR_CHARS = 512;
export const MAX_HITL_WAIT_MS = 30_000;
export const MAX_DOCUMENT_PAGES = 100;
export const MAX_DOCUMENT_BYTES = 20_971_520;
export const MAX_DOCUMENT_PAGE_BYTES = 1_048_576;
export const MAX_DOCUMENT_NODES = 5_000;
export const MAX_DOCUMENT_ENVELOPE_BYTES = 33_554_432;
export const MAX_MEDIA_BYTES = 10_485_760;
export const MAX_MEDIA_PIXELS = 40_000_000;
export const MAX_BOARD_MEDIA_BYTES = 536_870_912;
export const MAX_MEDIA_REFERENCES = 5_000;
export const MAX_ARTIFACT_REFERENCE_OCCURRENCES = 500;

export const BOARD_LIMITS_V1 = {
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxSceneBytes: MAX_SCENE_BYTES,
  maxSceneDepth: MAX_SCENE_DEPTH,
  maxSceneNodes: MAX_SCENE_NODES,
  maxJsonDepth: MAX_JSON_DEPTH,
  maxJsonContainerEntries: MAX_JSON_CONTAINER_ENTRIES,
  maxSplitChildren: MAX_SPLIT_CHILDREN,
  maxGridColumns: MAX_GRID_COLUMNS,
  maxGridRows: MAX_GRID_ROWS,
  maxGridItems: MAX_GRID_ITEMS,
  maxTabs: MAX_TABS,
  maxCanvasItems: MAX_CANVAS_ITEMS,
  maxCanvasExtent: MAX_CANVAS_EXTENT,
  maxTitleChars: MAX_TITLE_CHARS,
  maxImageAltChars: MAX_IMAGE_ALT_CHARS,
  maxMarkdownChars: MAX_MARKDOWN_CHARS,
  maxCodeChars: MAX_CODE_CHARS,
  maxTableColumns: MAX_TABLE_COLUMNS,
  maxTableRows: MAX_TABLE_ROWS,
  maxTableCells: MAX_TABLE_CELLS,
  maxChartSeries: MAX_CHART_SERIES,
  maxChartPoints: MAX_CHART_POINTS,
  maxMapFeatures: MAX_MAP_FEATURES,
  maxDrawingElements: MAX_DRAWING_ELEMENTS,
  maxArtifactResources: MAX_ARTIFACT_RESOURCES,
  maxArtifactResourceBytes: MAX_ARTIFACT_RESOURCE_BYTES,
  maxArtifactTotalBytes: MAX_ARTIFACT_TOTAL_BYTES,
  maxBoardArtifacts: MAX_BOARD_ARTIFACTS,
  maxBoardArtifactVersions: MAX_BOARD_ARTIFACT_VERSIONS,
  maxBoardArtifactResourceRows: MAX_BOARD_ARTIFACT_RESOURCE_ROWS,
  maxBoardArtifactChargedBytes: MAX_BOARD_ARTIFACT_CHARGED_BYTES,
  maxHitlOptions: MAX_HITL_OPTIONS,
  maxHitlFields: MAX_HITL_FIELDS,
  maxHitlTextChars: MAX_HITL_TEXT_CHARS,
  maxHitlResponseBytes: MAX_HITL_RESPONSE_BYTES,
  maxPageSize: MAX_PAGE_SIZE,
  maxPageCursorChars: MAX_PAGE_CURSOR_CHARS,
  maxHitlWaitMs: MAX_HITL_WAIT_MS,
} as const;

export type BoardLimitKeyV1 = keyof typeof BOARD_LIMITS_V1;

export const BOARD_DOCUMENT_LIMITS_V2 = {
  ...BOARD_LIMITS_V1,
  maxDocumentPages: MAX_DOCUMENT_PAGES,
  maxDocumentBytes: MAX_DOCUMENT_BYTES,
  maxDocumentPageBytes: MAX_DOCUMENT_PAGE_BYTES,
  maxDocumentNodes: MAX_DOCUMENT_NODES,
  maxDocumentEnvelopeBytes: MAX_DOCUMENT_ENVELOPE_BYTES,
  maxMediaBytes: MAX_MEDIA_BYTES,
  maxMediaPixels: MAX_MEDIA_PIXELS,
  maxBoardMediaBytes: MAX_BOARD_MEDIA_BYTES,
  maxMediaReferences: MAX_MEDIA_REFERENCES,
} as const;

export const BOARD_DOCUMENT_LIMITS_V3 = {
  ...BOARD_DOCUMENT_LIMITS_V2,
  maxArtifactReferenceOccurrences: MAX_ARTIFACT_REFERENCE_OCCURRENCES,
} as const;

export type BoardLimitKeyV2 = keyof typeof BOARD_DOCUMENT_LIMITS_V2;
export type BoardLimitKeyV3 = keyof typeof BOARD_DOCUMENT_LIMITS_V3;
