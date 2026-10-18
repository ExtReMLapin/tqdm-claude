/**
 * The glyphs the band draws with, in three sets after tqdm's own: tqdm draws
 * `" ▏▎▍▌▋▊▉█"` where its stream can encode it and `" 123456789#"` where it
 * cannot. The band is drawn by Claude Code, whose output is always UTF-8, so
 * the question is the font, not the encoding: `blocks` keeps to what code
 * page 437 has, which the legacy Windows console draws in any font.
 */
export type Glyphs = {
  full: string
  empty: string
  /** The partial cells between empty and full, in order: eighths, tenths, or none. */
  partials: readonly string[]
  spinner: readonly string[]
  done: string
  failed: string
  killed: string
  warning: string
  branch: string
  ellipsis: string
}

export const CHARSETS = {
  unicode: {
    full: '█',
    empty: '░',
    partials: ['▏', '▎', '▍', '▌', '▋', '▊', '▉'],
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    done: '✓',
    failed: '✗',
    killed: '■',
    warning: '!',
    branch: '└',
    ellipsis: '…',
  },
  blocks: {
    full: '█',
    empty: '░',
    partials: [],
    spinner: ['|', '/', '-', '\\'],
    done: '√',
    failed: 'x',
    killed: '■',
    warning: '!',
    branch: '└',
    ellipsis: '~',
  },
  ascii: {
    full: '#',
    empty: '-',
    partials: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    spinner: ['|', '/', '-', '\\'],
    done: '+',
    failed: 'x',
    killed: '#',
    warning: '!',
    branch: '`-',
    ellipsis: '~',
  },
} as const satisfies Record<string, Glyphs>

export type CharsetName = keyof typeof CHARSETS

/** The environment variables the choice reads. */
export type CharsetEnv = {
  LC_ALL?: string
  LC_CTYPE?: string
  LANG?: string
}

/**
 * `auto`: unicode, except where the locale names a charset that is not UTF-8
 * (ascii). Claude Code draws its own interface with symbols (`✻`, `●`, `⎿`)
 * wherever it runs, so a terminal that shows Claude Code shows the band; and
 * the terminal variables say little (Windows Terminal's `WT_SESSION` is often
 * not passed on to the process). `blocks` and `ascii` are for the person to
 * pick when their font lacks a glyph. Surfaces other than the terminal draw
 * unicode.
 */
export function chooseCharset(setting: string, env: CharsetEnv, surface: string): CharsetName {
  if (setting === 'unicode' || setting === 'blocks' || setting === 'ascii') {
    return setting
  }

  if (surface !== 'terminal') {
    return 'unicode'
  }

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG

  // `en_US.ISO-8859-1` names a charset; `C` and `POSIX` name none and say nothing of the terminal.
  if (locale && locale.includes('.') && !/utf-?8/i.test(locale)) {
    return 'ascii'
  }

  return 'unicode'
}

/**
 * Cells a character takes in a terminal: 2 for East Asian wide and
 * fullwidth characters and emoji, 0 for combining marks and joiners, else 1
 * (tqdm's `_text_width`, which counts `east_asian_width` F and W as 2).
 */
export function cellsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0

  if ((code >= 0x0300 && code <= 0x036f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) {
    return 0
  }

  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f7e0 && code <= 0x1f7eb) ||
    (code >= 0x1f900 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }

  return 1
}

/** The width of a text in terminal cells. */
export function widthOf(text: string): number {
  let width = 0

  for (const char of text) {
    width += cellsOf(char)
  }

  return width
}
