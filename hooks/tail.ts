/** How much of a large output's end is read: what `parse` keeps. */
export const TAIL_BYTES = 64 * 1024

/** Base64 of a string's UTF-16LE bytes: what `powershell -EncodedCommand` takes, so no quoting is involved. */
function utf16Base64(text: string): string {
  let bytes = ''

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)

    bytes += String.fromCharCode(code & 0xff, code >> 8)
  }

  return btoa(bytes)
}

/**
 * The command that prints a file's last bytes: PowerShell on Windows (as
 * base64, which no console code page can garble; the file is opened shared,
 * as the task still writes it), `tail` elsewhere.
 */
export function tailCommand(path: string): { argv: string[]; isBase64: boolean } {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
    const quoted = `'${path.replace(/'/g, "''")}'`
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      `$f = [IO.File]::Open(${quoted}, 'Open', 'Read', 'ReadWrite, Delete')`,
      `$n = [Math]::Min(${TAIL_BYTES}, $f.Length)`,
      `[void]$f.Seek(-$n, 'End')`,
      '$b = New-Object byte[] $n',
      '$r = $f.Read($b, 0, $n)',
      '$f.Close()',
      '[Convert]::ToBase64String($b, 0, $r)',
    ].join('; ')

    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', utf16Base64(script)], isBase64: true }
  }

  return { argv: ['tail', '-c', String(TAIL_BYTES), path], isBase64: false }
}
