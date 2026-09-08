import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/installer-tools.ts', 'src/installer-system-prompt.ts', 'src/management-system-prompt.ts'],
  format: 'esm',
  dts: true,
  sourcemap: true,
})
