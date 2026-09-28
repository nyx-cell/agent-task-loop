import { defineConfig } from '@rslib/core';
import { libConfig } from '@rivus/rslib-config/lib.config';

export default defineConfig({
  ...libConfig,
  source: { entry: { index: 'src/index.ts', acp: 'src/acp.ts' } },
});
