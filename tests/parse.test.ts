import { describe, expect, test } from 'claude-code/testing'

import { backgroundOf, notificationsOf, parse, toNumber, tqdmBar } from '../hooks/parse'

const ESC = '\x1b'

describe('toNumber', () => {
  test('reads plain and scaled figures', () => {
    expect(toNumber('42')).toBe(42)
    expect(toNumber('3.5')).toBe(3.5)
    expect(toNumber('1.84k')).toBe(1840)
    expect(toNumber('2.40M')).toBe(2_400_000)
    expect(Number.isNaN(toNumber('abc'))).toBe(true)
  })
})

describe('tqdm', () => {
  test('a bar with a total', () => {
    const bar = tqdmBar('Epoch 3:  77%|███████▋  | 1840/2400 [00:05<00:01, 312.00it/s]')

    expect(bar).toEqual({ label: 'Epoch 3', n: 1840, total: 2400, eta: '00:01', rate: '312.00it/s' })
  })

  test('a bar with no description', () => {
    expect(tqdmBar(' 45%|████▌     | 45/100 [00:09<00:11,  4.90it/s]')?.label).toBeUndefined()
  })

  test('a description that holds a colon', () => {
    expect(tqdmBar('Epoch 2/5: train:  10%|█ | 10/100 [00:01<00:09, 9.9it/s]')?.label).toBe('Epoch 2/5: train')
  })

  test('scaled units (unit_scale=True)', () => {
    const bar = tqdmBar('model.bin:  45%|████▌     | 1.08M/2.40M [00:05<00:06, 216kB/s]')

    expect(bar?.n).toBe(1_080_000)
    expect(bar?.total).toBe(2_400_000)
    expect(bar?.rate).toBe('216kB/s')
  })

  test('postfix after the rate is left out of the rate', () => {
    expect(tqdmBar('Train:  50%|█████     | 50/100 [00:10<00:10, 5.00it/s, loss=0.231]')?.rate).toBe('5.00it/s')
  })

  test('an estimate tqdm cannot give yet', () => {
    expect(tqdmBar('Load:   0%|          | 0/10 [00:00<?, ?it/s]')?.eta).toBeUndefined()
  })

  test('a bar with no total', () => {
    expect(tqdmBar('Scanning: 1840it [00:05, 312.00it/s]')).toEqual({
      label: 'Scanning',
      n: 1840,
      unit: 'it',
      rate: '312.00it/s',
    })
  })

  test('lines that are no bar', () => {
    expect(tqdmBar('Loading config from ./a.yaml')).toBeUndefined()
    expect(tqdmBar('100% done')).toBeUndefined()
  })
})

describe('parse: tqdm output', () => {
  test('carriage-return updates: the latest wins', () => {
    const out = ['Train:   0%|          | 0/100 [00:00<?, ?it/s]', 'Train:  10%|█         | 10/100 [00:01<00:09, 9.9it/s]', 'Train:  42%|████▏     | 42/100 [00:04<00:06, 9.9it/s]'].join('\r')

    expect(parse(out).main?.n).toBe(42)
    expect(parse(out).sub).toBeUndefined()
  })

  test('nested bars: the outer one is main, the inner one sub', () => {
    const out = [
      'Epochs:  40%|████      | 2/5 [01:00<01:30, 30.0s/it]',
      'Batches:  10%|█         | 10/100 [00:01<00:09, 9.9it/s]',
      'Batches:  77%|███████▋  | 77/100 [00:07<00:02, 9.9it/s]',
    ].join('\r')
    const parsed = parse(out)

    expect(parsed.main?.label).toBe('Epochs')
    expect(parsed.main?.n).toBe(2)
    expect(parsed.sub?.label).toBe('Batches')
    expect(parsed.sub?.n).toBe(77)
  })

  test('nested bars written with cursor moves (position=)', () => {
    const out = `Epochs:  20%|██        | 1/5 [00:30<02:00]\n${ESC}[A${ESC}[2K\rBatches:  33%|███▎      | 33/100 [00:03<00:06, 9.9it/s]`
    const parsed = parse(out)

    expect(parsed.main?.label).toBe('Epochs')
    expect(parsed.sub?.n).toBe(33)
  })

  test('sequential bars: a finished one is not kept as main', () => {
    const out = [
      'a.whl: 100%|██████████| 10/10 [00:01<00:00, 9.9it/s]',
      'b.whl: 100%|██████████| 20/20 [00:02<00:00, 9.9it/s]',
      'c.whl:  40%|████      | 4/10 [00:01<00:01, 3.9it/s]',
    ].join('\n')
    const parsed = parse(out)

    expect(parsed.main?.label).toBe('c.whl')
    expect(parsed.sub).toBeUndefined()
  })

  test('everything finished: the latest bar is main', () => {
    const out = 'a: 100%|██████████| 10/10 [00:01<00:00]\nb: 100%|██████████| 5/5 [00:01<00:00]'

    expect(parse(out).main?.label).toBe('b')
  })

  test('ANSI colors are ignored', () => {
    expect(parse(`${ESC}[32mTrain:  50%|█████     | 50/100 [00:05<00:05]${ESC}[0m`).main?.n).toBe(50)
  })
})

describe('parse: the ##progress protocol', () => {
  test('step and sub-step with labels', () => {
    const parsed = parse('##progress step=3/7 label="Training" sub=1840/2400 sublabel="Epoch 3"')

    expect(parsed.main).toEqual({ n: 3, total: 7, label: 'Training' })
    expect(parsed.sub).toEqual({ n: 1840, total: 2400, label: 'Epoch 3' })
  })

  test('a sub-step with no total', () => {
    expect(parse('##progress step=1/3 sub=512').sub).toEqual({ n: 512, total: undefined })
  })

  test('labels carry over between updates', () => {
    const parsed = parse('##progress step=1/3 label="Copy"\n##progress sub=10/50 sublabel="files"\n##progress sub=20/50')

    expect(parsed.main?.label).toBe('Copy')
    expect(parsed.sub).toEqual({ n: 20, total: 50, label: 'files' })
  })

  test('a new step clears the last step\'s sub-step', () => {
    const parsed = parse('##progress step=1/3 sub=50/50\n##progress step=2/3')

    expect(parsed.main?.n).toBe(2)
    expect(parsed.sub).toBeUndefined()
  })

  test('a bare percentage', () => {
    expect(parse('##progress pct=45.5').main).toEqual({ n: 45.5, total: 100, unit: '%' })
  })

  test('rate and eta go to the bar the line updates', () => {
    const parsed = parse('##progress step=1/2 rate=3/s\n##progress sub=5/10 eta=00:30')

    expect(parsed.main?.rate).toBe('3/s')
    expect(parsed.sub?.eta).toBe('00:30')
  })

  test('msg and done', () => {
    const parsed = parse('##progress step=2/2 msg="indexing finished"\n##progress done=ok')

    expect(parsed.lastLine).toBe('indexing finished')
    expect(parsed.declared).toBe('ok')
  })

  test('the protocol wins over tqdm in the same output', () => {
    const parsed = parse('##progress step=1/4 label="Pipeline"\nTrain:  50%|█████     | 50/100 [00:05<00:05]')

    expect(parsed.main?.label).toBe('Pipeline')
  })

  test('an indented directive is still read', () => {
    expect(parse('   ##progress step=2/5').main?.n).toBe(2)
  })
})

describe('parse: plain output', () => {
  test('a bare percentage in a line', () => {
    expect(parse('Copying files... 37%').main).toEqual({ n: 37, total: 100, unit: '%' })
  })

  test('the last plain line', () => {
    expect(parse('starting\nloading weights\n\n').lastLine).toBe('loading weights')
  })

  test('a Python traceback: the exception line is the error', () => {
    const out = [
      'Traceback (most recent call last):',
      '  File "index.py", line 12, in <module>',
      '    print(doc["path"])',
      "KeyError: 'path'",
    ].join('\n')

    expect(parse(out).error).toBe("KeyError: 'path'")
  })

  test('shell errors', () => {
    expect(parse('bash: foo: command not found').error).toBe('bash: foo: command not found')
    expect(parse("'foo' is not recognized as an internal or external command,").error).toContain('not recognized')
  })

  test('a shell that dies at start (Git Bash on Windows), with Claude Code\'s trailer after it', () => {
    const out =
      '      0 [main] bash (32040) C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe: *** fatal error - add_item ("\\??\\C:\\Program Files\\Git", "/", ...) failed, errno 1\n\n[exited with code 5]\n'
    const parsed = parse(out)

    expect(parsed.error).toContain('fatal error - add_item')
    expect(parsed.lastLine).toContain('fatal error')
  })

  test('compiler-style errors', () => {
    expect(parse('error[E0425]: cannot find value `x` in this scope').error).toContain('E0425')
    expect(parse('error: linker `cc` not found').error).toContain('linker')
  })

  test('words that only look like errors are not errors', () => {
    expect(parse('0 errors, 0 warnings\nErrorHandler ready').error).toBeUndefined()
  })

  test('only the tail of a huge output is read', () => {
    const noise = 'x'.repeat(200_000)
    const parsed = parse(`Train:  10%|█ | 10/100 [00:01<00:09]\n${noise}\nTrain:  90%|█████████ | 90/100 [00:09<00:01]`)

    expect(parsed.main?.n).toBe(90)
  })

  test('an empty output', () => {
    expect(parse('')).toEqual({})
  })
})

describe('backgroundOf', () => {
  const TEXT =
    'Command running in background with ID: b14pgmf9v. Output is being written to: C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\tasks\\b14pgmf9v.output. You will be notified when it completes.'

  test('reads the id and the output file from the result text', () => {
    expect(backgroundOf(TEXT)).toEqual({
      taskId: 'b14pgmf9v',
      outputFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\tasks\\b14pgmf9v.output',
    })
  })

  test('a POSIX path with spaces', () => {
    const text = 'Command running in background with ID: abc. Output is being written to: /tmp/my dir/tasks/abc.output. You will be notified'

    expect(backgroundOf(text)?.outputFile).toBe('/tmp/my dir/tasks/abc.output')
  })

  test('the structured record wins', () => {
    expect(backgroundOf(TEXT, { backgroundTaskId: 'zz', backgroundOutputPath: '/x/zz.output' })).toEqual({
      taskId: 'zz',
      outputFile: '/x/zz.output',
    })
  })

  test('a foreground result is no background task', () => {
    expect(backgroundOf('hello world')).toBeUndefined()
    expect(backgroundOf(undefined)).toBeUndefined()
  })
})

describe('notificationsOf', () => {
  const notification = (id: string, status: string, summary: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\\t\\${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`

  test('a completed task with its exit code', () => {
    expect(notificationsOf(notification('b1', 'completed', 'Background command "x" completed (exit code 0)'))).toEqual([
      { taskId: 'b1', status: 'completed', exitCode: 0 },
    ])
  })

  test('a failed task', () => {
    expect(notificationsOf(notification('b2', 'failed', 'Background command "x" failed (exit code 1)'))[0]?.exitCode).toBe(1)
  })

  test('several in one row, and one with no exit code', () => {
    const text = `${notification('a', 'completed', 'done (exit code 0)')}\n${notification('b', 'killed', 'stopped by the user')}`

    expect(notificationsOf(text)).toEqual([
      { taskId: 'a', status: 'completed', exitCode: 0 },
      { taskId: 'b', status: 'killed', exitCode: undefined },
    ])
  })

  test('text with no notification', () => {
    expect(notificationsOf('just a prompt')).toEqual([])
  })
})
