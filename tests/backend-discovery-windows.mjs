// Run with native Windows Node after building packages/backend-adapter.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentManagerBackendAdapter} from '../packages/backend-adapter/dist/index.mjs';
if(process.platform!=='win32')throw Error('This regression requires native Windows');
const directory=await mkdtemp(join(tmpdir(),'backend-discovery-'));
const previousPath=process.env.PATH;
try{
  await writeFile(join(directory,'omp.exe'),'discovery fixture; never execute');
  process.env.Path=directory;
  assert.deepEqual((await new AgentManagerBackendAdapter().discover()).map(c=>c.id),['omp']);
  for(const name of ['PATH','Path','pAtH']){
    const adapter=new AgentManagerBackendAdapter({environment:{[name]:directory}});
    assert.deepEqual((await adapter.discover()).map(c=>c.id),['omp']);
    assert.deepEqual(await new AgentManagerBackendAdapter({environment:{[name]:''}}).discover(),[]);
  }
  console.log('PASS: native Windows Path discovery, case-insensitive overrides, explicit empty override');
}finally{
  if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
  await rm(directory,{recursive:true,force:true});
}
