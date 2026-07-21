import type { NodeTypeV1 } from '@sceneboard/board-schema';
import { ArtifactPlaceholderBlock } from './blocks/ArtifactPlaceholderBlock.js';
import { ChartBlock } from './blocks/ChartBlock.js';
import { CodeBlock } from './blocks/CodeBlock.js';
import { DrawingBlock } from './blocks/DrawingBlock.js';
import { HitlPlaceholderBlock } from './blocks/HitlPlaceholderBlock.js';
import { ImageBlock } from './blocks/ImageBlock.js';
import { MapBlock } from './blocks/MapBlock.js';
import { MarkdownBlock } from './blocks/MarkdownBlock.js';
import { ProgressBlock } from './blocks/ProgressBlock.js';
import { StatusBlock } from './blocks/StatusBlock.js';
import { TableBlock } from './blocks/TableBlock.js';
import { CanvasLayout } from './layouts/CanvasLayout.js';
import { GridLayout } from './layouts/GridLayout.js';
import { SplitLayout } from './layouts/SplitLayout.js';
import { TabsLayout } from './layouts/TabsLayout.js';
import type { RendererComponentV1 } from './renderer-types.js';

type RendererRegistryV1 = {
  [K in NodeTypeV1]: RendererComponentV1<K>;
};

export const RENDERER_REGISTRY_V1 = {
  'layout.split': SplitLayout,
  'layout.grid': GridLayout,
  'layout.tabs': TabsLayout,
  'layout.canvas': CanvasLayout,
  'content.markdown': MarkdownBlock,
  'content.code': CodeBlock,
  'content.table': TableBlock,
  'content.chart': ChartBlock,
  'content.map': MapBlock,
  'content.drawing': DrawingBlock,
  'content.status': StatusBlock,
  'content.image': ImageBlock,
  'content.progress': ProgressBlock,
  'content.hitl': HitlPlaceholderBlock,
  'content.artifact': ArtifactPlaceholderBlock,
} satisfies RendererRegistryV1;
