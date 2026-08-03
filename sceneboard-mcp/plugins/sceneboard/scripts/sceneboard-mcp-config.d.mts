export interface SceneBoardStdioServer {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
}

export interface ResolvedSceneBoardServer {
  readonly source: 'project_root_mcp_json' | 'codex_config_toml' | 'production_default';
  readonly server: SceneBoardStdioServer;
}

export const PRODUCTION_API_URL: 'https://sceneboard.dev';
export const SERVER_NAME: 'sceneboard';

export function resolveSceneBoardServer(options: {
  cwd?: string;
  pluginRoot: string;
  productionApiUrl?: string;
  environment?: NodeJS.ProcessEnv;
  read?: (path: string, encoding: 'utf8') => Promise<string>;
  run?: (...args: unknown[]) => {
    status?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
}): Promise<ResolvedSceneBoardServer>;
