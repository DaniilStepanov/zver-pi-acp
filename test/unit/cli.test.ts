import assert from 'node:assert/strict'
import test from 'node:test'
import { devPackageArgs, parseCliOptions } from '../../src/cli.js'

test('parseCliOptions resolves a relative dev package once', () => {
  assert.deepEqual(parseCliOptions(['--dev-package', '../agent'], '/work/adapter'), {
    devPackage: '/work/agent',
    terminalLogin: false
  })
})

test('parseCliOptions combines terminal login with a dev package', () => {
  assert.deepEqual(parseCliOptions(['--terminal-login', '--dev-package', '/work/agent']), {
    devPackage: '/work/agent',
    terminalLogin: true
  })
})

test('parseCliOptions rejects missing and duplicate dev package values', () => {
  assert.throws(() => parseCliOptions(['--dev-package']), /requires a path/)
  assert.throws(
    () => parseCliOptions(['--dev-package', '/one', '--dev-package', '/two']),
    /only be specified once/
  )
})

test('devPackageArgs leaves installed mode unchanged', () => {
  assert.deepEqual(devPackageArgs(), [])
})

test('devPackageArgs isolates and loads the development package', () => {
  assert.deepEqual(devPackageArgs('/work/agent'), [
    '--no-extensions',
    '--extension',
    '/work/agent'
  ])
})
