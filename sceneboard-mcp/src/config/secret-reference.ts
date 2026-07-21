import { isAbsolute, join } from 'node:path';

import { BoardConfigError, type BoardConfigFileV1 } from './board-config.js';

export type SecretReferenceResolutionV1 =
  | { kind: 'environment'; variable: 'SCENEBOARD_ACCESS_TOKEN' }
  | { kind: 'store'; profile: string; stateDirectory: string };

export const resolveSecretReferenceV1 = (
  config: BoardConfigFileV1,
  env: NodeJS.ProcessEnv,
): SecretReferenceResolutionV1 => {
  if (config.accessTokenRef === 'env://SCENEBOARD_ACCESS_TOKEN') {
    return { kind: 'environment', variable: 'SCENEBOARD_ACCESS_TOKEN' };
  }
  if (env.SCENEBOARD_ACCESS_TOKEN !== undefined && env.SCENEBOARD_ACCESS_TOKEN !== '') {
    throw new BoardConfigError(null, 'accessTokenRef');
  }
  let root: string;
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== '') {
    if (!isAbsolute(env.XDG_STATE_HOME)) throw new BoardConfigError(null, 'accessTokenRef');
    root = env.XDG_STATE_HOME;
  } else {
    if (env.HOME === undefined || env.HOME === '' || !isAbsolute(env.HOME)) {
      throw new BoardConfigError(null, 'accessTokenRef');
    }
    root = join(env.HOME, '.local', 'state');
  }
  return {
    kind: 'store',
    profile: config.profile,
    stateDirectory: join(root, 'leecat-board', 'credentials', config.profile),
  };
};
