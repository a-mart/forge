import path from 'node:path';
import { fileURLToPath } from 'node:url';

import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const deadCodeRules = {
  'no-unreachable': 'error',
  'no-constant-condition': 'warn',
  'no-useless-return': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-catch': 'warn',
  'no-duplicate-case': 'error',
  'no-fallthrough': 'warn',
  'no-self-assign': 'error',
  'no-self-compare': 'warn',
  'no-template-curly-in-string': 'warn',
};

const qualityRules = {
  'no-console': 'off',
  'prefer-const': 'warn',
  'no-var': 'error',
  eqeqeq: ['warn', 'always', { null: 'ignore' }],
};

const warnifyRules = (rules = {}) =>
  Object.fromEntries(
    Object.entries(rules).map(([ruleName, ruleValue]) => {
      if (Array.isArray(ruleValue)) {
        return [ruleName, ['warn', ...ruleValue.slice(1)]];
      }

      return [ruleName, 'warn'];
    }),
  );

const reactHooksRecommended = reactHooks.configs.flat['recommended-latest'];
const reactRefreshVite = reactRefresh.configs.vite;

export default tseslint.config(
  {
    // Generated output and vendored code we do not want in baseline lint runs.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.stage/**',
      '**/.tmp-shame*/**',
      '**/release/**',
      '**/.output/**',
      'apps/ui/src/routeTree.gen.ts',
      'apps/ui/src/components/ui/**',
    ],
  },
  {
    // Shared TypeScript baseline for the monorepo workspaces.
    files: [
      'apps/backend/**/*.{ts,tsx}',
      'apps/ui/**/*.{ts,tsx}',
      'apps/electron/**/*.{ts,tsx}',
      'packages/protocol/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          path.join(repoRoot, 'apps/backend/tsconfig.eslint.json'),
          path.join(repoRoot, 'apps/ui/tsconfig.json'),
          path.join(repoRoot, 'apps/electron/tsconfig.eslint.json'),
          path.join(repoRoot, 'packages/protocol/tsconfig.eslint.json'),
        ],
        tsconfigRootDir: repoRoot,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...deadCodeRules,
      ...qualityRules,
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      'no-throw-literal': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },
  {
    // React-only linting for the SPA.
    files: ['apps/ui/**/*.{ts,tsx}'],
    plugins: {
      ...reactHooksRecommended.plugins,
      ...reactRefreshVite.plugins,
    },
    rules: {
      ...warnifyRules(reactHooksRecommended.rules),
      ...warnifyRules(reactRefreshVite.rules),
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/static-components': 'error',
    },
  },
);
