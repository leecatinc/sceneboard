import { createHmac, hkdfSync } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { BoardId, EventId, TabId } from '@leecat-board/board-schema';

const SALT = Buffer.from('leecat-board/stream/v1', 'ascii');

const derive = (material: Buffer, info: string): Buffer => Buffer.from(
  hkdfSync('sha256', material, SALT, Buffer.from(info, 'ascii'), 32),
);

const u32be = (value: number): Buffer => {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value);
  return output;
};

const taggedText = (tag: string, value: string): Buffer => {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(`${tag}\0`, 'ascii'), u32be(encoded.byteLength), encoded]);
};

const fingerprint = (key: Buffer, input: Buffer): string => (
  createHmac('sha256', key).update(input).digest().subarray(0, 16).toString('base64url')
);

@Injectable()
export class RedisStreamKeyspace {
  readonly #cursorKey: Buffer;
  readonly #boardKey: Buffer;
  readonly #principalKey: Buffer;
  readonly #eventKey: Buffer;
  readonly #trustedIpKey: Buffer;

  constructor(
    material: Buffer,
    private readonly prefix = 'leecat_board:',
  ) {
    if (material.byteLength !== 32) throw new TypeError('stream key material must be exactly 32 bytes');
    if (prefix !== 'leecat_board:') throw new TypeError('stream Redis prefix must be leecat_board:');
    this.#cursorKey = derive(material, 'sse-resume-cursor/v1');
    this.#boardKey = derive(material, 'fingerprint-board/v1');
    this.#principalKey = derive(material, 'fingerprint-principal/v1');
    this.#eventKey = derive(material, 'fingerprint-event/v1');
    this.#trustedIpKey = derive(material, 'fingerprint-trusted-ip/v1');
    material.fill(0);
  }

  cursorKey(): Buffer {
    return Buffer.from(this.#cursorKey);
  }

  boardFingerprint(boardId: BoardId): string {
    return fingerprint(this.#boardKey, taggedText('board', boardId));
  }

  principalFingerprint(ownerUserPk: bigint): string {
    if (ownerUserPk < 1n || ownerUserPk > 0xffff_ffff_ffff_ffffn) throw new TypeError('ownerUserPk is outside uint64');
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeBigUInt64BE(ownerUserPk);
    return fingerprint(this.#principalKey, Buffer.concat([Buffer.from('owner-user-pk\0', 'ascii'), bytes]));
  }

  eventFingerprint(eventId: EventId): string {
    return fingerprint(this.#eventKey, taggedText('event', eventId));
  }

  trustedIpFingerprint(normalizedPrefix: string): string {
    return fingerprint(this.#trustedIpKey, taggedText('trusted-ip', normalizedPrefix));
  }

  boardHintChannel(boardId: BoardId): string {
    return `${this.prefix}stream:events:v1:${this.boardFingerprint(boardId)}`;
  }

  eventLeaseKey(eventId: EventId): string {
    return `${this.prefix}stream:dispatch:v1:${this.eventFingerprint(eventId)}`;
  }

  presenceVersionKey(boardId: BoardId): string {
    return `${this.prefix}stream:presence-version:v1:${this.boardFingerprint(boardId)}`;
  }

  presenceConnectionKey(boardId: BoardId, ownerUserPk: bigint, tabId: TabId): string {
    if (!/^[A-Za-z0-9_-]{22}$/u.test(tabId)) throw new TypeError('presence tab ID is invalid');
    return `${this.prefix}stream:presence:v1:${this.boardFingerprint(boardId)}:${this.principalFingerprint(ownerUserPk)}:${tabId}`;
  }

  presenceIndexKey(boardId: BoardId): string {
    return `${this.prefix}stream:presence-index:v1:${this.boardFingerprint(boardId)}`;
  }

  presenceActiveKey(): string {
    return `${this.prefix}stream:presence-active:v1`;
  }

  presenceConcurrencyKey(boardId: BoardId, ownerUserPk: bigint): string {
    return `${this.prefix}stream:concurrency:v1:${this.boardFingerprint(boardId)}:${this.principalFingerprint(ownerUserPk)}`;
  }
}
