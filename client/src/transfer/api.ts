/**
 * 转换中心 REST API 客户端封装。
 * 身份沿用会话 store（name/role 通过请求头传递，与 WS join 同一演示身份）。
 */
import type {
  AuditEntry,
  ConfirmImportBody,
  ConfirmImportResponse,
  ConvertTask,
  CreateExportBody,
  DocInfoResponse,
} from '../../../shared/transfer'

export interface Identity {
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

export function createTransferApi(identity: () => Identity) {
  const headers = (json = false): Record<string, string> => {
    const me = identity()
    // HTTP 头仅允许 Latin-1，中文名按 RFC 5987 风格编码，服务端 decodeURIComponent 还原
    const h: Record<string, string> = {
      'x-user-name': encodeURIComponent(me.name || '匿名'),
      'x-user-role': me.role,
    }
    if (json) h['content-type'] = 'application/json'
    return h
  }

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(path, {
      ...init,
      headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
    })
    if (!res.ok) {
      let body: { error?: { code: string; message: string } } = {}
      try {
        body = await res.json()
      } catch {
        /* 忽略 */
      }
      throw new ApiError(res.status, body.error?.code || 'INTERNAL', body.error?.message || `请求失败（${res.status}）`)
    }
    const ct = res.headers.get('content-type') || ''
    return (ct.includes('application/json') ? await res.json() : null) as T
  }

  return {
    docInfo(docId: string) {
      return request<DocInfoResponse>(`/api/docs/${encodeURIComponent(docId)}`)
    },

    createImport(docId: string, file: File) {
      const fd = new FormData()
      fd.append('file', file, file.name)
      return request<{ task: ConvertTask }>(`/api/docs/${encodeURIComponent(docId)}/imports`, {
        method: 'POST',
        body: fd,
        // 浏览器自动设置 multipart boundary，勿手动加 content-type
      })
    },

    confirmImport(docId: string, taskId: string, body: ConfirmImportBody) {
      return request<ConfirmImportResponse>(
        `/api/docs/${encodeURIComponent(docId)}/imports/${taskId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
    },

    discardImport(docId: string, taskId: string) {
      return request<{ ok: boolean }>(
        `/api/docs/${encodeURIComponent(docId)}/imports/${taskId}/discard`,
        { method: 'POST' },
      )
    },

    createExport(docId: string, body: CreateExportBody) {
      return request<{ task: ConvertTask }>(`/api/docs/${encodeURIComponent(docId)}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },

    listTasks(docId: string, fullId?: string) {
      const qs = fullId ? `?full=${encodeURIComponent(fullId)}` : ''
      return request<{ tasks: ConvertTask[] }>(`/api/docs/${encodeURIComponent(docId)}/tasks${qs}`)
    },

    cancelTask(docId: string, taskId: string) {
      return request<{ task: ConvertTask }>(
        `/api/docs/${encodeURIComponent(docId)}/tasks/${taskId}/cancel`,
        { method: 'POST' },
      )
    },

    retryTask(docId: string, taskId: string) {
      return request<{ task: ConvertTask }>(
        `/api/docs/${encodeURIComponent(docId)}/tasks/${taskId}/retry`,
        { method: 'POST' },
      )
    },

    async download(task: ConvertTask): Promise<void> {
      const res = await fetch(task.result!.downloadUrl, { headers: headers() })
      if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', '下载失败')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = task.result!.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    },

    audit(docId: string, limit = 200) {
      return request<{ entries: AuditEntry[] }>(
        `/api/docs/${encodeURIComponent(docId)}/audit?limit=${limit}`,
      )
    },
  }
}

export type TransferApi = ReturnType<typeof createTransferApi>
