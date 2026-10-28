import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument, OPENAPI_VERSION } from '../packages/contracts/src/index';

/**
 * Regenerates docs/architecture/openapi.json from the zod contracts
 * (ADR-0005). CI gate: `npm run openapi:check` fails on drift.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'docs', 'architecture', 'openapi.json');

const doc = buildOpenApiDocument();

// Structural assertions before writing (never commit a broken contract)
if (doc.openapi !== OPENAPI_VERSION)
  throw new Error(`unexpected openapi version: ${String(doc.openapi)}`);
if (!doc.paths || Object.keys(doc.paths as object).length === 0) {
  throw new Error('openapi document has no paths');
}
const components = doc.components as { schemas?: Record<string, unknown> } | undefined;
if (!components?.schemas?.ErrorEnvelope) throw new Error('ErrorEnvelope component missing');

writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(
  `wrote ${path.relative(root, outFile)} (${Object.keys(doc.paths as object).length} paths)`,
);
