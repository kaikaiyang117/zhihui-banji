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

export async function fetchWithAccess(input, init = {}) {
  await ensureDevicePairing()
  return fetch(input, {
    ...init,
    headers: { ...accessHeaders(), ...(init.headers || {}) },
  })
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
export function scopedUrl(url) {
  const target = new URL(url, window.location.origin)
  const { classId, termId } = getStoredScope()
  if (classId) target.searchParams.set('class_id', classId)
  if (termId) target.searchParams.set('term_id', termId)
  return target.toString()
}

export async function download(url, filename) {
  await ensureDevicePairing()
  const a = document.createElement('a')
  a.href = scopedUrl(url)
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

export async function uploadEvidence(formData) {
  return request('/evidence/upload', { method: 'POST', body: formData })
}

export async function listEvidence(ownerType, ownerId) {
  return request(`/evidence/${ownerType}/${ownerId}`)
}

export async function getEvidenceDetail(evidenceId) {
  return request(`/evidence/detail/${evidenceId}`)
}

export async function deleteEvidence(evidenceId, deleteReason) {
  return request(`/evidence/${evidenceId}`, { method: 'DELETE', body: JSON.stringify({ delete_reason: deleteReason }) })
}

export async function restoreEvidence(evidenceId) {
  return request(`/evidence/${evidenceId}/restore`, { method: 'POST' })
}

export async function getEvidenceCounts(ownerType, ownerIds) {
  return request(`/evidence/counts?owner_type=${ownerType}&owner_ids=${ownerIds.join(',')}`)
}

export async function getUpcomingExams() {
  const result = await request('/stats/upcoming-exams')
  return Array.isArray(result) ? result : (Array.isArray(result?.exams) ? result.exams : [])
}

export async function listToolLinks(search, category) {
  const params = new URLSearchParams()
  if (search) params.set('search', search)
  if (category) params.set('category', category)
  const qs = params.toString()
  return request(`/tool-links${qs ? `?${qs}` : ''}`)
}

export async function createToolLink(data) {
  return request('/tool-links', { method: 'POST', body: JSON.stringify(data) })
}

export async function updateToolLink(id, data) {
  return request(`/tool-links/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function deleteToolLink(id) {
  return request(`/tool-links/${id}`, { method: 'DELETE' })
}

export async function recordToolLinkUsage(id) {
  return request(`/tool-links/${id}/use`, { method: 'POST' })
}

export async function listNotificationTemplates(scene) {
  const query = scene ? `?scene=${encodeURIComponent(scene)}` : ''
  return request(`/notification-templates${query}`)
}

export async function ensureNotificationTemplates() {
  return request('/notification-templates/ensure', { method: 'POST' })
}

export async function getNotificationTemplate(id) {
  return request(`/notification-templates/${id}`)
}

export async function generateNotificationAiContent(templateId, variableValues, instruction = '') {
  return request('/notification-templates/generate-ai', {
    method: 'POST',
    body: JSON.stringify({ template_id: templateId, variable_values: variableValues, instruction })
  })
}

export async function savePersonalTemplate(baseTemplateId, name, content) {
  return request('/notification-templates', {
    method: 'POST',
    body: JSON.stringify({ base_template_id: baseTemplateId, name, content })
  })
}

export async function updateNotificationTemplate(id, data) {
  return request(`/notification-templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

export async function deleteNotificationTemplate(id) {
  return request(`/notification-templates/${id}`, { method: 'DELETE' })
}

export async function restoreNotificationTemplate(id) {
  return request(`/notification-templates/${id}/restore`, { method: 'POST' })
}

export async function generateMeetingSummary(params) {
  return request('/meeting-prep/summary', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

export async function generateMeetingOutline(params) {
  return request('/meeting-prep/outline', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

export async function generateParentReply(params) {
  return request('/parent-reply/generate', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

function sessionHeaders(sessionId) {
  return sessionId ? { 'X-Workbench-Session': sessionId } : {}
}

export async function analyzeExcelImport(formData, sessionId = '') {
  return request('/excel-import/upload', { method: 'POST', body: formData, headers: sessionHeaders(sessionId) })
}

export async function previewExcelImport(fileId, module, sheetIndex, duplicateStrategy, sessionId = '') {
  return request('/excel-import/preview', {
    method: 'POST',
    body: JSON.stringify({ file_id: fileId, module, sheet_index: sheetIndex, duplicate_strategy: duplicateStrategy || 'update' }),
    headers: sessionHeaders(sessionId),
  })
}

export async function executeExcelImport(fileId, module, previewHash, requestId, sessionId = '') {
  return request('/excel-import/execute', {
    method: 'POST',
    body: JSON.stringify({ file_id: fileId, module, preview_hash: previewHash, request_id: requestId }),
    headers: sessionHeaders(sessionId),
  })
}

export async function discardExcelImport(fileId, sessionId = '') {
  return request('/excel-import/discard', {
    method: 'POST',
    body: JSON.stringify({ file_id: fileId }),
    headers: sessionHeaders(sessionId),
  })
}

export async function downloadExcelImportErrors(fileId, module, sessionId = '') {
  await ensureDevicePairing()
  const response = await fetch(`/api/excel-import/errors/${encodeURIComponent(fileId)}?module=${encodeURIComponent(module)}`, {
    headers: { ...accessHeaders(), ...sessionHeaders(sessionId) },
  })
  if (!response.ok) {
    let data = null
    try { data = await response.json() } catch { /* 非 JSON 错误响应 */ }
    const error = new Error(typeof data?.detail === 'string' ? data.detail : `错误报告下载失败 (${response.status})`)
    error.status = response.status
    throw error
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `导入错误-${fileId.slice(0, 8)}.xlsx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export async function getTeacherClasses() {
  return request('/teacher/classes')
}
export async function addTeacherClass(classId) {
  return request('/teacher/classes', { method: 'POST', body: JSON.stringify({ class_id: classId }) })
}
export async function removeTeacherClass(id) {
  return request(`/teacher/classes/${id}`, { method: 'DELETE' })
}
export async function getTeacherTimetable(dateFrom, dateTo) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('start_date', dateFrom)
  if (dateTo) params.set('end_date', dateTo)
  const qs = params.toString()
  return request(`/teacher/timetable${qs ? `?${qs}` : ''}`)
}
export async function getTeacherExams() {
  return request('/teacher/exams')
}

async function request(path, init = {}) {
  await ensureDevicePairing()
  const headers = { ...accessHeaders() }
  if (init.body && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  return fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } }).then(parse)
}
