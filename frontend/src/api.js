// API 封装
async function parse(res) {
  let data = null
  try { data = await res.json() } catch (e) { /* 空响应 */ }
  if (!res.ok) {
    const msg = data?.detail || data?.error || `请求失败 (${res.status})`
    throw new Error(msg)
  }
  return data
}

export const get = (url) => fetch(url).then(parse)
export const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(parse)
export const put = (url, body) => fetch(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(parse)
export const del = (url) => fetch(url, { method: 'DELETE' }).then(parse)

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
  return fetch(url, { method: 'POST', body: fd }).then(parse)
}