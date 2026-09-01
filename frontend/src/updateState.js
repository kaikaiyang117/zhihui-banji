const PERSISTED_UPDATE_STATUSES = new Set([
  'paused',
  'downloading',
  'verifying',
  'ready_to_install',
  'error',
])

export function shouldRestorePersistedUpdate(result, persisted) {
  return result?.update_available === true
    && persisted?.version === result.latest_version
    && PERSISTED_UPDATE_STATUSES.has(persisted.status)
}

export function canInstallUpdate(result, status) {
  return result?.update_available === true && status === 'ready_to_install'
}
