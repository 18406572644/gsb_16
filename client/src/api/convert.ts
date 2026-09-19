/**
 * 转换中心 HTTP 客户端：导入预览/确认、导出、任务轮询、历史版本、审计。
 * 身份头与 WebSocket join 保持一致（x-actor-name / x-actor-role）。
 */
import {
  API,
  type AuditRecord,
  type ConvertTask,
  type ExportFormat,
  type ExportRequestBody,
  type ExportVariant,
  type ImportPreview,
  type RevisionInfo,
} from '../../../shared/convert'

export interface Actor {
  name: string
  role: 'viewer' | 'commenter' | 'editor'
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function req<T>(path: string, init: RequestInit = {}, actor?: Actor): Promise<T> {
  const headers = new Headers(init.headers)
  if (actor) {
    headers.set('x-actor-name', encodeURIComponent(actor.name))
    headers.set('x-actor-role', actor.role)
  }
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    let msg = res.statusText
    let code = 'INTERNAL'
    try {
      const j = await res.json()
      msg = j.error || msg
      code = j.code || code
    } catch {
      // 非 JSON 错误体
    }
    throw new ApiError(res.status, code, msg)
  }
  return (await res.json()) as T

}

/* ---------------- 导入 ---------------- */

export async function uploadImport(
  docId: string,
  actor: Actor,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<{ preview?: ImportPreview; taskId?: string }> {
  const headers = new Headers({
    'x-actor-name': encodeURIComponent(actor.name),
    'x-actor-role': actor.role,
  })
  const result = await xhrUpload(
    `${API.importPreview}?docId=${encodeURIComponent(docId)}`,
    file,
    headers,
    onProgress,
  )
  return JSON.parse(result) as { preview?: ImportPreview; taskId?: string }
}

function xhrUpload(
  url: string,
  file: File,
  headers: Headers,
  onProgress?: (percent: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    headers.forEach((v, k) => xhr.setRequestHeader(k, v))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText)
      else {
        try {
          const j = JSON.parse(xhr.responseText)
          reject(new ApiError(xhr.status, j.code || 'INTERNAL', j.error || xhr.statusText))
        } catch {
          reject(new ApiError(xhr.status, 'INTERNAL', xhr.statusText))
        }
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', '网络错误，上传失败'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

export const getImportTask = (id: string, actor: Actor) =>
  req<{ task: ConvertTask; preview?: ImportPreview }>(`${API.importTaskPreview}?id=${encodeURIComponent(id)}`, {}, actor)
export const refreshPreview = (previewId: string, actor: Actor) =>
  req<ImportPreview>(API.importRefresh, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId }),
  }, actor)

export const confirmPreview = (previewId: string, actor: Actor) =>
  req<{ revision: number; changed: boolean }>(API.importConfirm, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId }),
  }, actor)

export const discardPreview = (previewId: string, actor: Actor) =>
  req<{ ok: boolean }>(API.importDiscard, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId }),
  }, actor)

/* ---------------- 导出 ---------------- */

export interface SyncExportResult {
  blob: Blob
  fileName: string
}

export async function runExport(
  docId: string,
  actor: Actor,
  body: ExportRequestBody,
): Promise<SyncExportResult | { taskId: string }> {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-actor-name': encodeURIComponent(actor.name),
    'x-actor-role': actor.role,
  })
  const res = await fetch(`${API.exportRun}?docId=${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (res.status === 202) {
    return (await res.json()) as { taskId: string }
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw new ApiError(res.status, j.code || 'INTERNAL', j.error || res.statusText)
  }
  const blob = await res.blob()
  const fileName = filenameFromDisposition(res.headers.get('content-disposition')) || `export.${body.format}`
  return { blob, fileName }
}

export function downloadUrl(taskId: string): string {
  return API.taskDownload(taskId)
}

/** 任务产物下载需带身份头：fetch 为 Blob 后触发浏览器保存 */
export async function downloadTaskResult(taskId: string, actor: Actor, fileName: string) {
  const res = await fetch(API.taskDownload(taskId), {
    headers: {
      'x-actor-name': encodeURIComponent(actor.name),
      'x-actor-role': actor.role,
    },
  })
  if (!res.ok) throw new ApiError(res.status, 'INTERNAL', '下载失败')
  const blob = await res.blob()
  const name = filenameFromDisposition(res.headers.get('content-disposition')) || fileName
  triggerDownload(new Blob([blob]), name)
}

export function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (utf8) return decodeURIComponent(utf8[1])
  const plain = /filename="([^"]+)"/i.exec(disposition)
  return plain ? plain[1] : null
}

/* ---------------- 任务 / 版本 / 审计 ---------------- */

export const listTasks = (docId: string, actor: Actor) =>
  req<{ tasks: ConvertTask[] }>(`${API.tasks}?docId=${encodeURIComponent(docId)}`, {}, actor)

export const getTask = (id: string, actor: Actor) =>
  req<{ task: ConvertTask }>(API.taskItem(id), {}, actor)

export const retryTask = (id: string, actor: Actor) =>
  req<{ task: ConvertTask }>(`${API.taskItem(id)}/retry`, { method: 'POST' }, actor)

export const cancelTask = (id: string, actor: Actor) =>
  req<{ task: ConvertTask }>(`${API.taskItem(id)}/cancel`, { method: 'POST' }, actor)

export const listRevisions = (docId: string, actor: Actor) =>
  req<{ revisions: RevisionInfo[] }>(`${API.revisions}?docId=${encodeURIComponent(docId)}`, {}, actor)

export const listAudit = (docId: string, actor: Actor, limit = 100) =>
  req<{ records: AuditRecord[] }>(`${API.audit}?docId=${encodeURIComponent(docId)}&limit=${limit}`, {}, actor)

export type { ExportFormat, ExportVariant }
