import { describe, expect, test } from 'claude-code/testing'

import type { Track } from '../types'
import { parse, tqdmBar } from '../hooks/parse'
import { failureOf, figures, glyph, hasDetailRow, isShortOfTotal, receiptOf, rowsOf, silentStartHint, timing } from '../hooks/render'

const ESC = '\x1b'

describe('other tools\' progress lines', () => {
  test('cargo', () => {
    expect(parse('   Compiling serde v1.0\r    Building [=============>     ] 120/300: serde, syn').main).toEqual({
      label: 'Building',
      n: 120,
      total: 300,
      postfix: 'serde, syn',
    })
  })

  test('ninja', () => {
    expect(parse('[12/345] Building CXX object src/a.o').main).toMatchObject({ label: 'Build', n: 12, total: 345 })
  })

  test('CMake makefiles', () => {
    expect(parse('[ 45%] Building CXX object src/b.o').main).toMatchObject({ label: 'Build', n: 45, total: 100, unit: '%' })
  })

  test('git clone --progress, with its phases in order', () => {
    const out = 'Cloning into \'repo\'...\nremote: Counting objects: 100% (50/50), done.\nReceiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s\r'
    const parsed = parse(out)

    expect(parsed.main).toMatchObject({ label: 'Receiving objects', n: 450, total: 1000, rate: '2.40 MiB/s' })
    expect(parsed.sub).toBeUndefined()
  })

  test('Keras 2: epochs, then steps beneath with metrics', () => {
    const out = 'Epoch 3/10\n 32/100 [========>.....................] - ETA: 0:02 - loss: 0.3012 - accuracy: 0.9100'
    const parsed = parse(out)

    expect(parsed.main).toMatchObject({ label: 'Epoch', n: 2, total: 10 })
    expect(parsed.sub).toMatchObject({ label: 'Steps', n: 32, total: 100, eta: '0:02', postfix: 'loss: 0.3012 accuracy: 0.9100' })
  })

  test('Keras 3', () => {
    const parsed = parse('Epoch 1/5\n32/100 ━━━━━━━━━━━━━━━━━━━━ 1s 15ms/step - loss: 0.3')

    expect(parsed.sub).toMatchObject({ n: 32, total: 100, rate: '15ms/step', postfix: 'loss: 0.3' })
  })

  test('docker buildx --progress=plain', () => {
    expect(parse('#7 [builder 3/5] RUN pip install -r requirements.txt').main).toMatchObject({
      label: 'Docker build',
      n: 3,
      total: 5,
    })
  })

  test('ffmpeg: its duration then its time= lines give a real percentage', () => {
    const out = [
      'Input #0, mov,mp4, from \'in.mp4\':',
      '  Duration: 00:05:00.00, start: 0.000000, bitrate: 1205 kb/s',
      'frame= 1234 fps= 60 q=28.0 size=    2048kB time=00:01:15.00 bitrate= 407.9kbits/s speed=2.01x',
    ].join('\n')

    expect(parse(out).main).toEqual({ label: 'ffmpeg', n: 75, total: 300, unit: 's', rate: '2.01x' })
  })

  test('ffmpeg\'s duration far before the tail is still found', () => {
    const out = `  Duration: 00:10:00.00, start: 0\n${'x\n'.repeat(40_000)}frame= 1 time=00:05:00.00 speed=1x`

    expect(parse(out).main).toMatchObject({ n: 300, total: 600 })
  })

  test('OSC 9;4 in the output (cargo and others emit it)', () => {
    expect(parse(`compiling${ESC}]9;4;1;42${ESC}\\`).main).toEqual({ n: 42, total: 100, unit: '%' })
    expect(parse(`x${ESC}]9;4;1;10\x07y${ESC}]9;4;3;0\x07`).main).toEqual({ n: 0 })
    expect(parse(`${ESC}]9;4;1;50\x07${ESC}]9;4;0;0\x07`).main).toBeUndefined()
  })

  test('tools one after another: the latest tool alone, never nested under the last', () => {
    // Seen live: a ninja build stopped at 39/40, then docker; docker was drawn under the build.
    const out = '[37/40] Building CXX object a.o\n[39/40] Building CXX object b.o\n#4 [builder 1/5] RUN a\n#5 [builder 3/5] RUN b'
    const parsed = parse(out)

    expect(parsed.main).toMatchObject({ label: 'Docker build', n: 3, total: 5 })
    expect(parsed.sub).toBeUndefined()
  })

  test('a tool after Keras replaces its epochs and steps (seen live: Epoch 1/2 left as main)', () => {
    const out = 'Epoch 2/2\n100/100 [==============================] - loss: 0.01\n#4 [builder 5/5] RUN x\n  Duration: 00:01:40.00, start: 0\nframe= 1 time=00:01:40.00 speed=2x'
    const parsed = parse(out)

    expect(parsed.main).toMatchObject({ label: 'ffmpeg', n: 100, total: 100 })
    expect(parsed.sub).toBeUndefined()
  })

  test('Keras: the last epoch is complete once its steps are', () => {
    expect(parse('Epoch 2/2\n50/100 [===>....] - loss: 0.3').main).toMatchObject({ n: 1, total: 2 })
    expect(parse('Epoch 2/2\n100/100 [========] - loss: 0.1').main).toMatchObject({ n: 2, total: 2 })
  })

  test('the replay of the demo that got stuck: ends complete, no early-end warning', () => {
    const out = [
      '    Building [=========================>] 300/300: serde, syn',
      'Receiving objects: 100% (1000/1000), 2.50 MiB | 2.40 MiB/s, done.',
      '[39/40] Building CXX object src/file_39.o',
      'Epoch 2/2',
      '100/100 [==============================] - ETA: 0:00 - loss: 0.0099 - accuracy: 0.9091',
      '#8 [builder 5/5] RUN step number 5',
      '  Duration: 00:01:40.00, start: 0.000000, bitrate: 1205 kb/s',
      'frame= 3000 fps= 60 q=28.0 size=  2000kB time=00:01:40.00 bitrate= 407.9kbits/s speed=2.0x',
    ].join('\n')
    const parsed = parse(out)

    expect(parsed.main).toMatchObject({ label: 'ffmpeg', n: 100, total: 100 })
    expect(parsed.sub).toBeUndefined()
  })

  test('Keras still nests steps under epochs after another tool', () => {
    const parsed = parse('[40/40] Building CXX object a.o\nEpoch 1/2\n50/100 [===>....] - loss: 0.3')

    expect(parsed.main?.label).toBe('Epoch')
    expect(parsed.sub?.label).toBe('Steps')
  })

  test('a bare n/m in a plain line is no progress', () => {
    expect(parse('Saved 10/11 files to cache').main).toBeUndefined()
    expect(parse('date 2026/10/18 build 4/5').main).toBeUndefined()
  })
})

describe('tqdm postfix', () => {
  test('kept beside the rate', () => {
    expect(tqdmBar('Fit:  50%|█████     | 10/20 [00:00<00:00, 95.02it/s, loss=0.05, acc=0.9]')).toMatchObject({
      rate: '95.02it/s',
      postfix: 'loss=0.05, acc=0.9',
    })
  })

  test('drawn after the figures, clipped', () => {
    expect(figures({ n: 10, total: 20, rate: '9it/s', postfix: 'loss=0.05' })).toBe('10/20  50%  9it/s  loss=0.05')
    expect(figures({ n: 1, postfix: 'x'.repeat(100) }).length).toBeLessThan(45)
  })
})

const base: Track = { id: 't', label: 'Train', kind: 'bg', startedAt: 0, status: 'running', lastChangeAt: 0, size: 10 }

describe('how a task ended', () => {
  test('a receipt for a finished task', () => {
    expect(receiptOf({ ...base, status: 'done', endedAt: 20_000, main: { n: 200, total: 200, rate: '9.9it/s' } })).toBe('200/200 (9.9it/s)')
    expect(receiptOf({ ...base, status: 'done', endedAt: 1 })).toBe('')
  })

  test('exit 0 short of the total is a warning that waits, like alive-progress\'s (!)', () => {
    const short: Track = { ...base, status: 'done', exitCode: 0, endedAt: 5000, isExact: true, main: { n: 45, total: 100 } }

    expect(isShortOfTotal(short)).toBe(true)
    expect(hasDetailRow(short)).toBe(true)
    expect(glyph(short, 0)).toBe('!')
    expect(receiptOf(short)).toBe('(!) 45/100')
    expect(failureOf(short)).toBe('exited 0 at 45/100')
    expect(failureOf({ ...short, lastLine: 'Duration: 00:01:40.00' })).toBe('exited 0 at 45/100')
    expect(failureOf({ ...short, error: 'OSError: disk full' })).toBe('exited 0 at 45/100 · OSError: disk full')
    expect(rowsOf(short)).toBe(3)
  })

  test('a finished task at its total is no warning, and says it all in its header', () => {
    const full: Track = { ...base, status: 'done', endedAt: 5000, main: { n: 100, total: 100 } }

    expect(isShortOfTotal(full)).toBe(false)
    expect(rowsOf(full)).toBe(1)
  })
})

describe('a task with no output yet', () => {
  test('says why it may be silent after 15 s', () => {
    expect(silentStartHint({ ...base, size: 0 }, 10_000)).toBeUndefined()
    expect(silentStartHint({ ...base, size: 0 }, 16_000)).toContain('python -u')
    expect(silentStartHint({ ...base, size: -1 }, 16_000)).toContain('PYTHONUNBUFFERED=1')
    expect(silentStartHint({ ...base, size: 5 }, 16_000)).toBeUndefined()
    expect(silentStartHint({ ...base, size: 0, kind: 'agent' }, 16_000)).toBeUndefined()
  })
})

describe('the estimate leaves out the start-up', () => {
  test('pace measured from when progress was first seen', () => {
    // 60 s of start-up, then 10% → 30% in 20 s: 70% left at 1%/s is 70 s more.
    const track: Track = { ...base, main: { n: 30, total: 100 }, progressFrom: { at: 60_000, fraction: 0.1 } }

    expect(timing(track, 80_000)).toBe('01:20 / ~02:30')
  })

  test('tqdm\'s own remaining time wins', () => {
    expect(timing({ ...base, main: { n: 30, total: 100, eta: '00:10' }, progressFrom: { at: 0, fraction: 0 } }, 20_000)).toBe(
      '00:20 / ~00:30',
    )
  })
})
