// API 封装
function accessHeaders() {
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get('access')
  if (fromUrl) window.localStorage.setItem('workbench_access_token', fromUrl)
  const token = window.localStorage.getItem('workbench_access_token')
  return token ? { 'X-Workbench-Token': token } : {}
}

async function parse(res) {
  let data = null
  try { data = await res.json() } catch (e) { /* 空响应 */ }
  if (!res.ok) {
    const msg = data?.detail || data?.error || `请求失败 (${res.status})`
    throw new Error(msg)
  }
  return data
}

export const get = (url) => fetch(url, { headers: accessHeaders() }).then(parse)
export const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...accessHeaders() },
  body: JSON.stringify(body)
}).then(parse)

export async function streamPost(url, body, onEvent) {
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
export const put = (url, body) => fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...accessHeaders() },
  body: JSON.stringify(body)
}).then(parse)
export const del = (url) => fetch(url, { method: 'DELETE', headers: accessHeaders() }).then(parse)

// 文件下载（GET 导出）
export function download(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename || ''
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// 文件上传（multipart）
export function upload(url, file) {
  const fd = new FormData()
  fd.append('file', file)
  return fetch(url, { method: 'POST', headers: accessHeaders(), body: fd }).then(parse)
}
