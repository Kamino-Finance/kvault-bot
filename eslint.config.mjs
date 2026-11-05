import eslint from '@eslint/js';
import { fixupPluginRules } from '@eslint/compat';
import tseslint from 'typescript-eslint';
import mochaPlugin from 'eslint-plugin-mocha';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/test-ledger/',
      '**/yarn-error.log',
      '**/helm/',
      '**/deps/',
      '**/node_modules/',
      '**/tmp/',
      '**/.idea/',
      '**/.vscode',
      '**/*.md',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  mochaPlugin.configs.flat.recommended,
  {
    files: ['**/*.js', '**/*.ts'],
    plugins: {
      import: fixupPluginRules(importPlugin),
    },
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/lines-between-class-members': 'off',
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variableLike',

          custom: {
            regex: '^([Aa]ny|[Nn]umber|[Ss]tring|[Bb]oolean|[Uu]ndefined)$',
            match: false,
          },

          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',

          custom: {
            regex: '^([Aa]ny|[Nn]umber|[Ss]tring|[Bb]oolean|[Uu]ndefined)$',
            match: false,
          },

          format: ['PascalCase'],
        },
      ],
      '@typescript-eslint/no-use-before-define': 'off',
      '@typescript-eslint/no-var-requires': 'warn',
      'class-methods-use-this': 'off',
      'consistent-return': 'error',
      'default-case': 'error',
      'global-require': 'warn',
      'import/first': 'error',
      'import/order': 'error',
      'import/prefer-default-export': 'off',
      'max-classes-per-file': 'off',
      'max-len': 'off',
      'mocha/no-mocha-arrows': 'off',
      'no-await-in-loop': 'off',
      'no-case-declarations': 'off',
      'no-console': 'off',
      'no-continue': 'off',
      'no-loop-func': 'warn',
      'no-param-reassign': 'error',
      'no-plusplus': 'off',
      'no-restricted-syntax': 'off',
      'no-shadow': 'off',
      'no-trailing-spaces': [
        'error',
        {
          ignoreComments: true,
        },
      ],
      'no-underscore-dangle': 'off',
      'no-use-before-define': 'off',
    },
  }
);
