/**
 * 转换中心状态：文档信息（历史版本点）、任务列表与轮询、审计记录。
 * 抽屉打开期间每 1.5s 轮询任务（进行中时），关闭即停止。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { createTransferApi, type TransferApi } from '@/transfer/api'
import { useSessionStore } from '@/stores/session'
import type { AuditEntry, ConvertTask, DocInfoResponse } from '../../../shared/transfer'

export const useTransferStore = defineStore('transfer', () => {
  const session = useSessionStore()
  const api: TransferApi = createTransferApi(() => ({ name: session.name, role: session.role }))

  const drawerOpen = ref(false)
  const tab = ref<'import' | 'export' | 'tasks' | 'audit'>('import')

  const docInfo = ref<DocInfoResponse | null>(null)
  const tasks = ref<ConvertTask[]>([])
  const auditEntries = ref<AuditEntry[]>([])
  const loading = ref(false)
  const lastError = ref('')
  /** 当前正在预览的导入任务 id（列表轮询时携带，以返回完整预览数据） */
  const previewTaskId = ref<string | null>(null)
  /** 与 previewTaskId 同步的完整数据拉取参数 */
  const fullTaskId = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let inFlight = false

  function open(tabName?: typeof tab.value) {
    drawerOpen.value = true
    if (tabName) tab.value = tabName
    refreshAll()
    startPolling()
  }

  function close() {
    drawerOpen.value = false
    fullTaskId.value = null
    stopPolling()
  }

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(() => {
      if (!drawerOpen.value) return
      const busy = tasks.value.some(
        (t) => t.status === 'pending' || t.status === 'running' || t.status === 'retrying',
      )
      if (busy || !inFlight) void refreshTasks(busy)
    }, 1500)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function refreshDocInfo() {
    try {
      docInfo.value = await api.docInfo(session.docId)
    } catch (e) {
      lastError.value = (e as Error).message
    }
  }

  async function refreshTasks(silent = false) {
    if (inFlight) return
    inFlight = true
    try {
      // 仅在任务未终态（需要进度）或尚无完整预览时携带 full，避免大预览反复传输
      let fullId: string | undefined
      if (fullTaskId.value) {
        const t = tasks.value.find((x) => x.id === fullTaskId.value)
        if (!t || ['pending', 'running', 'retrying'].includes(t.status) || !t.preview?.text) {
          fullId = fullTaskId.value
        }
      }
      const r = await api.listTasks(session.docId, fullId)
      // 被裁剪预览的任务（omitted）：保留本地已拉取的完整预览，只更新状态等字段
      const prevById = new Map(tasks.value.map((t) => [t.id, t]))
      tasks.value = r.tasks.map((t) => {
        if (t.preview?.omitted) {
          const old = prevById.get(t.id)
          if (old?.preview && !old.preview.omitted) return { ...t, preview: old.preview }
        }
        return t
      })
    } catch (e) {
      if (!silent) lastError.value = (e as Error).message
    } finally {
      inFlight = false
    }
  }

  async function refreshAudit() {
    try {
      const r = await api.audit(session.docId)
      auditEntries.value = r.entries
    } catch (e) {
      lastError.value = (e as Error).message
    }
  }

  async function refreshAll() {
    loading.value = true
    await Promise.all([refreshDocInfo(), refreshTasks(), refreshAudit()])
    loading.value = false
  }

  function getTask(id: string | null): ConvertTask | undefined {
    if (!id) return undefined
    return tasks.value.find((t) => t.id === id)
  }

  return {
    api,
    drawerOpen,
    tab,
    docInfo,
    tasks,
    auditEntries,
    loading,
    lastError,
    previewTaskId,
    fullTaskId,
    open,
    close,
    startPolling,
    stopPolling,
    refreshDocInfo,
    refreshTasks,
    refreshAudit,
    refreshAll,
    getTask,
  }
})
