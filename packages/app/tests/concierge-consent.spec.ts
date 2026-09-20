import { describe, it, expect, vi } from 'vitest'
import { ConciergeShell, localHelpForPlatform } from '../src/concierge-shell.ts'

describe('deterministic consent choices', () => {
 it('asks separate questions locally and changes nothing for unanswered questions', async () => {
  const chooseSupervision=vi.fn(async()=> 'saved')
  const say=vi.fn()
  const converse=vi.fn()
  const shell=new ConciergeShell({platform:'linux',control:{request:vi.fn()},say,converse,chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
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
  const shell=new ConciergeShell({platform:'linux',control:{request:vi.fn()},say:vi.fn(),converse,chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
  await shell.submit('/systemd yes please')
  expect(chooseSupervision).not.toHaveBeenCalled();expect(converse).not.toHaveBeenCalled()
  expect(localHelpForPlatform('linux')).toContain('dearmachine persistence off')
  expect(localHelpForPlatform('linux')).toContain('loginctl disable-linger')
 })
})

 it('offers macOS service and login choices without Linux commands or implicit mutation', async () => {
  const chooseSupervision=vi.fn(async()=> 'saved');const say=vi.fn();const converse=vi.fn()
  const shell=new ConciergeShell({platform:'darwin',control:{request:vi.fn()},say,converse,chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
  await shell.submit('/help');await shell.submit('/launchd');await shell.submit('/persistence')
  const guidance=say.mock.calls.flat().join(' ')
  expect(guidance).toContain('when you log in')
  expect(guidance).toContain('will not run before login')
  expect(guidance).not.toMatch(/systemctl|loginctl|systemd/)
  expect(chooseSupervision).not.toHaveBeenCalled()
  await shell.submit('/systemd on')
  expect(chooseSupervision).not.toHaveBeenCalled()
  await shell.submit('/launchd on');await shell.submit('/persistence on');await shell.submit('/persistence off');await shell.submit('/launchd off')
  expect(chooseSupervision.mock.calls).toEqual([['launchd','on'],['persistence','on'],['persistence','off'],['launchd','off']])
  expect(converse).not.toHaveBeenCalled()
 })
 it('does not route macOS-only service commands to Linux', async () => {
  const chooseSupervision=vi.fn(async()=> 'saved')
  const shell=new ConciergeShell({platform:'linux',control:{request:vi.fn()},say:vi.fn(),chooseSupervision,ensureIndependent:async()=>{},unsubscribe:async()=>{},close:async()=>{}})
  await shell.submit('/launchd on');expect(chooseSupervision).not.toHaveBeenCalled()
 })
