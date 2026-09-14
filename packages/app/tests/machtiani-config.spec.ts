import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { migrateMachtianiConfig, machtianiConfigPath } from '../src/machtiani-config.ts'

it.skipIf(!process.env.MACHTIANI_TEST_BINARY)('migrates an existing DearMachine installation once without modifying standalone configuration', async () => {
 const home = await mkdtemp(join(tmpdir(),'dm-config-import-'))
 try {
  for (const dir of ['.local/bin','.dearmachine/config','.machtiani','.config/dearmachine']) await mkdir(join(home,dir),{recursive:true})
  await symlink(process.env.MACHTIANI_TEST_BINARY!,join(home,'.local/bin/machtiani'))
  await writeFile(join(home,'.dearmachine/config/runtime.toml'),'fixture\n')
  const source=join(home,'.machtiani/config.toml')
  const original='default_model = "fixture"\n[providers.fixture]\nbase_url = "https://example.test"\napi_key = "${DEEPSEEK_API_KEY}"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\n'
  await writeFile(source,original,{mode:0o600})
  const backend=join(home,'.config/dearmachine/backends.env')
  await writeFile(backend,'DEEPSEEK_API_KEY=source-fixture\nUNRELATED_KEY=unrelated-fixture\n',{mode:0o600})
  const env={HOME:home,PATH:process.env.PATH}
  await migrateMachtianiConfig(env)
  const config=await readFile(machtianiConfigPath(home),'utf8')
  expect(config).toContain('credentials_file = "credentials.env"')
  const credentials=join(home,'.config/dearmachine/machtiani/credentials.env')
  expect(await readFile(credentials,'utf8')).toBe('DEEPSEEK_API_KEY=source-fixture\n')
  await writeFile(backend,'DEEPSEEK_API_KEY=changed-fixture\n',{mode:0o600})
  await migrateMachtianiConfig(env)
  expect(await readFile(credentials,'utf8')).toBe('DEEPSEEK_API_KEY=source-fixture\n')
  expect(await readFile(source,'utf8')).toBe(original)
 } finally {await rm(home,{recursive:true,force:true})}
})
