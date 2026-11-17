import { spawn } from 'node:child_process'

// Runs a command from the operator's config (e.g. LLM_COMMAND) through the shell.
// `input` is written to stdin. Node only, there is no equivalent on Workers.
export function exec(command, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, timeout: 120_000 })
    let output = ''

    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.resume()
    child.stdin.on('error', () => {}) // command exited without reading stdin, that's fine
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`command exited with ${code ?? 'a timeout'}`))
    })

    child.stdin.end(input)
  })
}
