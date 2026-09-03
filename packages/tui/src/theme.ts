import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'

export interface InstallerTheme {
  accent(text: string): string
  dim(text: string): string
  success(text: string): string
  warning(text: string): string
  error(text: string): string
  bold(text: string): string
  italic(text: string): string
}

function sgr(open: string, close: string, enabled: boolean): (text: string) => string {
  return enabled ? text => `\x1b[${open}m${text}\x1b[${close}m` : text => text
}

export function createInstallerTheme(color = true): InstallerTheme {
  return {
    accent: sgr('95', '39', color),
    dim: sgr('2;39', '22;39', color),
    success: sgr('32', '39', color),
    warning: sgr('33', '39', color),
    error: sgr('31', '39', color),
    bold: sgr('1', '22', color),
    italic: sgr('3', '23', color),
  }
}

export function markdownTheme(theme: InstallerTheme): MarkdownTheme {
  return {
    heading: theme.accent,
    link: theme.accent,
    linkUrl: theme.dim,
    code: theme.accent,
    codeBlock: theme.accent,
    codeBlockBorder: theme.dim,
    quote: theme.dim,
    quoteBorder: theme.accent,
    hr: theme.dim,
    listBullet: theme.accent,
    bold: theme.bold,
    italic: theme.italic,
    strikethrough: text => text,
    underline: text => text,
  }
}

export function editorTheme(theme: InstallerTheme): EditorTheme {
  const selectList: SelectListTheme = {
    selectedPrefix: theme.accent,
    selectedText: theme.accent,
    description: theme.dim,
    scrollInfo: theme.dim,
    noMatch: theme.warning,
  }
  return { borderColor: theme.dim, selectList }
}
