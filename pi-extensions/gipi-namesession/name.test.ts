/**
 * The t0 placeholder rule, testable without a session: `node --test pi-extensions/`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultSessionName, isDefaultName } from './name.ts'

test('the placeholder is the marker plus the project, nothing else', () => {
  assert.equal(defaultSessionName('/home/pi/dev/github/dotfiles'), 'π · dotfiles')
  assert.equal(defaultSessionName('/'), 'π · session')
})

test('the placeholder is recognised so it can be replaced', () => {
  assert.equal(isDefaultName('π · dotfiles'), true)
  assert.equal(isDefaultName('π'), true, 'a bare π is the placeholder of an earlier version')
})

test('a name the model chose is not treated as a placeholder', () => {
  assert.equal(isDefaultName('awsfz perf audit'), false)
  assert.equal(isDefaultName('πx'), false)
  assert.equal(isDefaultName(''), false)
  assert.equal(isDefaultName(undefined), false)
})
