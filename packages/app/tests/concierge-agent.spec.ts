import { describe, it, expect, vi } from 'vitest'
import { ManagementConversation, managementInstructions, type ManagementAgent } from '../src/concierge-agent.ts'
import { ConciergeShell } from '../src/concierge-shell.ts'

describe('management conversation layering', () => {
 it('opens the agent only for natural language and supplies management instructions once', async () => {
  const agent={start:vi.fn(async()=>{}),prompt:vi.fn(async(_text:string)=>{}),interrupt:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})}
  const open=vi.fn(async()=>agent)
  const conversation=new ManagementConversation(open)
  const control={request:vi.fn(async()=>({installation:'installed' as const,supervisor:'running' as const,daemon:'running' as const,persistence:'unknown' as const}))}
  const shell=new ConciergeShell({control,say:vi.fn(),converse:text=>conversation.submit(text),ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{await conversation.close()}})
  await shell.submit('/help');await shell.submit('/up');await shell.submit('/status')
  expect(open).not.toHaveBeenCalled()
  await shell.submit('What is running?')
  await shell.submit('Stop Dear Machine')
  expect(open).toHaveBeenCalledTimes(1);expect(agent.start).toHaveBeenCalledTimes(1)
  expect(agent.prompt.mock.calls[0]![0]).toContain(managementInstructions)
  expect(agent.prompt.mock.calls[0]![0]).toContain('What is running?')
  expect(agent.prompt.mock.calls[1]![0]).toBe('Stop Dear Machine')
  await shell.submit('/quit')
  expect(agent.shutdown).toHaveBeenCalledTimes(1)
 })
 it('keeps local controls available during a hung provider request and after a failed provider setup', async () => {
  const say=vi.fn();const request=vi.fn(async()=>({installation:'installed' as const,supervisor:'stopped' as const,daemon:'stopped' as const,persistence:'unknown' as const}))
  const conversation=new ManagementConversation(async()=>{throw new Error('provider unavailable')})
  const shell=new ConciergeShell({control:{request},say,converse:text=>conversation.submit(text),ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{await conversation.close()}})
  await shell.submit('Hello');await shell.submit('/help');await shell.submit('/down')
  expect(say.mock.calls.flat().join(' ')).toContain('provider is unavailable')
  expect(request).toHaveBeenCalled()
  const hung=new ManagementConversation(async()=>({start:async()=>{},prompt:()=>new Promise(()=>{}),interrupt:async()=>{},shutdown:async()=>{}}))
  const other=new ConciergeShell({control:{request},say,converse:text=>hung.submit(text),ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{await hung.close()}})
  void other.submit('Explain status')
  await other.submit('/help');await other.submit('/status');await other.submit('/quit')
 })
 it('makes read-only questions, separate consent, evidence and credentials explicit in the prompt', () => {
  for(const fragment of ['read-only','clarify','dearmachine up','dearmachine down','dearmachine restart','dearmachine status','systemd on','persistence on','loginctl enable-linger','wait','credentials','observed','/help']) expect(managementInstructions).toContain(fragment)
 })
 it('shuts down an agent that finishes opening after the interface closes', async () => {
  let resolve!: (agent: ManagementAgent)=>void
  const open=new Promise<ManagementAgent>(r=>{resolve=r})
  const conversation=new ManagementConversation(()=>open)
  const submit=conversation.submit('hello')
  await conversation.close()
  const agent={start:vi.fn(async()=>{}),prompt:vi.fn(async()=>{}),interrupt:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})}
  resolve(agent);await submit
  expect(agent.prompt).not.toHaveBeenCalled();expect(agent.shutdown).toHaveBeenCalledTimes(1)
 })
})

it('does not send a cancelled request after lazy agent setup finishes', async () => {
 let ready!: (agent: ManagementAgent)=>void
 const opening=new Promise<ManagementAgent>(resolve=>{ready=resolve})
 const conversation=new ManagementConversation(()=>opening)
 const submitted=conversation.submit('Stop Dear Machine')
 await conversation.interrupt()
 const agent={start:vi.fn(async()=>{}),prompt:vi.fn(async()=>{}),interrupt:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})}
 ready(agent);await submitted
 expect(agent.prompt).not.toHaveBeenCalled()
 await conversation.close()
})
