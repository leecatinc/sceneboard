import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import typescript from 'typescript-eslint';

const ignoredPaths = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.next-check/**',
  '**/coverage/**',
  '**/public/downloads/**',
  'sceneboard-mcp/plugins/sceneboard/runtime/index.js',
  '**/next-env.d.ts',
];

export default typescript.config(
  { ignores: ignoredPaths },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ...eslint.configs.recommended.languageOptions,
      globals: globals.node,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['e2e/**/*.{js,mjs,cjs}', 'test/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: [
      'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs',
      'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api-core.mjs',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },
  ...typescript.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ...configuration.languageOptions,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...configuration.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  })),
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  prettier,
);
