import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['src/index.ts', 'src/managed-nix.ts'], format: 'esm', dts: true, sourcemap: true })
