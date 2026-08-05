export const SCENEBOARD_AGENT_INSTALL_GUIDE_PATH = '/install/sceneboard-agent.md';
export const SCENEBOARD_AGENT_INSTALL_GUIDE_URL =
  'https://sceneboard.dev/install/sceneboard-agent.md';

export function resolveSceneBoardAgentInstallGuideUrl(origin: string): string {
  return new URL(SCENEBOARD_AGENT_INSTALL_GUIDE_PATH, origin).toString();
}
