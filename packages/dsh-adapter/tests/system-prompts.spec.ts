import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyInstallerPrompt } from '../src/installer-system-prompt.ts'
import { apply as applyManagementPrompt } from '../src/management-system-prompt.ts'
import { sharedFoundation, conciergeRole } from '../src/system-prompts.ts'

interface CapturedSection { name: string; order: number; text: string }

function promptContext(sections: CapturedSection[]) {
  return {
    systemPrompt: {
      getSectionOrder: (name: string) => name === 'DEPLOYMENT_PERSONA' ? 0 : 2_400,
      section: (section: CapturedSection) => { sections.push(section) },
    },
  }
}

afterEach(() => { delete process.env.MACHTIANI_INSTALLER_CONTRACT })

describe('role system prompts', () => {
  it('delivers the native guest command and authorization contract to Concierge', () => {
    const sections: CapturedSection[] = []
    applyManagementPrompt(promptContext(sections) as never)
    const prompt = sections.map(section => section.text).join('\n')
    for (const command of [
      'guest allow <address> --pair <pair> --message-id <message>',
      'guest list --pair <pair>',
      'guest revoke <address> --pair <pair> --thread-id <thread>',
      'guest revoke <address> --pair <pair> --all',
    ]) expect(prompt).toContain(command)
    for (const gate of ['Reply All', 'admission', 'instruction approval', 'trust', 'automatic invitations are disabled', 'synchronization pending']) expect(prompt).toContain(gate)
    expect(prompt).toContain('original request\'s From, To or CC')
    expect(prompt).toContain('owner-only answer')
    expect(prompt).toContain('admission/approval prompts stay private')
    expect(prompt).toContain('explicit wish')
    expect(prompt).toContain('does not roll back already-started work')
  })

  it('does not mistake declined changes or missing consent for observed persistence state', () => {
    expect(conciergeRole).toContain('Declining a proposed configuration change')
    expect(conciergeRole).toContain('not proof that a feature is absent or disabled')
    expect(conciergeRole).toContain('missing consent record')
    expect(conciergeRole).toContain('throughout the entire answer')
  })
  it('distinguishes discovery, selected-backend setup, and user-facing configuration facts', () => {
    expect(sharedFoundation).toContain('command lookup failure is not proof of absence')
    expect(sharedFoundation).toContain('installed, configured, verified, and activated')
    expect(sharedFoundation).toContain('backendPreparations.forge')
    expect(sharedFoundation).toContain('not an OMP or generic backend setup tool')
    expect(sharedFoundation).toContain('Do not describe your internal planning')
    expect(conciergeRole).toContain('column 2 is the authorized sender; column 3 is the inbox')
    expect(conciergeRole).toContain('Unknown persistence does not mean disabled')
  })
  it('assembles the installer policy and permanent contract as ordered system sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'machtiani-prompt-'))
    const contractPath = join(root, 'INSTALL.md')
    await writeFile(contractPath, '# INSTALLATION CONTRACT\n\nFollow the staged procedure.\n')
    process.env.MACHTIANI_INSTALLER_CONTRACT = contractPath
    const sections: CapturedSection[] = []

    applyInstallerPrompt(promptContext(sections) as never)

    expect(sections.map(section => section.name)).toEqual([
      'machtiani:shared-foundation',
      'machtiani:installer-role',
      'machtiani:installation-contract',
    ])
    expect(sections.map(section => section.order)).toEqual([0, 10, 20])
    expect(sections[0]?.text).toContain('canonical documentation')
    expect(sections[0]?.text).toContain('accepts provider labels beyond the built-in catalogue')
    expect(sections[0]?.text).toContain('non-secret file/variable reference')
    expect(sections[0]?.text.toLocaleLowerCase('en-US')).toContain('ordinary configuration')
    expect(sections[1]?.text).toContain('one end-to-end Dear Machine installation')
    expect(sections[1]?.text).toContain('Do not narrate stage numbers')
    expect(sections[1]?.text).toContain('Do not repeat the helper-owned credential message')
    expect(sections[1]?.text).toContain('never run a no-op shell command')
    expect(sections[1]?.text).not.toContain('without preface or follow-up')
    expect(sections[1]?.text).toContain('wording guidance, not a fixed script')
    expect(sections[1]?.text).toContain('information supplied early')
    expect(sections[2]?.text).toContain('INSTALLATION CONTRACT')
  })

  it('assembles a distinct concierge role without the installation contract', () => {
    const sections: CapturedSection[] = []

    applyManagementPrompt(promptContext(sections) as never)

    expect(sections.map(section => section.name)).toEqual([
      'machtiani:shared-foundation',
      'machtiani:concierge-role',
    ])
    expect(sections[0]?.text).toContain('canonical documentation')
    expect(sections[1]?.text).toContain('dearmachine status')
    expect(sections[1]?.text).toContain('inbox address')
    expect(sections[1]?.text).toContain('typed credential helper')
    expect(sections[1]?.text).toContain('Preserve existing backends')
    expect(sections[1]?.text).toContain('never ask for a key in chat')
    expect(sections[1]?.text).toContain('request_dearmachine_update')
    expect(sections[1]?.text).toContain('not installation consent')
    expect(sections.map(section => section.text).join('\n')).not.toContain('INSTALLATION CONTRACT')
  })
})
