// API 封装
const CLASS_KEY = 'workbench_class_id'
const TERM_KEY = 'workbench_term_id'
let pairingPromise = null

export function clearDeviceCredential() {
  pairingPromise = null
}

export function getStoredScope() {
  return {
    classId: window.localStorage.getItem(CLASS_KEY) || '',
    termId: window.localStorage.getItem(TERM_KEY) || '',
  }
}

export function setStoredScope(classId, termId) {
  const previous = getStoredScope()
  window.localStorage.setItem(CLASS_KEY, String(classId || ''))
  window.localStorage.setItem(TERM_KEY, String(termId || ''))
  if (String(previous.classId) !== String(classId || '') || String(previous.termId) !== String(termId || '')) {
    window.localStorage.removeItem('meimei_agent_web_session_id')
  }
}

export function clearStoredScope() {
  window.localStorage.removeItem(CLASS_KEY)
  window.localStorage.removeItem(TERM_KEY)
}

function accessHeaders() {
  const params = new URLSearchParams(window.location.search)
  if (params.has('access')) {
    params.delete('access')
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`)
  }
  const headers = {}
  const { classId, termId } = getStoredScope()
  if (classId) headers['X-Workbench-Class'] = classId
  if (termId) headers['X-Workbench-Term'] = termId
  return headers
}

async function ensureDevicePairing() {
  const code = new URLSearchParams(window.location.search).get('pair')
  if (!code) return
  if (!pairingPromise) {
    pairingPromise = fetch('/api/system/pairing/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        name: `移动设备 · ${navigator.platform || '浏览器'}`,
      }),
    }).then(parse).then(result => {
      const params = new URLSearchParams(window.location.search)
      params.delete('pair')
      window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`)
      return result
    })
  }
  await pairingPromise
}

async function parse(res) {
  let data = null
  try { data = await res.json() } catch (e) { /* 空响应 */ }
  if (!res.ok) {
    const detail = data?.detail
    const msg = typeof detail === 'string'
      ? detail
      : detail?.message || data?.error || `请求失败 (${res.status})`
    const error = new Error(msg)
    error.detail = detail
    error.status = res.status
    throw error
  }
  return data
}

export const get = async (url) => {
  await ensureDevicePairing()
  return fetch(url, { headers: accessHeaders(), cache: 'no-store' }).then(parse)
}
export const post = async (url, body) => {
  await ensureDevicePairing()
  return fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...accessHeaders() },
  body: JSON.stringify(body)
  }).then(parse)
}

export async function streamPost(url, body, onEvent) {
  await ensureDevicePairing()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...accessHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parse(res)
  if (!res.body) throw new Error('浏览器不支持流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  async function consumeLine(line) {
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    if (!raw) return
    await onEvent(JSON.parse(raw))
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) await consumeLine(line)
      if (done) break
    }
    if (buffer) await consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }
}
export const put = async (url, body) => {
  await ensureDevicePairing()
  return fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...accessHeaders() },
  body: JSON.stringify(body)
  }).then(parse)
}
export const del = async (url, body) => {
  await ensureDevicePairing()
  return fetch(url, {
  method: 'DELETE',
  headers: body === undefined
    ? accessHeaders()
    : { 'Content-Type': 'application/json', ...accessHeaders() },
  body: body === undefined ? undefined : JSON.stringify(body),
  }).then(parse)
}

// 文件下载（GET 导出）
export async function download(url, filename) {
  await ensureDevicePairing()
  const a = document.createElement('a')
  const target = new URL(url, window.location.origin)
  const { classId, termId } = getStoredScope()
  if (classId) target.searchParams.set('class_id', classId)
  if (termId) target.searchParams.set('term_id', termId)
  a.href = target.toString()
  a.download = filename || ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// 文件上传（multipart）
export async function upload(url, file) {
  await ensureDevicePairing()
  const fd = new FormData()
  fd.append('file', file)
  return fetch(url, { method: 'POST', headers: accessHeaders(), body: fd }).then(parse)
}
