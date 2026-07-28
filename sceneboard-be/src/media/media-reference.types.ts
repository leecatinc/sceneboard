import {
  MediaIdParserV1,
  PageIdParserV1,
  type BoardId,
  type MediaId,
  type PageId,
  type RevisionId,
} from '@sceneboard/board-schema';

export interface RevisionMediaReferenceRowV1 {
  boardId: BoardId;
  revisionId: RevisionId;
  firstPageId: PageId;
  mediaId: MediaId;
  ordinal: number;
}

const encodeAsciiId = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'ascii');
  if (bytes.toString('ascii') !== value) throw new TypeError('public ID is not exact ASCII');
  return bytes;
};

export const encodeMediaIdForStorage = (value: MediaId): Buffer => encodeAsciiId(value);
export const encodePageIdForStorage = (value: PageId): Buffer => encodeAsciiId(value);

export const decodeMediaIdFromStorage = (value: Uint8Array): MediaId => {
  const source = Buffer.from(value).toString('ascii');
  const parsed = MediaIdParserV1.parse(source);
  if (!parsed.ok || !Buffer.from(value).equals(Buffer.from(source, 'ascii'))) {
    throw new TypeError('stored media ID is invalid');
  }
  return parsed.data.value;
};

export const decodePageIdFromStorage = (value: Uint8Array): PageId => {
  const source = Buffer.from(value).toString('ascii');
  const parsed = PageIdParserV1.parse(source);
  if (!parsed.ok || !Buffer.from(value).equals(Buffer.from(source, 'ascii'))) {
    throw new TypeError('stored page ID is invalid');
  }
  return parsed.data.value;
};
