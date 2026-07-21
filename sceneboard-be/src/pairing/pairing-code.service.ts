import { AppError } from '../common/errors/app-error.js';
import { CryptoService } from '../common/security/crypto.service.js';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_CODE_PREFIX = 'SB-';
const PAIRING_PATTERN = /^(?:SB-)?([0-9A-HJKMNP-TV-Z]{6})-([0-9A-HJKMNP-TV-Z]{6})$/;

export interface IssuedPairingCode {
  code: string;
  locatorHash: Buffer;
  verifierHash: Buffer;
}

export interface ParsedPairingCode {
  locator: string;
  verifier: string;
}

export interface HashedPairingCode {
  locatorHash: Buffer;
  verifierHash: Buffer;
}

const encodeThirtyBits = (bytes: Buffer): string => {
  if (bytes.byteLength !== 4) throw new TypeError('pairing half requires four random bytes');
  let value = bytes.readUInt32BE(0) & 0x3fff_ffff;
  let output = '';
  for (let index = 0; index < 6; index += 1) {
    output = CROCKFORD_ALPHABET[value & 31]! + output;
    value >>>= 5;
  }
  return output;
};

export class PairingCodeService {
  constructor(private readonly crypto: CryptoService) {}

  issue(): IssuedPairingCode {
    const locator = encodeThirtyBits(this.crypto.random(4));
    const verifier = encodeThirtyBits(this.crypto.random(4));
    return {
      code: `${PAIRING_CODE_PREFIX}${locator}-${verifier}`,
      locatorHash: this.crypto.hmac('pairing-locator/v1', locator),
      verifierHash: this.crypto.hmac('pairing-verifier/v1', verifier),
    };
  }

  parse(value: string): ParsedPairingCode {
    const normalized = value.toUpperCase();
    const matched = PAIRING_PATTERN.exec(normalized);
    if (matched === null) throw new AppError('PAIRING_UNAVAILABLE');
    return { locator: matched[1]!, verifier: matched[2]! };
  }

  hash(parsed: ParsedPairingCode): HashedPairingCode {
    return {
      locatorHash: this.crypto.hmac('pairing-locator/v1', parsed.locator),
      verifierHash: this.crypto.hmac('pairing-verifier/v1', parsed.verifier),
    };
  }

  verify(parsed: ParsedPairingCode, locatorHash: Uint8Array, verifierHash: Uint8Array): boolean {
    return (
      this.crypto.constantTimeEqual(
        this.crypto.hmac('pairing-locator/v1', parsed.locator),
        locatorHash,
      ) &&
      this.crypto.constantTimeEqual(
        this.crypto.hmac('pairing-verifier/v1', parsed.verifier),
        verifierHash,
      )
    );
  }
}
