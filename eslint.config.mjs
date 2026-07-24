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
      'apps/chrome-extension/**/*.{ts,tsx}',
      'apps/native-messaging-host/**/*.{ts,tsx}',
      'apps/skill-share-worker/**/*.{ts,tsx}',
      'packages/protocol/**/*.{ts,tsx}',
      'packages/cli/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          path.join(repoRoot, 'apps/backend/tsconfig.eslint.json'),
          path.join(repoRoot, 'apps/ui/tsconfig.json'),
          path.join(repoRoot, 'apps/electron/tsconfig.eslint.json'),
          path.join(repoRoot, 'apps/chrome-extension/tsconfig.eslint.json'),
          path.join(repoRoot, 'apps/native-messaging-host/tsconfig.eslint.json'),
          path.join(repoRoot, 'apps/skill-share-worker/tsconfig.eslint.json'),
          path.join(repoRoot, 'packages/protocol/tsconfig.eslint.json'),
          path.join(repoRoot, 'packages/cli/tsconfig.eslint.json'),
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
  {
    // SwarmManager is the composition root behind a stateless inherited facade,
    // not the default owner for new feature workflows or mutable state. These error-level
    // limits ratchet the current extraction forward: when the file or its
    // constructor shrinks, lower the matching maximum to the new raw line
    // count. Do not raise either limit to land a feature; move that feature to
    // a cohesive owner behind the facade instead.
    files: ['apps/backend/src/swarm/swarm-manager.ts'],
    rules: {
      'max-lines': [
        'error',
        {
          max: 1400,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
      'max-lines-per-function': [
        'error',
        {
          max: 301,
          skipBlankLines: false,
          skipComments: false,
          IIFEs: true,
        },
      ],
    },
  },
  {
    // Keep the explicit manager application API below the repository's preferred
    // file ceiling. Lower this exact ratchet whenever facade methods move to a
    // more cohesive supported surface; never raise it to expose owner internals.
    files: ['apps/backend/src/swarm/swarm-manager-facade.ts'],
    rules: {
      'max-lines': [
        'error',
        {
          max: 1454,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
    },
  },
  {
    // Runtime construction order is intentionally explicit but must not become
    // another monolith. Lower this exact ratchet after further extractions.
    files: ['apps/backend/src/swarm/swarm-manager-runtime-composition.ts'],
    rules: {
      'max-lines': [
        'error',
        {
          max: 1014,
          skipBlankLines: false,
          skipComments: false,
        },
      ],
    },
  },
  {
    // Guard against new hand-rolled atomic-file and timeout helpers in the
    // backend. Shared helpers live in apps/backend/src/utils/: atomic-files.ts
    // (writeFileAtomic, writeJsonFileAtomic, updateJsonFileAtomic) covers
    // temp+rename JSON persistence, and appendJsonl/withTimeout land there via
    // WP-F2 — use those instead of a new local implementation. Warn-level so
    // this doesn't block the build ahead of WP-F2 landing; migrating existing
    // call sites is tracked separately (roadmap 3.3).
    files: ['apps/backend/**/*.{ts,tsx}'],
    ignores: [
      'apps/backend/src/utils/**',
      'apps/backend/src/swarm/retry-rename.ts',
      'apps/backend/src/swarm/storage/retry-rename.ts',
      'apps/backend/**/*.test.ts',
      'apps/backend/**/__tests__/**',
      // Pre-existing hand-rolled sites inventoried by the structure review
      // (roadmap 1.6/3.3). Excluded here rather than migrated so this rule
      // lands warn-level without breaking `--max-warnings 0`; the migration
      // itself is the separate Group 3.3 follow-up. Remove an entry from this
      // list once its file adopts the shared helper.
      'apps/backend/src/observability/observability-settings.ts',
      'apps/backend/src/stats/provider-usage-history.ts',
      'apps/backend/src/swarm/agents/specialists/specialist-registry.ts',
      'apps/backend/src/swarm/catalog/model-catalog-projection.ts',
      'apps/backend/src/swarm/feedback-service.ts',
      'apps/backend/src/swarm/model-cache-visualization-settings.ts',
      'apps/backend/src/swarm/project-resource-settings.ts',
      'apps/backend/src/swarm/runtime/claude/claude-query-session.ts',
      'apps/backend/src/swarm/runtime/pi-agent-runtime.ts',
      'apps/backend/src/swarm/session/history-cache-store.ts',
      'apps/backend/src/swarm/session/message-pins.ts',
      'apps/backend/src/swarm/storage/project-agent-storage.ts',
      'apps/backend/src/terminal/terminal-persistence.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.name='rename'], CallExpression[callee.property.name='rename']",
          message:
            'Hand-rolled temp+rename detected. Use writeFileAtomic/writeJsonFileAtomic from apps/backend/src/utils/atomic-files.ts instead of a local rename() call.',
        },
        {
          selector:
            "FunctionDeclaration[id.name=/^withTimeout$/i], VariableDeclarator[id.name=/^withTimeout$/i]",
          message:
            'Local withTimeout implementation detected. Use the shared timeout helper in apps/backend/src/utils/ (added by WP-F2) instead of a new local copy.',
        },
        {
          selector:
            "FunctionDeclaration[id.name=/^appendJsonl$/i], VariableDeclarator[id.name=/^appendJsonl$/i]",
          message:
            'Local appendJsonl implementation detected. Use the shared appendJsonl helper in apps/backend/src/utils/ (added by WP-F2) instead of a new local copy.',
        },
      ],
    },
  },
);
