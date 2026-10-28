import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (pkg: string) => path.resolve(root, 'packages', pkg, 'src', 'index.ts');

/**
 * Integration tests against REAL PostgreSQL 18 (embedded binaries, ADR-0003).
 * Never SQLite, never pg-mem — lock/index/transaction semantics must match prod.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@lanxu/contracts': src('contracts'),
      '@lanxu/domain': src('domain'),
      '@lanxu/config': src('config'),
      '@lanxu/observability': src('observability'),
      '@lanxu/db': src('db'),
      '@lanxu/testkit': src('testkit'),
      '@lanxu/ui': src('ui'),
    },
  },
  test: {
    include: ['**/*.int.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
