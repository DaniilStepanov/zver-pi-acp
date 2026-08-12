import { resolve } from 'node:path'

export type CliOptions = {
  devPackage?: string
  terminalLogin: boolean
}

export function parseCliOptions(argv: string[], cwd = process.cwd()): CliOptions {
  let devPackage: string | undefined
  let terminalLogin = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--terminal-login') {
      terminalLogin = true
      continue
    }
    if (arg !== '--dev-package') continue

    const value = argv[++i]
    if (!value || value.startsWith('--')) {
      throw new Error('--dev-package requires a path')
    }
    if (devPackage) {
      throw new Error('--dev-package may only be specified once')
    }
    devPackage = resolve(cwd, value)
  }

  return { devPackage, terminalLogin }
}

export function devPackageArgs(devPackage?: string): string[] {
  return devPackage ? ['--no-extensions', '--extension', devPackage] : []
}
