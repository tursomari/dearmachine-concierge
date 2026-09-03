import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['src/index.ts', 'src/bin.ts', 'src/headless.ts', 'src/headless-bin.ts'], format: 'esm', dts: true, sourcemap: true })
