<script setup lang="ts">
/**
 * 任务管理：全部转换任务的状态、进度、失败重试、取消、下载。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useTransferStore } from '@/stores/transfer'
import { FORMAT_LABEL, TASK_STATUS_LABEL, type TaskStatus } from '../../../../shared/transfer'
import type { ConvertTask } from '../../../../shared/transfer'

const session = useSessionStore()
const transfer = useTransferStore()

const tasks = computed(() => transfer.tasks)

function tagType(t: ConvertTask) {
  switch (t.status) {
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'danger'
    case 'canceled':
    case 'expired':
      return 'info'
    default:
      return 'warning'
  }
}

function fmtTime(ts: number | null) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const busy = (t: ConvertTask) => ['pending', 'running', 'retrying'].includes(t.status)
const statusLabel = (s: TaskStatus) => TASK_STATUS_LABEL[s]

async function cancel(t: ConvertTask) {
  try {
    await transfer.api.cancelTask(session.docId, t.id)
    ElMessage.success('已请求取消')
    await transfer.refreshTasks()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function retry(t: ConvertTask) {
  try {
    await transfer.api.retryTask(session.docId, t.id)
    ElMessage.success('已重新排队')
    await transfer.refreshTasks()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function download(t: ConvertTask) {
  try {
    await transfer.api.download(t)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
</script>

<template>
  <div class="pane">
    <el-table :data="tasks" size="small" stripe empty-text="暂无转换任务" max-height="520">
      <el-table-column label="类型" width="70">
        <template #default="{ row }">
          <el-tag size="small" :type="row.kind === 'import' ? 'warning' : 'primary'" effect="plain">
            {{ row.kind === 'import' ? '导入' : '导出' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="文件 / 格式" min-width="180">
        <template #default="{ row }">
          <div class="cell-main" :title="row.sourceName">{{ row.sourceName }}</div>
          <div class="muted">{{ FORMAT_LABEL[row.format as keyof typeof FORMAT_LABEL] }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态 / 进度" width="200">
        <template #default="{ row }">
          <el-tag size="small" :type="tagType(row)">{{ statusLabel(row.status as TaskStatus) }}</el-tag>
          <el-progress
            v-if="busy(row)"
            :percentage="row.progress.percent"
            :stroke-width="4"
            :show-text="false"
            style="margin-top: 3px"
          />
          <div v-if="busy(row)" class="muted progress-phase">{{ row.progress.phase }}</div>
          <div v-if="row.status === 'failed'" class="error-text" :title="row.error?.message">
            {{ row.error?.message }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="尝试" width="70">
        <template #default="{ row }">{{ row.attempts }}/{{ row.maxAttempts }}</template>
      </el-table-column>
      <el-table-column label="发起人" width="100">
        <template #default="{ row }">{{ row.ownerName }}</template>
      </el-table-column>
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ fmtTime(row.finishedAt ?? row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button v-if="busy(row)" size="small" text type="warning" @click="cancel(row)">取消</el-button>
          <el-button
            v-if="['failed', 'canceled', 'expired'].includes(row.status)"
            size="small"
            text
            type="primary"
            @click="retry(row)"
          >
            重试
          </el-button>
          <el-button
            v-if="row.status === 'succeeded' && row.kind === 'export' && row.result"
            size="small"
            text
            type="success"
            @click="download(row)"
          >
            下载
          </el-button>
          <el-button
            v-if="row.status === 'succeeded' && row.kind === 'import' && row.preview && !row.discardedAt"
            size="small"
            text
            type="primary"
            @click="transfer.previewTaskId = row.id; transfer.tab = 'import'"
          >
            查看预览
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <p class="muted tip">
      说明：确定性错误（文件损坏/格式不支持）不自动重试；其他失败按 1s/4s/9s 指数退避自动重试，
      最多 3 次；终态后可手动重试。导出产物保留 30 分钟，任务记录保留 24 小时。
    </p>
  </div>
</template>

<style scoped>
.cell-main {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}
.muted { color: #909399; font-size: 12px; }
.progress-phase { margin-top: 2px; }
.error-text {
  color: var(--el-color-danger);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}
.tip { margin-top: 10px; line-height: 1.6; }
</style>
