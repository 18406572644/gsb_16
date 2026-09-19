<script setup lang="ts">
/**
 * 导出面板：格式（txt/md/html/docx）× 变体（当前/历史/带批注）。
 * 历史版本从文档信息的 history 点中选择；提交后生成异步导出任务，可在本页直接下载。
 */
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useTransferStore } from '@/stores/transfer'
import {
  EXPORT_VARIANT_LABEL,
  FORMAT_LABEL,
  type DocFormat,
  type ExportVariant,
} from '../../../../shared/transfer'

const session = useSessionStore()
const transfer = useTransferStore()

const format = ref<DocFormat>('docx')
const variant = ref<ExportVariant>('current')
const revision = ref<number | undefined>(undefined)
const submitting = ref(false)

const formats: DocFormat[] = ['docx', 'md', 'html', 'txt']
const variants: { value: ExportVariant; desc: string }[] = [
  { value: 'current', desc: '导出当前最新正文' },
  { value: 'history', desc: '导出指定历史修订（周期性快照重建）' },
  { value: 'annotated', desc: '正文 + 批注锚点高亮 + 批注清单' },
]

const historyPoints = computed(() => transfer.docInfo?.history ?? [])
const annCount = computed(() => transfer.docInfo?.annotations.length ?? 0)

const exportTasks = computed(() =>
  transfer.tasks.filter((t) => t.kind === 'export').slice(0, 10),
)

async function submit() {
  if (variant.value === 'history' && revision.value === undefined) {
    ElMessage.warning('请选择要导出的历史修订号')
    return
  }
  submitting.value = true
  try {
    await transfer.api.createExport(session.docId, {
      format: format.value,
      variant: variant.value,
      revision: variant.value === 'history' ? revision.value : undefined,
    })
    ElMessage.success('导出任务已创建，完成后可在下方下载（产物保留 30 分钟）')
    await transfer.refreshTasks()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    submitting.value = false
  }
}

async function download(taskId: string) {
  const t = transfer.tasks.find((x) => x.id === taskId)
  if (!t?.result) return
  try {
    await transfer.api.download(t)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

function fmtTime(ts: number | null) {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtSize(n?: number) {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <div class="pane">
    <div class="card">
      <div class="section-label">1. 选择格式</div>
      <el-radio-group v-model="format" class="fmt-group">
        <el-radio-button v-for="f in formats" :key="f" :value="f" size="large">
          {{ FORMAT_LABEL[f] }}
        </el-radio-button>
      </el-radio-group>

      <div class="section-label" style="margin-top: 16px">2. 导出版本</div>
      <el-radio-group v-model="variant" class="variant-group">
        <el-radio v-for="v in variants" :key="v.value" :value="v.value" border class="variant-radio">
          <b>{{ EXPORT_VARIANT_LABEL[v.value] }}</b>
          <span class="variant-desc">{{ v.desc }}</span>
        </el-radio>
      </el-radio-group>

      <div v-if="variant === 'history'" class="rev-select">
        <el-select v-model="revision" placeholder="选择历史修订号" filterable size="default" style="width: 320px">
          <el-option
            v-for="h in historyPoints"
            :key="h.revision"
            :label="`v${h.revision}（${h.chars.toLocaleString()} 字符）`"
            :value="h.revision"
          />
        </el-select>
        <span class="muted">服务端按修订快照与操作日志重建该版正文；批注不属于历史版本，不随附。</span>
      </div>

      <el-alert
        v-if="variant === 'annotated' && annCount === 0"
        type="info"
        :closable="false"
        title="当前文档暂无批注，批注版将与普通版内容一致"
        style="margin-top: 10px"
      />

      <div class="submit-row">
        <el-button type="primary" size="large" :loading="submitting" @click="submit">
          创建导出任务
        </el-button>
        <span class="muted">
          中文使用宋体/雅黑字体栈；链接、图片占位、emoji 与特殊字符均按 UTF-8 处理
        </span>
      </div>
    </div>

    <el-divider />
    <div class="section-label">最近的导出任务</div>
    <el-table :data="exportTasks" size="small" empty-text="暂无导出任务" stripe>
      <el-table-column label="格式" width="90">
        <template #default="{ row }">{{ FORMAT_LABEL[row.format as DocFormat] }}</template>
      </el-table-column>
      <el-table-column label="版本" width="120">
        <template #default="{ row }">
          {{ EXPORT_VARIANT_LABEL[row.variant as ExportVariant] }}
          <span v-if="row.revision !== undefined"> v{{ row.revision }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="170">
        <template #default="{ row }">
          <el-tag
            size="small"
            :type="
              row.status === 'succeeded'
                ? 'success'
                : row.status === 'failed'
                  ? 'danger'
                  : row.status === 'canceled' || row.status === 'expired'
                    ? 'info'
                    : 'warning'
            "
          >
            {{ ['pending', 'running', 'retrying'].includes(row.status) ? row.progress.phase : row.status }}
          </el-tag>
          <span v-if="row.status === 'retrying'" class="muted">
            （{{ row.attempts }}/{{ row.maxAttempts }}）
          </span>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="100">
        <template #default="{ row }">{{ fmtSize(row.result?.size) }}</template>
      </el-table-column>
      <el-table-column label="时间" width="130">
        <template #default="{ row }">{{ fmtTime(row.finishedAt ?? row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'succeeded' && row.result"
            size="small"
            type="primary"
            text
            @click="download(row.id)"
          >
            下载
          </el-button>
          <span v-else-if="row.status === 'failed'" class="muted">{{ row.error?.message }}</span>
          <span v-else-if="row.status === 'expired'" class="muted">产物已过期，请重新导出</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.card {
  background: #fafbfc;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 14px 16px;
}
.section-label { font-size: 13px; font-weight: 600; color: #606266; margin-bottom: 8px; }
.fmt-group { width: 100%; }
.fmt-group :deep(.el-radio-button) { flex: 1; }
.fmt-group :deep(.el-radio-button__inner) { width: 100%; }
.variant-group { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.variant-radio { height: auto; padding: 8px 12px; margin-right: 0 !important; }
.variant-radio :deep(.el-radio__label) { display: flex; flex-direction: column; gap: 2px; }
.variant-desc { color: #909399; font-size: 12px; font-weight: normal; }
.rev-select { margin-top: 10px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.muted { color: #909399; font-size: 12px; }
.submit-row { margin-top: 18px; display: flex; align-items: center; gap: 14px; }
</style>
