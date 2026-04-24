import { createRequire } from 'node:module';
import tsParser from '@typescript-eslint/parser';

const require = createRequire(import.meta.url);
const brandAngularDepsMatchRule = require('./tools/eslint-rules/brand-angular-deps-match.cjs');
const noDirectAngularClassExportRule = require('./tools/eslint-rules/no-direct-angular-class-export.cjs');
const noAngularInjectRule = require('./tools/eslint-rules/no-angular-inject.cjs');

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'brand-angular-deps': {
        rules: {
          'match-component-deps': brandAngularDepsMatchRule,
          'no-direct-angular-class-export': noDirectAngularClassExportRule,
          'no-angular-inject': noAngularInjectRule,
        },
      },
    },
    rules: {
      'brand-angular-deps/match-component-deps': 'error',
      'brand-angular-deps/no-direct-angular-class-export': 'error',
      'brand-angular-deps/no-angular-inject': 'error',
    },
  },
];
