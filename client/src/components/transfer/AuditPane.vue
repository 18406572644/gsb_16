<script setup lang="ts">
/** 操作审计记录浏览（当前文档，倒序） */
import { computed } from 'vue'
import { useTransferStore } from '@/stores/transfer'
import type { AuditAction, DocFormat, ExportVariant } from '../../../../shared/transfer'
import { FORMAT_LABEL, EXPORT_VARIANT_LABEL } from '../../../../shared/transfer'

const transfer = useTransferStore()
const entries = computed(() => transfer.auditEntries)

const ACTION_LABEL: Record<AuditAction, string> = {
  'import.submit': '提交导入',
  'import.confirm': '确认导入',
  'import.discard': '放弃导入',
  'export.submit': '创建导出',
  'export.download': '下载产物',
  'task.retry': '手动重试',
  'task.cancel': '取消任务',
  'task.fail': '任务失败',
  'task.timeout': '任务超时',
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function statusType(s: string) {
  return s === 'ok' ? 'success' : s === 'denied' ? 'warning' : 'danger'
}
function statusLabel(s: string) {
  return s === 'ok' ? '成功' : s === 'denied' ? '拒绝' : '失败'
}
</script>

<template>
  <div class="pane">
    <el-table :data="entries" size="small" stripe empty-text="暂无审计记录" max-height="540">
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ fmtTime(row.at) }}</template>
      </el-table-column>
      <el-table-column label="动作" width="110">
        <template #default="{ row }">{{ ACTION_LABEL[row.action as AuditAction] ?? row.action }}</template>
      </el-table-column>
      <el-table-column label="操作者" width="110">
        <template #default="{ row }">
          {{ row.actor }}
          <span class="muted">{{ row.role === 'editor' ? '编辑' : row.role === 'commenter' ? '批注' : '只读' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="对象" min-width="150">
        <template #default="{ row }">
          <span v-if="row.format">{{ FORMAT_LABEL[row.format as DocFormat] }}</span>
          <span v-if="row.variant" class="muted">（{{ EXPORT_VARIANT_LABEL[row.variant as ExportVariant] }}）</span>
          <span v-if="row.newRevision !== undefined" class="muted">
            v{{ row.revision }} → v{{ row.newRevision }}
          </span>
          <span v-else-if="row.revision !== undefined" class="muted">v{{ row.revision }}</span>
        </template>
      </el-table-column>
      <el-table-column label="详情" min-width="180">
        <template #default="{ row }">
          <span :title="row.detail">{{ row.detail || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="结果" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <p class="muted tip">审计日志按月滚动持久化在服务端 data/_transfer/audit/，记录导入导出全流程的人与结果。</p>
  </div>
</template>

<style scoped>
.muted { color: #909399; font-size: 12px; }
.tip { margin-top: 10px; }
</style>
