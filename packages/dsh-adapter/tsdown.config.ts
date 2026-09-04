import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['src/index.ts', 'src/installer-tools.ts'], format: 'esm', dts: true, sourcemap: true })
