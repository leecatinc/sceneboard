import {
  collectDocumentNodesV2,
  type BoardDocument,
  type BoardId,
  type RevisionId,
} from '@sceneboard/board-schema';

import { MAX_MEDIA_REFERENCES } from '@sceneboard/board-schema';
import type { RevisionMediaReferenceRowV1 } from './media-reference.types.js';

export class TooManyMediaReferencesError extends Error {
  readonly code = 'TOO_MANY_MEDIA_REFERENCES' as const;

  constructor() {
    super('too many media references');
    this.name = 'TooManyMediaReferencesError';
  }
}

export class RevisionMediaReferenceExtractor {
  extract(input: {
    boardId: BoardId;
    revisionId: RevisionId;
    document: BoardDocument;
  }): readonly RevisionMediaReferenceRowV1[] {
    const output: RevisionMediaReferenceRowV1[] = [];
    const seen = new Set<string>();
    for (const item of collectDocumentNodesV2(input.document)) {
      if (item.node.type !== 'content.image' || item.node.source.type !== 'media') continue;
      const mediaId = item.node.source.mediaId;
      if (seen.has(mediaId)) continue;
      if (seen.size >= MAX_MEDIA_REFERENCES) throw new TooManyMediaReferencesError();
      seen.add(mediaId);
      output.push({
        boardId: input.boardId,
        revisionId: input.revisionId,
        firstPageId: item.page.pageId,
        mediaId,
        ordinal: output.length + 1,
      });
    }
    return output;
  }
}
