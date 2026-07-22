// The `escalate:"false"`-means-true quirk: escalate is a boolean field, but a model may send the STRING "false",
// and `!!"false"` is TRUE → a spurious escalation to the human when the lead meant to answer. parseEscalate is the
// SINGLE shared definition consumed by BOTH the container's answer-required predicate (isEscalate) AND the daemon's
// resolve branch, so the two can't disagree. (Its own change, separate from the reliability fix.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEscalate, isEscalate } from '../container/mrc-channel-tools.js'

test('real booleans pass through', () => {
  assert.equal(parseEscalate(true), true)
  assert.equal(parseEscalate(false), false)
})

test('the STRING "false" (and friends) is FALSE — the fix for the quirk', () => {
  for (const s of ['false', 'False', 'FALSE', ' false ', '0', 'no', 'off', '']) assert.equal(parseEscalate(s), false, `"${s}" must be false`)
})

test('the STRING "true" (and other non-empty values) is TRUE', () => {
  for (const s of ['true', 'True', '1', 'yes', 'escalate']) assert.equal(parseEscalate(s), true, `"${s}" must be true`)
})

test('absent / null → false (a lead resolving without escalate must supply an answer)', () => {
  assert.equal(parseEscalate(undefined), false)
  assert.equal(parseEscalate(null), false)
})

test('isEscalate composes parseEscalate over the args object — predicate and branch agree on "false"', () => {
  assert.equal(isEscalate({ escalate: 'false' }), false)   // predicate: answer IS required (non-escalate)
  assert.equal(isEscalate({ escalate: 'true' }), true)
  assert.equal(isEscalate({ escalate: true }), true)
  assert.equal(isEscalate({}), false)
})
