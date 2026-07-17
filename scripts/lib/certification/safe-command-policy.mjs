import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CertificationError } from './canonical-json.mjs';

const forbiddenToken = /(?:^|\s)(?:npx|sudo|docker|kubectl|terraform|rm|rmdir|git\s+(?:clean|reset|checkout|restore)|mysqladmin\s+drop|redis-cli\s+FLUSH(?:ALL|DB))\b/iu;
const shellSyntax = /[;&|`<>\n\r]|\$\(/u;

export const assertSafeCommand = ({ command, args = [], workspaceRoot, allowDependencyInstall = false }) => {
  if (typeof command !== 'string' || !Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new CertificationError('FORBIDDEN_CERTIFICATION_COMMAND');
  }
  const rendered = [command, ...args].join(' ');
  if (shellSyntax.test(rendered) || forbiddenToken.test(rendered) || /(?:^|[=:/_-])production(?:$|[=:/_-])/iu.test(rendered)) {
    throw new CertificationError('FORBIDDEN_CERTIFICATION_COMMAND');
  }
  if (command === 'npm') {
    if (args[0] === '--version') return { command, args };
    if (args[0] === 'run' && typeof args[1] === 'string' && args[1].length > 0) return { command, args };
    if (args[0] === 'ci' && allowDependencyInstall
      && args.includes('--no-audit') && args.includes('--no-fund')) return { command, args };
    throw new CertificationError('FORBIDDEN_CERTIFICATION_COMMAND');
  }
  if (command === process.execPath && args[0]?.startsWith('scripts/')) return { command, args };
  if (isAbsolute(command)) {
    const binRoot = resolve(workspaceRoot, 'node_modules/.bin');
    const offset = relative(binRoot, command);
    if (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) return { command, args };
  }
  throw new CertificationError('FORBIDDEN_CERTIFICATION_COMMAND');
};
