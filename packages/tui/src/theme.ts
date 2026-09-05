import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'

export type InstallerThemeProfile = 'terminal' | 'machtiani-dark' | 'machtiani-light' | 'none'

export interface InstallerTheme {
  truth(text: string): string
  goodness(text: string): string
  beauty(text: string): string
  provenance(text: string): string
  rupture(text: string): string
  dim(text: string): string
  bold(text: string): string
  italic(text: string): string
}

export interface InstallerThemeOptions {
  color?: boolean
  environment?: NodeJS.ProcessEnv
}

function sgr(open: string, close: string, enabled: boolean): (text: string) => string {
  return enabled ? text => `\x1b[${open}m${text}\x1b[${close}m` : text => text
}

function resolveProfile(environment: NodeJS.ProcessEnv): InstallerThemeProfile {
  const value = environment.MACHTIANI_THEME?.trim().toLowerCase() ?? ''
  if (value === '') return 'terminal'
  if (value === 'terminal' || value === 'machtiani-dark' || value === 'machtiani-light' || value === 'none') return value
  throw new Error(`unknown UI theme ${JSON.stringify(value)} (want terminal, machtiani-dark, machtiani-light, or none)`)
}

const terminalPalette = {
  truth: '36', goodness: '32', beauty: '35', provenance: '33', rupture: '31',
} as const

const darkPalette = {
  truth: '38;2;88;199;217', goodness: '38;2;116;201;145', beauty: '38;2;195;155;232',
  provenance: '38;2;215;180;90', rupture: '38;2;224;108;117',
} as const

const lightPalette = {
  truth: '38;2;0;107;120', goodness: '38;2;34;107;58', beauty: '38;2;112;66;143',
  provenance: '38;2;121;90;0', rupture: '38;2;167;46;63',
} as const

export function createInstallerTheme(options?: boolean | InstallerThemeOptions): InstallerTheme {
  const normalized = typeof options === 'boolean' ? { color: options } : (options ?? {})
  const environment = normalized.environment ?? process.env
  const profile = resolveProfile(environment)
  const ansiEnabled = (normalized.color ?? true) && profile !== 'none' && environment.TERM?.trim().toLowerCase() !== 'dumb'
  const colorEnabled = ansiEnabled && environment.NO_COLOR === undefined
  const trueColor = ['truecolor', '24bit'].includes(environment.COLORTERM?.trim().toLowerCase() ?? '')
  const palette = trueColor && profile === 'machtiani-dark'
    ? darkPalette
    : trueColor && profile === 'machtiani-light'
      ? lightPalette
      : terminalPalette
  return {
    truth: sgr(palette.truth, '39', colorEnabled),
    goodness: sgr(palette.goodness, '39', colorEnabled),
    beauty: sgr(palette.beauty, '39', colorEnabled),
    provenance: sgr(palette.provenance, '39', colorEnabled),
    rupture: sgr(palette.rupture, '39', colorEnabled),
    dim: sgr('2;39', '22;39', ansiEnabled),
    bold: sgr('1', '22', ansiEnabled),
    italic: sgr('3', '23', ansiEnabled),
  }
}

export function markdownTheme(theme: InstallerTheme): MarkdownTheme {
  return {
    heading: theme.truth,
    link: theme.beauty,
    linkUrl: theme.dim,
    code: theme.provenance,
    codeBlock: theme.provenance,
    codeBlockBorder: theme.dim,
    quote: theme.dim,
    quoteBorder: theme.truth,
    hr: theme.dim,
    listBullet: theme.truth,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: text => text,
    underline: text => text,
  }
}

export function editorTheme(theme: InstallerTheme): EditorTheme {
  const selectList: SelectListTheme = {
    selectedPrefix: theme.truth,
    selectedText: theme.truth,
    description: theme.dim,
    scrollInfo: theme.dim,
    noMatch: theme.provenance,
  }
  return { borderColor: theme.dim, selectList }
}
