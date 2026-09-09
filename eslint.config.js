import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'data/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Fakes/mocks implementing an async interface, and test callbacks that stub one,
    // routinely have no real I/O to await — that's the point of a fake.
    files: ['src/test-utils/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);
