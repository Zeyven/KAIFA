import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = (pkg: string) => path.resolve(root, 'packages', pkg, 'src', 'index.ts');

/** Unit test config: package sources via alias — no build step required. */
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
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.int.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
