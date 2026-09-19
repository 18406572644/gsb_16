<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useConvertStore } from '@/stores/convert'
import { TASK_STATUS_LABEL } from '../../../shared/convert'
import type { ConvertTask } from '../../../shared/convert'

const store = useConvertStore()

onMounted(() => {
  void store.refreshTasks()
  void store.loadAudit()
})

const statusType = (s: ConvertTask['status']) => {
  switch (s) {
    case 'succeeded': return 'success'
    case 'failed': return 'danger'
    case 'cancelled': return 'info'
    case 'processing': return 'primary'
    case 'retrying': return 'warning'
    default: return 'info'
  }
}

const isActive = (t: ConvertTask) => t.status === 'queued' || t.status === 'processing' || t.status === 'retrying'

function fmtTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtSize(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const AUDIT_LABEL: Record<string, string> = {
  'import.upload': '导入上传',
  'import.confirm': '导入确认',
  'import.cancel': '导入放弃',
  'export.run': '导出执行',
  'export.download': '产物下载',
  'task.create': '任务创建',
  'task.retry': '任务重试',
  'task.cancel': '任务取消',
  'task.fail': '任务失败',
  'task.done': '任务完成',
}

const activeAudit = computed(() => store.audit)

function compactDetail(d: Record<string, unknown>): string {
  const keys: Record<string, string> = {
    sourceName: '文件',
    format: '格式',
    size: '大小',
    chars: '字符',
    lines: '行数',
    revision: '版本',
    current: '当前版本',
    added: '新增行',
    removed: '删除行',
    kind: '类型',
    variant: '变体',
    attempts: '尝试次数',
    taskId: '任务',
  }
  return Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${keys[k] || k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('，')
}
</script>

<template>
  <el-drawer
    v-model="store.taskCenterVisible"
    title="异步转换任务中心"
    direction="rtl"
    size="560px"
    @open="store.startPolling()"
    @close="if (store.activeTaskCount === 0) store.stopPolling()"
  >
    <el-tabs>
      <!-- 任务 -->
      <el-tab-pane :label="`任务（${store.activeTaskCount}）`">
        <el-button size="small" text type="primary" @click="store.refreshTasks()">刷新</el-button>
        <el-empty v-if="!store.tasks.length" description="暂无转换任务" :image-size="70" />
        <div class="task-list">
          <el-card v-for="t in store.tasks" :key="t.id" class="task-card" shadow="never">
            <div class="t-row">
              <span class="t-icon">{{ t.kind === 'import' ? '📥' : '📤' }}</span>
              <span class="t-name" :title="t.fileName">{{ t.fileName }}</span>
              <el-tag :type="statusType(t.status)" size="small" effect="light">
                {{ TASK_STATUS_LABEL[t.status] }}
              </el-tag>
            </div>
            <div class="t-meta">
              <span>{{ t.kind === 'import' ? '导入' : '导出' }} · {{ t.format.toUpperCase() }}</span>
              <span v-if="t.variant && t.variant !== 'current'">
                · {{ t.variant === 'annotated' ? '批注版' : `v${t.revision}` }}
              </span>
              <span>· {{ t.ownerName }}</span>
              <span v-if="t.resultSize">· {{ fmtSize(t.resultSize) }}</span>
            </div>
            <div class="t-meta sub">
              <span>第 {{ t.attempts }}/{{ t.maxAttempts }} 次尝试</span>
              <span>创建 {{ fmtTime(t.createdAt) }}</span>
              <span v-if="t.finishedAt">结束 {{ fmtTime(t.finishedAt) }}</span>
            </div>
            <el-progress
              v-if="isActive(t)"
              :percentage="t.status === 'processing' ? 80 : 30"
              :status="t.status === 'retrying' ? 'warning' : undefined"
              :stroke-width="4"
              :indeterminate="t.status === 'processing'"
              style="margin-top: 6px"
            />
            <div v-if="t.error" class="t-error" :title="t.error">⚠ {{ t.error }}</div>
            <div class="t-actions">
              <el-button
                v-if="t.kind === 'export' && t.status === 'succeeded' && t.resultId"
                size="small" type="primary" plain
                @click="store.download(t.id, t.fileName)"
              >
                下载产物
              </el-button>
              <el-button
                v-if="t.status === 'failed' || t.status === 'cancelled'"
                size="small" type="warning" plain
                @click="store.retry(t.id)"
              >
                重试
              </el-button>
              <el-button
                v-if="isActive(t)"
                size="small" type="danger" plain
                @click="store.cancel(t.id)"
              >
                取消任务
              </el-button>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- 审计 -->
      <el-tab-pane label="操作审计">
        <el-button size="small" text type="primary" @click="store.loadAudit()">刷新</el-button>
        <el-timeline class="audit-list">
          <el-timeline-item
            v-for="r in activeAudit"
            :key="r.id"
            :type="r.ok ? 'success' : 'danger'"
            :timestamp="fmtTime(r.ts)"
            placement="top"
          >
            <div class="a-title">
              <el-tag size="small" :type="r.ok ? 'success' : 'danger'" effect="plain">
                {{ AUDIT_LABEL[r.action] || r.action }}
              </el-tag>
              <span class="a-actor">{{ r.actor }}</span>
            </div>
            <div v-if="r.detail && Object.keys(r.detail).length" class="a-detail">
              {{ compactDetail(r.detail) }}
            </div>
            <div v-if="r.error" class="a-err">失败原因：{{ r.error }}</div>
          </el-timeline-item>
        </el-timeline>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.task-list { margin-top: 8px; display: flex; flex-direction: column; gap: 10px; }
.task-card { border: 1px solid #ebeef5; }
.t-row { display: flex; align-items: center; gap: 8px; }
.t-icon { font-size: 16px; }
.t-name { font-weight: 600; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-meta { display: flex; gap: 8px; flex-wrap: wrap; color: #909399; font-size: 12px; margin-top: 4px; }
.t-meta.sub { color: #b0b3b8; }
.t-error { color: #c45656; font-size: 12px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-actions { margin-top: 8px; display: flex; gap: 8px; }
.a-title { display: flex; align-items: center; gap: 8px; }
.a-actor { font-size: 12px; color: #606266; }
.a-detail { font-size: 12px; color: #909399; margin-top: 3px; line-height: 1.6; word-break: break-all; }
.a-err { font-size: 12px; color: #c45656; margin-top: 3px; }
</style>
