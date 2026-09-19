<script setup lang="ts">
/**
 * 导入面板：上传 → 轮询任务 → 展示解析预览（元信息 / 兼容性警告 / 结构差异）
 * → 用户可微调待确认文本 → 确认后作为协同变更提交（绝不直接覆盖正文）。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { useTransferStore } from '@/stores/transfer'
import { FORMAT_LABEL } from '../../../../shared/transfer'
import type { ConvertTask } from '../../../../shared/transfer'

const session = useSessionStore()
const doc = useDocStore()
const transfer = useTransferStore()

const uploading = ref(false)
const selectedTaskId = ref<string | null>(null)
const editableText = ref('')
const showFullText = ref(false)

// 从「任务」页点击「查看预览」跳过来时同步选中
watch(
  () => transfer.previewTaskId,
  (id) => {
    if (id) {
      selectedTaskId.value = id
      showFullText.value = false
      transfer.previewTaskId = null
    }
  },
)
// 选中任务后，让列表轮询携带 full 参数返回完整预览数据
watch(selectedTaskId, (id) => {
  transfer.fullTaskId = id
  if (id) void transfer.refreshTasks()
})

const activeTask = computed<ConvertTask | undefined>(() =>
  selectedTaskId.value ? transfer.tasks.find((t) => t.id === selectedTaskId.value) : undefined,
)
const preview = computed(() => activeTask.value?.preview)
const isDone = computed(() => activeTask.value?.status === 'succeeded' && preview.value && !activeTask.value?.discardedAt)

async function onUpload(file: File) {
  if (!session.canEdit) {
    ElMessage.error('当前身份无编辑权限，无法导入（需要「编辑」身份）')
    return false
  }
  uploading.value = true
  try {
    const r = await transfer.api.createImport(session.docId, file)
    selectedTaskId.value = r.task.id
    ElMessage.success('已创建导入任务，正在后台解析…')
    await transfer.refreshTasks()
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    uploading.value = false
  }
  return false // 阻止 el-upload 默认上传
}

function startEdit() {
  if (!preview.value) return
  editableText.value = preview.value.text
  showFullText.value = true
}

async function confirmImport() {
  if (!activeTask.value) return
  const p = preview.value!
  const finalText = showFullText.value ? editableText.value : p.text
  const stats = p.diff.stats
  try {
    await ElMessageBox.confirm(
      `确认导入将作为一条协同变更提交：基于 v${p.baseRevision}，` +
        `新增 ${stats.inserted} 行、删除 ${stats.deleted} 行。在线协作者会实时收到该变更。`,
      '确认导入到协作正文',
      { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '再看看' },
    )
  } catch {
    return
  }
  try {
    const r = await transfer.api.confirmImport(session.docId, activeTask.value.id, { text: finalText })
    ElMessage.success(`导入已提交：v${r.baseRevision} → v${r.revision}`)
    selectedTaskId.value = null
    showFullText.value = false
    await transfer.refreshAll()
  } catch (e) {
    ElMessage.error(`导入失败：${(e as Error).message}`)
  }
}

async function discard() {
  if (!activeTask.value) return
  try {
    await ElMessageBox.confirm('放弃后该预览不可再确认（可重新上传）。确定放弃吗？', '放弃导入', {
      type: 'warning',
    })
  } catch {
    return
  }
  await transfer.api.discardImport(session.docId, activeTask.value.id)
  selectedTaskId.value = null
  showFullText.value = false
  ElMessage.info('已放弃导入预览')
  await transfer.refreshTasks()
}

const diffRows = computed(() => preview.value?.diff.lines ?? [])
const changePct = computed(() => {
  const s = preview.value?.diff.stats
  if (!s || s.totalLines === 0) return 0
  return Math.round(((s.inserted + s.deleted) / s.totalLines) * 100)
})

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <div class="pane">
    <!-- 上传区 -->
    <el-upload
      drag
      :show-file-list="false"
      :before-upload="onUpload"
      accept=".txt,.text,.log,.md,.markdown,.mkd,.htm,.html,.xhtml,.docx"
      :disabled="uploading || !session.canEdit"
    >
      <div class="upload-inner">
        <div class="upload-icon">📥</div>
        <div>拖拽文件到此处，或<em>点击选择</em></div>
        <div class="upload-hint">支持 TXT / Markdown / HTML / DOCX，单个文件 ≤ 50MB</div>
      </div>
    </el-upload>
    <el-alert
      v-if="!session.canEdit"
      type="info"
      :closable="false"
      title="当前为只读/批注身份，仅可导出；导入需要「编辑」身份"
      style="margin-top: 8px"
    />

    <!-- 最近导入任务快捷选择 -->
    <div v-if="transfer.tasks.filter((t) => t.kind === 'import').length" class="recent-tasks">
      <div class="section-label">最近的导入任务</div>
      <el-scrollbar max-height="120px">
        <div
          v-for="t in transfer.tasks.filter((t) => t.kind === 'import').slice(0, 8)"
          :key="t.id"
          class="recent-item"
          :class="{ active: t.id === selectedTaskId }"
          @click="selectedTaskId = t.id; showFullText = false"
        >
          <el-tag size="small" effect="plain">{{ FORMAT_LABEL[t.format] }}</el-tag>
          <span class="recent-name" :title="t.sourceName">{{ t.sourceName }}</span>
          <el-tag
            size="small"
            :type="
              t.status === 'succeeded'
                ? 'success'
                : t.status === 'failed'
                  ? 'danger'
                  : t.status === 'canceled'
                    ? 'info'
                    : 'warning'
            "
          >
            {{ t.status === 'running' || t.status === 'pending' ? t.progress.phase : t.status }}
          </el-tag>
        </div>
      </el-scrollbar>
    </div>

    <!-- 任务状态 -->
    <template v-if="activeTask">
      <el-divider />
      <div v-if="activeTask.status === 'succeeded' && activeTask.discardedAt" class="state-box">
        该预览已放弃或已确认导入，可在「任务」页查看记录。
      </div>

      <template v-else-if="isDone && preview">
        <!-- 解析元信息 -->
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="源文件">{{ activeTask.sourceName }}</el-descriptions-item>
          <el-descriptions-item label="格式">{{ FORMAT_LABEL[activeTask.format] }}</el-descriptions-item>
          <el-descriptions-item label="编码">{{ preview.encoding }}</el-descriptions-item>
          <el-descriptions-item label="换行">{{ preview.lineEnding }}</el-descriptions-item>
          <el-descriptions-item label="字符数">{{ preview.stats.chars.toLocaleString() }}</el-descriptions-item>
          <el-descriptions-item label="行数">{{ preview.stats.lines.toLocaleString() }}</el-descriptions-item>
          <el-descriptions-item label="链接">{{ preview.stats.links }}</el-descriptions-item>
          <el-descriptions-item label="图片占位">{{ preview.stats.images }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-for="(w, i) in preview.warnings"
          :key="i"
          class="warn-item"
          type="warning"
          :closable="false"
          :title="w.message"
        />

        <!-- 结构差异摘要 -->
        <div class="diff-summary">
          <span class="section-label">结构差异（基于当前正文 v{{ preview.baseRevision }}，当前正文 v{{ doc.revision }}）</span>
          <el-progress :percentage="changePct" :stroke-width="8" :show-text="false" status="warning" />
          <div class="diff-counts">
            <el-tag type="success" size="small">+ {{ preview.diff.stats.inserted }} 行</el-tag>
            <el-tag type="danger" size="small">- {{ preview.diff.stats.deleted }} 行</el-tag>
            <el-tag type="info" size="small">= {{ preview.diff.stats.equal }} 行</el-tag>
            <span class="muted">
              {{ preview.stats.chars.toLocaleString() }} / 当前 {{ preview.diff.stats.oldChars.toLocaleString() }} 字符
            </span>
          </div>
        </div>

        <!-- 差异视图 / 全文编辑 -->
        <el-radio-group v-model="showFullText" size="small" style="margin: 8px 0">
          <el-radio-button :value="false">结构差异</el-radio-button>
          <el-radio-button :value="true" @click="startEdit">待确认文本（可微调）</el-radio-button>
        </el-radio-group>

        <div v-if="!showFullText" class="diff-box">
          <div class="diff-head">
            <span class="col-no">旧#</span><span class="col-no">新#</span><span>内容</span>
          </div>
          <el-scrollbar max-height="320px">
            <div
              v-for="(l, i) in diffRows"
              :key="i"
              class="diff-line"
              :class="l.op"
            >
              <template v-if="l.op === 'skip'">
                <span class="skip" :colspan="3">··· 折叠 {{ l.skipped }} 行未变化内容 ···</span>
              </template>
              <template v-else>
                <span class="col-no">{{ l.oldNo >= 0 ? l.oldNo + 1 : '' }}</span>
                <span class="col-no">{{ l.newNo >= 0 ? l.newNo + 1 : '' }}</span>
                <span class="diff-text">{{ l.text || ' ' }}</span>
              </template>
            </div>
          </el-scrollbar>
        </div>

        <el-input
          v-else
          v-model="editableText"
          type="textarea"
          :rows="16"
          spellcheck="false"
          class="preview-textarea"
        />

        <div class="action-row">
          <el-button @click="discard">放弃</el-button>
          <el-button type="primary" @click="confirmImport">
            确认作为协同变更提交
          </el-button>
        </div>
      </template>

      <!-- 进行中 -->
      <div v-else-if="['pending', 'running', 'retrying'].includes(activeTask.status)" class="state-box">
        <el-progress :percentage="activeTask.progress.percent" :stroke-width="10" status="success" />
        <p class="muted">{{ activeTask.progress.phase }}
          <span v-if="activeTask.status === 'retrying'">（自动重试 {{ activeTask.attempts }}/{{ activeTask.maxAttempts }}）</span>
        </p>
        <el-alert
          v-for="(h, i) in activeTask.history"
          :key="i"
          type="error"
          :closable="false"
          :title="h.message"
          class="warn-item"
        />
      </div>

      <div v-else-if="activeTask.status === 'failed'" class="state-box">
        <el-alert type="error" :closable="false" :title="activeTask.error?.message || '解析失败'" />
        <p class="muted">可在「任务」页点击重试，或重新上传文件。</p>
      </div>

      <div v-else-if="activeTask.status === 'canceled'" class="state-box">任务已取消。</div>
    </template>

    <div v-else class="state-box muted">
      上传的文档不会直接修改正文：先解析出预览与结构差异，确认后才会作为协同变更进入版本体系。
    </div>
  </div>
</template>

<style scoped>
.upload-inner { padding: 8px 0; }
.upload-icon { font-size: 34px; line-height: 1.4; }
.upload-inner em { color: var(--el-color-primary); font-style: normal; }
.upload-hint { color: #909399; font-size: 12px; margin-top: 4px; }
.section-label { font-size: 12px; color: #909399; font-weight: 600; }
.recent-tasks { margin-top: 12px; }
.recent-item {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  border-radius: 6px; cursor: pointer; font-size: 13px;
}
.recent-item:hover { background: #f5f7fa; }
.recent-item.active { background: #ecf5ff; }
.recent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn-item { margin-top: 6px; }
.state-box {
  padding: 20px; text-align: center; color: #606266; background: #fafbfc;
  border: 1px dashed #dcdfe6; border-radius: 8px; margin-top: 12px;
}
.diff-summary { margin-top: 12px; }
.diff-counts { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.muted { color: #909399; font-size: 12px; }
.diff-box { border: 1px solid #ebeef5; border-radius: 6px; overflow: hidden; font-size: 12px; }
.diff-head, .diff-line { display: flex; align-items: stretch; }
.diff-head { background: #f5f7fa; color: #909399; font-weight: 600; }
.col-no {
  width: 52px; min-width: 52px; padding: 1px 6px; text-align: right;
  color: #b0b3bb; border-right: 1px solid #f0f1f3; user-select: none;
}
.diff-text { flex: 1; padding: 1px 8px; white-space: pre-wrap; word-break: break-all; }
.diff-line.insert { background: #f0f9eb; }
.diff-line.insert .diff-text::before { content: '+ '; color: #67c23a; }
.diff-line.delete { background: #fef0f0; }
.diff-line.delete .diff-text::before { content: '- '; color: #f56c6c; }
.diff-line.equal .diff-text { color: #606266; }
.skip { flex: 1; text-align: center; color: #c0c4cc; padding: 4px; }
.preview-textarea :deep(textarea) { font-family: 'JetBrains Mono', Consolas, monospace; line-height: 1.6; }
.action-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
