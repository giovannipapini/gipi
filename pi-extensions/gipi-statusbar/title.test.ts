/**
 * The terminal title format. Kept in its own module (no pi imports) so the rule is
 * testable without a TUI: `node --test pi-extensions/gipi-statusbar/`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTitle } from './title.ts'

test('the t0 default name is already a title', () => {
  assert.equal(formatTitle('π · dotfiles', 'wF:p1'), 'π · dotfiles')
})

test('a name the model chose gets the marker', () => {
  assert.equal(formatTitle('awsfz perf audit', 'wF:p1'), 'π · awsfz perf audit')
})

test('an unnamed session still reads as a pi pane', () => {
  assert.equal(formatTitle('', '01a1729b'), 'π #01a1729b')
})

test('a name that already starts with the marker is not marked twice', () => {
  assert.equal(formatTitle('π', 'wF:p1'), 'π')
  assert.equal(formatTitle('πx', 'wF:p1'), 'πx')
})
