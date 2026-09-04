import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['src/index.ts', 'src/bin.ts', 'src/dsh-plugin.ts'], format: 'esm', dts: true, sourcemap: true })
