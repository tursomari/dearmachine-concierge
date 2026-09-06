import { describe, it, expect, vi } from 'vitest'
import { ConciergeShell, localHelp } from '../src/concierge-shell.ts'

describe('deterministic consent choices', () => {
 it('asks separate questions locally and changes nothing for unanswered questions', async () => {
  const chooseSupervision=vi.fn(async()=> 'saved')
  const say=vi.fn()
  const converse=vi.fn()
  const shell=new ConciergeShell({control:{request:vi.fn()},say,converse,chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
  await shell.submit('/systemd');await shell.submit('/persistence')
  expect(chooseSupervision).not.toHaveBeenCalled()
  expect(say.mock.calls.flat().join(' ')).toContain('loginctl enable-linger')
  await shell.submit('/systemd on')
  expect(chooseSupervision.mock.calls).toEqual([['systemd','on']])
  await shell.submit('/persistence on')
  expect(chooseSupervision.mock.calls).toEqual([['systemd','on'],['persistence','on']])
  expect(converse).not.toHaveBeenCalled()
 })
 it('keeps malformed consent local and lists rescue commands', async () => {
  const chooseSupervision=vi.fn(async()=> 'saved');const converse=vi.fn()
  const shell=new ConciergeShell({control:{request:vi.fn()},say:vi.fn(),converse,chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
  await shell.submit('/systemd yes please')
  expect(chooseSupervision).not.toHaveBeenCalled();expect(converse).not.toHaveBeenCalled()
  expect(localHelp).toContain('dearmachine persistence off')
  expect(localHelp).toContain('loginctl disable-linger')
 })
})
