const baseEnvironment = {
  BOARD_API_URL: 'https://sceneboard.dev',
  BOARD_CREDENTIAL_MODE: 'api_key',
  BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
  BOARD_PROFILE: 'sceneboard',
  BOARD_TIMEOUT_MS: '30000',
} as const;

export const buildApiKeyMcpJsonExample = (apiKey: string | null): string => {
  if (apiKey !== null && apiKey.length === 0) throw new TypeError('API key is empty');
  return JSON.stringify(
    {
      mcpServers: {
        sceneboard: {
          command: 'node',
          args: ['/absolute/path/to/sceneboard-mcp/dist/index.js'],
          env:
            apiKey === null ? baseEnvironment : { ...baseEnvironment, SCENEBOARD_API_KEY: apiKey },
          ...(apiKey === null ? { env_vars: ['SCENEBOARD_API_KEY'] } : {}),
        },
      },
    },
    null,
    2,
  );
};
