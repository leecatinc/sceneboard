import { isIP } from 'node:net';

export type ForwardingState =
  | 'direct'
  | 'ignored_untrusted_peer'
  | 'trusted_chain'
  | 'malformed_fallback';

export interface ResolvedClientIp {
  address: string;
  forwardingState: ForwardingState;
}

const parseIpv4 = (address: string): Uint8Array | null => {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part)))
    return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return Uint8Array.from(numbers);
};

const mappedIpv4 = (address: string): string | null => {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match?.[1] !== undefined && parseIpv4(match[1]) ? match[1] : null;
};

const normalizeAddress = (address: string): string | null => {
  const mapped = mappedIpv4(address);
  if (mapped) return mapped;
  if (parseIpv4(address)) return address;
  if (isIP(address) === 6) return address.toLowerCase();
  return null;
};

const parseIpv6 = (address: string): Uint8Array | null => {
  const normalized = normalizeAddress(address);
  if (!normalized || isIP(normalized) !== 6) return null;
  const doubleColon = normalized.indexOf('::');
  if (doubleColon !== normalized.lastIndexOf('::')) return null;
  const leftSource = doubleColon >= 0 ? normalized.slice(0, doubleColon) : normalized;
  const rightSource = doubleColon >= 0 ? normalized.slice(doubleColon + 2) : '';
  const expand = (source: string): number[] | null => {
    if (source === '') return [];
    const groups = source.split(':');
    const output: number[] = [];
    for (const group of groups) {
      const ipv4 = parseIpv4(group);
      if (ipv4) {
        output.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      output.push(Number.parseInt(group, 16));
    }
    return output;
  };
  const left = expand(leftSource);
  const right = expand(rightSource);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((doubleColon < 0 && missing !== 0) || (doubleColon >= 0 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
};

const parseIp = (address: string): Uint8Array | null =>
  parseIpv4(normalizeAddress(address) ?? '') ?? parseIpv6(address);

const cidrContains = (cidr: string, address: string): boolean => {
  const separator = cidr.lastIndexOf('/');
  if (separator <= 0) return false;
  const network = parseIp(cidr.slice(0, separator));
  const candidate = parseIp(address);
  const prefixSource = cidr.slice(separator + 1);
  if (
    !network ||
    !candidate ||
    network.byteLength !== candidate.byteLength ||
    !/^(?:0|[1-9][0-9]*)$/.test(prefixSource)
  )
    return false;
  const prefix = Number(prefixSource);
  if (prefix > network.byteLength * 8) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remainder = prefix % 8;
  for (let index = 0; index < fullBytes; index += 1)
    if (network[index] !== candidate[index]) return false;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (network[fullBytes]! & mask) === (candidate[fullBytes]! & mask);
};

const isTrusted = (address: string, cidrs: readonly string[]): boolean =>
  cidrs.some((cidr) => cidrContains(cidr, address));

export const resolveClientIp = (input: {
  socketAddress: string;
  xForwardedFor?: string | undefined;
  trustedProxyCidrs: readonly string[];
}): ResolvedClientIp => {
  const socketAddress = normalizeAddress(input.socketAddress);
  if (!socketAddress) throw new TypeError('socket address must be an IP literal');
  if (!isTrusted(socketAddress, input.trustedProxyCidrs)) {
    return {
      address: socketAddress,
      forwardingState: input.xForwardedFor === undefined ? 'direct' : 'ignored_untrusted_peer',
    };
  }
  if (input.xForwardedFor === undefined || input.xForwardedFor === '') {
    return { address: socketAddress, forwardingState: 'direct' };
  }
  const forwarded = input.xForwardedFor.split(',').map((part) => part.trim());
  if (forwarded.length > 8 || forwarded.some((part) => part === '')) {
    return { address: socketAddress, forwardingState: 'malformed_fallback' };
  }
  const normalized = forwarded.map(normalizeAddress);
  if (normalized.some((address) => address === null)) {
    return { address: socketAddress, forwardingState: 'malformed_fallback' };
  }
  let current = socketAddress;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (!isTrusted(current, input.trustedProxyCidrs)) break;
    current = normalized[index]!;
  }
  return { address: current, forwardingState: 'trusted_chain' };
};

const formatIpv6 = (bytes: Uint8Array): string => {
  const groups = Array.from(
    { length: 8 },
    (_, index) => (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!,
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(':');
  const left = groups
    .slice(0, bestStart)
    .map((group) => group.toString(16))
    .join(':');
  const right = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16))
    .join(':');
  return `${left}::${right}`;
};

export const maskClientIpPrefix = (address: string): string => {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new TypeError('address must be an IP literal');
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  const ipv6 = parseIpv6(normalized);
  if (!ipv6) throw new TypeError('address must be an IP literal');
  const masked = Uint8Array.from(ipv6);
  masked[7] = 0;
  masked.fill(0, 8);
  return `${formatIpv6(masked)}/56`;
};
