import { describe, expect, test } from 'claude-code/testing'

import { CHARSETS, chooseCharset, widthOf } from '../hooks/charset'
import { barLine, cells, clip } from '../hooks/render'

describe('chooseCharset', () => {
  test('a set named in the settings wins', () => {
    expect(chooseCharset('ascii', { LANG: 'en_US.UTF-8' }, 'terminal')).toBe('ascii')
    expect(chooseCharset('blocks', {}, 'desktop')).toBe('blocks')
  })

  test('surfaces other than the terminal draw unicode', () => {
    expect(chooseCharset('auto', { LANG: 'fr_FR.ISO-8859-1' }, 'desktop')).toBe('unicode')
  })

  test('no locale at all, as on Windows (where WT_SESSION is often not passed on either): unicode', () => {
    expect(chooseCharset('auto', {}, 'terminal')).toBe('unicode')
  })

  test('a locale naming another charset draws ascii', () => {
    expect(chooseCharset('auto', { LANG: 'fr_FR.ISO-8859-1' }, 'terminal')).toBe('ascii')
    expect(chooseCharset('auto', { LC_ALL: 'en_US.UTF-8', LANG: 'fr_FR.ISO-8859-1' }, 'terminal')).toBe('unicode')
  })

  test('C, POSIX and a UTF-8 locale say nothing against unicode', () => {
    expect(chooseCharset('auto', { LANG: 'C' }, 'terminal')).toBe('unicode')
    expect(chooseCharset('auto', { LANG: 'en_US.utf8' }, 'terminal')).toBe('unicode')
    expect(chooseCharset('auto', {}, 'terminal')).toBe('unicode')
  })
})

describe('glyph sets', () => {
  test('every set draws bars of the asked width', () => {
    for (const glyphs of Object.values(CHARSETS)) {
      for (const n of [0, 1, 33, 50, 99, 100]) {
        expect(widthOf(cells({ n, total: 100 }, 17, 0, glyphs))).toBe(17)
      }

      expect(widthOf(cells({ n: 5 }, 17, 400, glyphs))).toBe(17)
    }
  })

  test('blocks keep to code page 437', () => {
    const cp437 = '█░√■└|/-\\x!~'

    for (const char of Object.values(CHARSETS.blocks).flat().join('')) {
      expect(cp437).toContain(char)
    }
  })

  test('ascii is ascii', () => {
    for (const char of Object.values(CHARSETS.ascii).flat().join('')) {
      expect(char.charCodeAt(0)).toBeLessThan(128)
    }
  })

  test('ascii partial cells count in tenths, as tqdm does', () => {
    expect(cells({ n: 15, total: 100 }, 2, 0, CHARSETS.ascii)).toBe('3-')
    expect(cells({ n: 65, total: 100 }, 2, 0, CHARSETS.ascii)).toBe('#3')
    expect(cells({ n: 50, total: 100 }, 2, 0, CHARSETS.ascii)).toBe('#-')
  })

  test('blocks have no partial cells', () => {
    expect(cells({ n: 3, total: 16 }, 2, 0, CHARSETS.blocks)).toBe('░░')
    expect(cells({ n: 12, total: 16 }, 2, 0, CHARSETS.blocks)).toBe('██')
  })
})

describe('wide characters', () => {
  test('CJK and emoji take two cells, combining marks none', () => {
    expect(widthOf('abc')).toBe(3)
    expect(widthOf('学習')).toBe(4)
    expect(widthOf('🚀')).toBe(2)
    expect(widthOf('🧪')).toBe(2)
    expect(widthOf('é')).toBe(1)
  })

  test('clip counts cells, not characters', () => {
    expect(clip('学習データ', 5)).toBe('学習…')
    expect(widthOf(clip('学習データ', 5))).toBeLessThanOrEqual(5)
  })

  test('a bar line with a wide label still fits', () => {
    const line = barLine({ n: 3, total: 10, label: '学習データの読み込み中です' }, '  ', 40, 0)

    expect(widthOf(line)).toBeLessThanOrEqual(40)
  })
})
