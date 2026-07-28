import { PublicShareStateParserV1, type PublicShareStateV1 } from '@sceneboard/board-schema';

export type PublicShareClientState = PublicShareStateV1;

export const decodePublicShareClientState = (input: unknown): PublicShareClientState => {
  const parsed = PublicShareStateParserV1.parse(input);
  if (!parsed.ok) throw new TypeError('public share response is corrupt');
  return parsed.data.value;
};
