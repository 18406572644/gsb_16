<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useConvertStore } from '@/stores/convert'
import { useSessionStore } from '@/stores/session'
import { IMPORT_FORMAT_LABEL } from '../../../shared/convert'

const store = useConvertStore()
const session = useSessionStore()

const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
/** 差异渲染上限（超长文档避免一次渲染上万行） */
const RENDER_CAP = 3000
const renderAll = ref(false)

const ACCEPT = '.txt,.md,.markdown,.htm,.html,.docx,.pptx,.xlsx'

const visibleDiff = computed(() => {
  const d = store.preview?.diff ?? []
  return renderAll.value ? d : d.slice(0, RENDER_CAP)
})
const hiddenCount = computed(() => Math.max(0, (store.preview?.diff.length ?? 0) - RENDER_CAP))

const diffCounts = computed(() => {
  const c = { added: 0, removed: 0, equal: 0 }
  for (const b of store.preview?.diff ?? []) c[b.type]++
  return c
})

function pickFile() {
  if (!session.canEdit) {
    ElMessage.warning('仅编辑角色可以导入文档')
    return
  }
  fileInput.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await store.upload(file)
}

async function onDrop(e: DragEvent) {
  dragOver.value = false
  if (!session.canEdit) {
    ElMessage.warning('仅编辑角色可以导入文档')
    return
  }
  const file = e.dataTransfer?.files?.[0]
  if (file) await store.upload(file)
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
</script>

<template>
  <el-dialog
    v-model="store.importVisible"
    title="导入文档"
    width="80%"
    top="6vh"
    :close-on-click-modal="false"
    @close="store.importVisible = false"
  >
    <!-- 上传区（尚无预览） -->
    <div v-if="!store.preview" class="upload-stage">
      <div
        class="dropzone"
        :class="{ over: dragOver, disabled: !session.canEdit }"
        @click="pickFile"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          :accept="ACCEPT"
          hidden
          @change="onFileChange"
        />
        <div class="dz-icon">📥</div>
        <div v-if="store.uploading" class="dz-text">
          上传与解析中… {{ store.uploadPercent }}%
          <el-progress :percentage="store.uploadPercent" :stroke-width="6" style="max-width: 320px; margin: 10px auto" />
        </div>
        <template v-else>
          <div class="dz-text">点击选择文件，或将文件拖拽到此处</div>
          <div class="dz-sub">
            支持 {{ Object.values(IMPORT_FORMAT_LABEL).join('、') }}，单文件上限 50MB
          </div>
        </template>
      </div>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="导入不会直接覆盖正文：先解析生成预览与结构差异，确认后才作为协同变更提交"
        style="margin-top: 14px"
      />
    </div>

    <!-- 预览与差异 -->
    <div v-else class="preview-stage">
      <div class="preview-head">
        <div>
          <div class="pv-title">📄 {{ store.preview.sourceName }}</div>
          <div class="pv-meta">
            <el-tag size="small" effect="plain">{{ IMPORT_FORMAT_LABEL[store.preview.format] }}</el-tag>
            <span>{{ fmtSize(store.preview.sourceSize) }}</span>
            <span>{{ store.preview.stats.chars }} 字 / {{ store.preview.stats.lines }} 行</span>
            <span>🔗 {{ store.preview.stats.links }}</span>
            <span>🖼 {{ store.preview.stats.images }}</span>
            <span>基准版本 v{{ store.preview.baseRevision }}</span>
          </div>
        </div>
        <div>
          <el-tag type="success" size="small" effect="light">+{{ diffCounts.added }} 新增行</el-tag>
          <el-tag type="danger" size="small" effect="light" style="margin-left: 6px">-{{ diffCounts.removed }} 删除行</el-tag>
        </div>
      </div>

      <el-alert
        v-if="store.previewStale"
        type="warning"
        show-icon
        :closable="false"
        style="margin: 10px 0"
      >
        <div style="display: flex; align-items: center; gap: 12px">
          <span>预览生成后协作正文已演进到新版本，请刷新差异后再确认。</span>
          <el-button size="small" type="warning" @click="store.refreshPreview()">刷新差异</el-button>
        </div>
      </el-alert>

      <el-alert
        v-for="(w, i) in store.preview.stats.warnings"
        :key="i"
        type="warning"
        :closable="false"
        show-icon
        :title="w"
        style="margin: 6px 0"
      />

      <div class="diff-wrap">
        <div class="diff-line" v-for="(b, i) in visibleDiff" :key="i" :class="b.type">
          <span class="ln old">{{ b.oldLine !== null ? b.oldLine + 1 : '' }}</span>
          <span class="ln new">{{ b.newLine !== null ? b.newLine + 1 : '' }}</span>
          <span class="sign">{{ b.type === 'equal' ? ' ' : b.type === 'added' ? '+' : '-' }}</span>
          <span class="diff-text">{{ b.text || ' ' }}</span>
        </div>
        <div v-if="hiddenCount > 0" class="diff-more">
          <el-button v-if="!renderAll" text type="primary" @click="renderAll = true">
            还有 {{ hiddenCount }} 行差异，点击全部展开
          </el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="store.preview">
        <el-button @click="store.discard()">放弃导入</el-button>
        <el-button :disabled="store.previewStale" @click="store.refreshPreview()">刷新差异</el-button>
        <el-button
          type="primary"
          :loading="store.confirming"
          :disabled="!session.canEdit || store.previewStale"
          @click="store.confirm()"
        >
          确认导入（作为协同变更提交）
        </el-button>
      </template>
      <el-button v-else @click="store.importVisible = false">取消</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dropzone {
  border: 2px dashed #c0c4cc;
  border-radius: 10px;
  padding: 48px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s, background .2s;
}
.dropzone:hover, .dropzone.over { border-color: #409eff; background: #f0f7ff; }
.dropzone.disabled { opacity: .6; cursor: not-allowed; }
.dz-icon { font-size: 40px; }
.dz-text { font-size: 15px; margin-top: 10px; color: #303133; }
.dz-sub { color: #909399; font-size: 12px; margin-top: 8px; line-height: 1.8; }

.preview-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.pv-title { font-weight: 600; font-size: 15px; }
.pv-meta { display: flex; gap: 10px; align-items: center; color: #909399; font-size: 12px; margin-top: 6px; flex-wrap: wrap; }

.diff-wrap {
  margin-top: 12px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  max-height: 52vh;
  overflow: auto;
  background: #fafbfc;
  font-family: "SFMono-Regular", Consolas, "Source Han Mono SC", monospace;
  font-size: 12.5px;
  line-height: 1.7;
}
.diff-line { display: flex; white-space: pre-wrap; word-break: break-all; }
.diff-line:hover { background: #f0f2f5; }
.ln {
  flex: 0 0 46px;
  text-align: right;
  padding: 0 8px;
  color: #b0b3b8;
  user-select: none;
  border-right: 1px solid #eee;
}
.sign { flex: 0 0 20px; text-align: center; user-select: none; }
.diff-text { flex: 1; padding-right: 12px; }
.diff-line.added { background: #eafaf0; }
.diff-line.added .sign { color: #1a7f37; }
.diff-line.removed { background: #fef0f0; }
.diff-line.removed .sign { color: #c45656; }
.diff-line.removed .diff-text { color: #8c4b4b; }
.diff-more { text-align: center; padding: 10px; }
</style>
