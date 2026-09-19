import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

export default defineConfig({
  resolve: {
    alias: {
      '@dearmachine/machtiani-installer-tui': resolve('packages/tui/src/index.ts'),
      '@dearmachine/machtiani-installer-workflow': resolve('packages/workflow/src/index.ts'),
      '@dearmachine/machtiani-installer-credentials': resolve('packages/credential-adapter/src/index.ts'),
      '@dearmachine/machtiani-installer-backends': resolve('packages/backend-adapter/src/index.ts'),
      '@dearmachine/machtiani-installer-environment': resolve('packages/environment-adapter/src/index.ts'),
      '@dearmachine/machtiani-installer-products': resolve('packages/product-adapter/src/index.ts'),
    },
  },
  test: {
    // macOS's per-user TMPDIR is too long for nested Unix socket fixtures.
    // Canonicalize /tmp so realpath assertions and symlink guards agree.
    env: process.platform === 'darwin' ? { TMPDIR: realpathSync('/tmp') } : {},
    include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.snapshot.ts'],
    testTimeout: 10_000,
  },
})
