import { describe, expect, it } from 'vitest'
import { createInstallerTheme, resolveInstallerMotion } from '../src/theme.ts'

describe('installer theme', () => {
  it('uses Machtiani semantic roles with the terminal palette by default', () => {
    const theme = createInstallerTheme({ environment: { TERM: 'xterm-256color' } })
    expect(theme.truth('truth')).toBe('\x1b[36mtruth\x1b[39m')
    expect(theme.goodness('goodness')).toBe('\x1b[32mgoodness\x1b[39m')
    expect(theme.beauty('beauty')).toBe('\x1b[35mbeauty\x1b[39m')
    expect(theme.provenance('provenance')).toBe('\x1b[33mprovenance\x1b[39m')
    expect(theme.rupture('rupture')).toBe('\x1b[31mrupture\x1b[39m')
  })

  it.each([
    ['machtiani-dark', ['88;199;217', '116;201;145', '195;155;232', '215;180;90', '224;108;117']],
    ['machtiani-light', ['0;107;120', '34;107;58', '112;66;143', '121;90;0', '167;46;63']],
  ] as const)('mirrors the %s truecolor palette', (profile, colors) => {
    const theme = createInstallerTheme({
      environment: { TERM: 'xterm-256color', COLORTERM: 'truecolor', MACHTIANI_THEME: profile },
    })
    const rendered = [theme.truth('x'), theme.goodness('x'), theme.beauty('x'), theme.provenance('x'), theme.rupture('x')]
    expect(rendered).toEqual(colors.map(color => `\x1b[38;2;${color}mx\x1b[39m`))
  })

  it('honors NO_COLOR while retaining useful emphasis', () => {
    const theme = createInstallerTheme({ environment: { TERM: 'xterm', NO_COLOR: '1' } })
    expect(theme.truth('plain')).toBe('plain')
    expect(theme.bold('bold')).toBe('\x1b[1mbold\x1b[22m')
    expect(theme.dim('quiet')).toBe('\x1b[2;39mquiet\x1b[22;39m')
  })

  it.each([
    { TERM: 'dumb' },
    { TERM: 'xterm', MACHTIANI_THEME: 'none' },
  ])('disables ANSI styling for $TERM/$MACHTIANI_THEME', environment => {
    const theme = createInstallerTheme({ environment })
    expect(theme.truth('plain')).toBe('plain')
    expect(theme.bold('plain')).toBe('plain')
  })

  it('rejects an unknown Machtiani theme profile', () => {
    expect(() => createInstallerTheme({ environment: { TERM: 'xterm', MACHTIANI_THEME: 'surprise' } }))
      .toThrow('unknown UI theme')
  })

  it('mirrors Machtiani motion overrides and disables motion for a dumb terminal', () => {
    expect(resolveInstallerMotion({ TERM: 'xterm' })).toBe('full')
    expect(resolveInstallerMotion({ TERM: 'xterm', MACHTIANI_MOTION: 'reduced' })).toBe('reduced')
    expect(resolveInstallerMotion({ TERM: 'xterm', MACHTIANI_MOTION: 'none' })).toBe('none')
    expect(resolveInstallerMotion({ TERM: 'dumb', MACHTIANI_MOTION: 'full' })).toBe('none')
    expect(() => resolveInstallerMotion({ TERM: 'xterm', MACHTIANI_MOTION: 'surprise' }))
      .toThrow('unknown UI motion mode')
  })
})
