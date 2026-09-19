/**
 * 转换中心状态：导入预览、异步任务轮询、审计记录、弹窗开关。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import {
  cancelTask as apiCancelTask,
  confirmPreview as apiConfirm,
  discardPreview as apiDiscard,
  downloadTaskResult,
  getImportTask,
  listAudit,
  listTasks,
  refreshPreview as apiRefresh,
  retryTask as apiRetryTask,
  runExport,
  uploadImport,
  triggerDownload,
  type Actor,
} from '@/api/convert'
import type {
  AuditRecord,
  ConvertTask,
  ExportRequestBody,
  ImportPreview,
  RevisionInfo,
} from '../../../shared/convert'
import { listRevisions } from '@/api/convert'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'

const ACTIVE_STATUSES = new Set(['queued', 'processing', 'retrying'])

export const useConvertStore = defineStore('convert', () => {
  const session = useSessionStore()
  const doc = useDocStore()

  const importVisible = ref(false)
  const exportVisible = ref(false)
  const taskCenterVisible = ref(false)

  /** 当前导入预览（可能来自同步上传或异步任务完成） */
  const preview = ref<ImportPreview | null>(null)
  const uploading = ref(false)
  const uploadPercent = ref(0)
  const confirming = ref(false)
  /** 正在跟踪的异步导入任务 */
  const pendingImportTaskId = ref<string | null>(null)

  const tasks = ref<ConvertTask[]>([])
  const audit = ref<AuditRecord[]>([])
  const revisions = ref<RevisionInfo[]>([])
  const tasksLoading = ref(false)

  const actor = computed<Actor>(() => ({ name: session.name || '匿名', role: session.role }))
  const activeTaskCount = computed(() => tasks.value.filter((t) => ACTIVE_STATUSES.has(t.status)).length)
  const previewStale = computed(() => !!preview.value && preview.value.baseRevision !== doc.revision)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling(immediate = true) {
    if (!pollTimer) {
      pollTimer = setInterval(refreshTasks, 3000)
      if (immediate) void refreshTasks()
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function refreshTasks() {
    if (!session.joined) return
    try {
      const { tasks: list } = await listTasks(session.docId, actor.value)
      tasks.value = list
      // 跟踪中的导入任务完成：拉取预览并打开确认对话框
      if (pendingImportTaskId.value) {
        const t = list.find((x) => x.id === pendingImportTaskId.value)
        if (t?.status === 'succeeded') {
          const { preview: p } = await getImportTask(t.id, actor.value)
          pendingImportTaskId.value = null
          if (p) {
            preview.value = p
            importVisible.value = true
            ElMessage.success(`「${p.sourceName}」解析完成，请确认差异后导入`)
          } else {
            ElMessage.error('任务已完成但预览缺失，请重新上传文件')
          }
        } else if (t?.status === 'failed' || t?.status === 'cancelled') {
          pendingImportTaskId.value = null
          taskCenterVisible.value = true
        }
      }
      // 无活动任务且任务中心关闭：自动停止轮询，避免空转
      if (
        !pendingImportTaskId.value &&
        !taskCenterVisible.value &&
        !list.some((t) => ACTIVE_STATUSES.has(t.status))
      ) {
        stopPolling()
      }
    } catch {
      // 轮询失败静默
    }
  }

  async function loadAudit() {
    try {
      const { records } = await listAudit(session.docId, actor.value, 100)
      audit.value = records
    } catch {
      // 审计加载失败不阻断界面
    }
  }

  async function loadRevisions() {
    try {
      const { revisions: list } = await listRevisions(session.docId, actor.value)
      revisions.value = list
    } catch {
      revisions.value = []
    }
  }

  async function upload(file: File) {
    uploading.value = true
    uploadPercent.value = 0
    try {
      const out = await uploadImport(session.docId, actor.value, file, (p) => (uploadPercent.value = p))
      if (out.preview) {
        preview.value = out.preview
        importVisible.value = true
      } else if (out.taskId) {
        pendingImportTaskId.value = out.taskId
        taskCenterVisible.value = true
        startPolling()
        ElMessage.info('办公文档转换已加入异步任务，完成后自动弹出导入预览')
      }
    } catch (e) {
      ElMessage.error(`导入失败：${(e as Error).message}`)
    } finally {
      uploading.value = false
      uploadPercent.value = 0
    }
  }

  async function refreshPreview() {
    if (!preview.value) return
    try {
      preview.value = await apiRefresh(preview.value.previewId, actor.value)
      ElMessage.success('差异已按最新正文重新计算')
    } catch (e) {
      ElMessage.error((e as Error).message)
    }
  }

  async function confirm(): Promise<boolean> {
    if (!preview.value) return false
    confirming.value = true
    try {
      const r = await apiConfirm(preview.value.previewId, actor.value)
      ElMessage.success(r.changed ? `导入已作为协同变更提交（v${r.revision}）` : '导入内容与当前正文一致，未产生新版本')
      preview.value = null
      importVisible.value = false
      void refreshTasks()
      void loadAudit()
      return true
    } catch (e) {
      ElMessage.error(`确认导入失败：${(e as Error).message}`)
      return false
    } finally {
      confirming.value = false
    }
  }

  async function discard() {
    if (!preview.value) {
      importVisible.value = false
      return
    }
    await apiDiscard(preview.value.previewId, actor.value).catch(() => {})
    ElMessage.info('已放弃本次导入')
    preview.value = null
    importVisible.value = false
  }

  async function exportDoc(body: ExportRequestBody) {
    const out = await runExport(session.docId, actor.value, body)
    if ('taskId' in out) {
      taskCenterVisible.value = true
      startPolling()
      ElMessage.info('长文档导出已加入异步任务，完成后可在任务中心下载')
      return
    }
    triggerDownload(out.blob, out.fileName)
    void loadAudit()
  }

  async function retry(id: string) {
    try {
      await apiRetryTask(id, actor.value)
      ElMessage.success('已重新加入队列')
      await refreshTasks()
      void loadAudit()
    } catch (e) {
      ElMessage.error((e as Error).message)
    }
  }

  async function cancel(id: string) {
    try {
      await apiCancelTask(id, actor.value)
      ElMessage.info('任务取消请求已发送')
      await refreshTasks()
      void loadAudit()
    } catch (e) {
      ElMessage.error((e as Error).message)
    }
  }

  async function download(id: string, fileName: string) {
    try {
      await downloadTaskResult(id, actor.value, fileName)
      await refreshTasks()
      void loadAudit()
    } catch (e) {
      ElMessage.error((e as Error).message)
    }
  }

  function openImport() {
    importVisible.value = true
  }

  function openExport() {
    exportVisible.value = true
    void loadRevisions()
  }

  function openTaskCenter() {
    taskCenterVisible.value = true
    startPolling()
    void refreshTasks()
    void loadAudit()
  }

  function reset() {
    stopPolling()
    preview.value = null
    tasks.value = []
    audit.value = []
    revisions.value = []
    importVisible.value = false
    exportVisible.value = false
    taskCenterVisible.value = false
    pendingImportTaskId.value = null
  }

  return {
    // 状态
    importVisible,
    exportVisible,
    taskCenterVisible,
    preview,
    uploading,
    uploadPercent,
    confirming,
    tasks,
    audit,
    revisions,
    tasksLoading,
    actor,
    activeTaskCount,
    previewStale,
    // 动作
    upload,
    refreshPreview,
    confirm,
    discard,
    exportDoc,
    retry,
    cancel,
    download,
    refreshTasks,
    loadAudit,
    loadRevisions,
    startPolling,
    stopPolling,
    openImport,
    openExport,
    openTaskCenter,
    reset,
  }
})
