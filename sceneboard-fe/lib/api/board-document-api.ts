'use client';

import type { BoardDocumentV2, PageId } from '@sceneboard/board-schema';
import { applyDocumentTransformV2 } from '@sceneboard/board-sdk/document-transform';

import { BoardApiTransport } from './board-api-core';
import type { AuthoringGenerationBindingV1 } from '../auth/renewal-singleflight';
import type {
  ApiResult,
  BrowserDocumentMutationInput,
  DocumentMutationRequest,
  DocumentMutationRequestV3,
  DocumentMutationResult,
  DocumentMutationResultV3,
} from './board-api-types';

export class BoardDocumentApi extends BoardApiTransport {
  replace(
    request: DocumentMutationRequest,
    signal?: AbortSignal,
  ): Promise<ApiResult<DocumentMutationResult>> {
    return this.writeDocumentMutation(request, signal);
  }

  replaceV3(
    request: DocumentMutationRequestV3,
    signal?: AbortSignal,
  ): Promise<ApiResult<DocumentMutationResultV3>> {
    return this.writeDocumentMutationV3(request, signal);
  }

  transform(
    input: BrowserDocumentMutationInput,
    signal?: AbortSignal,
  ): Promise<ApiResult<DocumentMutationResult>> {
    const transformed = applyDocumentTransformV2(input.source, input.operation);
    if (!transformed.ok) return Promise.resolve({ kind: 'board_error', error: transformed.error });
    return this.writeDocumentMutation(
      {
        ...input.request,
        command: { type: 'document.replace', document: transformed.data.value },
      },
      signal,
    );
  }

  replaceForGeneration(
    binding: AuthoringGenerationBindingV1,
    request: DocumentMutationRequest,
    signal?: AbortSignal,
  ) {
    return this.writeDocumentMutationForGeneration(binding, request, signal);
  }

  replaceV3ForGeneration(
    binding: AuthoringGenerationBindingV1,
    request: DocumentMutationRequestV3,
    signal?: AbortSignal,
  ) {
    return this.writeDocumentMutationV3ForGeneration(binding, request, signal);
  }
}

export const resolveSelectedDocumentPageIdV2 = (
  document: BoardDocumentV2,
  selectedPageId: PageId | null,
): PageId => {
  if (selectedPageId !== null && document.pages.some((page) => page.pageId === selectedPageId))
    return selectedPageId;
  return document.defaultPageId;
};
