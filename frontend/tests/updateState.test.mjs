import assert from 'node:assert/strict'
import test from 'node:test'

import { canInstallUpdate, shouldRestorePersistedUpdate } from '../src/updateState.js'

const latest = { update_available: true, latest_version: '9.9.9' }

test('same-version result never permits installation', () => {
  assert.equal(canInstallUpdate({ update_available: false, latest_version: '9.8.7' }, 'ready_to_install'), false)
})

test('ready state is restored only for the matching newer version', () => {
  assert.equal(shouldRestorePersistedUpdate(latest, { version: '9.9.9', status: 'ready_to_install' }), true)
  assert.equal(shouldRestorePersistedUpdate(latest, { version: '9.8.7', status: 'ready_to_install' }), false)
  assert.equal(shouldRestorePersistedUpdate(latest, { version: '9.9.9', status: 'idle' }), false)
})

test('install action still requires a ready state', () => {
  assert.equal(canInstallUpdate(latest, 'ready_to_install'), true)
  assert.equal(canInstallUpdate(latest, 'downloading'), false)
})
