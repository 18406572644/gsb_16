<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useConvertStore } from '@/stores/convert'
import { EXPORT_FORMAT_LABEL, type ExportFormat, type ExportVariant } from '../../../shared/convert'

const store = useConvertStore()

const format = ref<ExportFormat>('html')
const variant = ref<ExportVariant>('current')
const revision = ref<number | null>(null)
const forceAsync = ref(false)
const exporting = ref(false)

const revisionOptions = computed(() =>
  [...store.revisions]
    .sort((a, b) => b.revision - a.revision)
    .slice(0, 200)
    .map((r) => ({
      value: r.revision,
      label: `v${r.revision} · ${r.authorName} · ${fmtTs(r.ts)}${r.external ? ` · ${r.external.kind === 'import' ? '导入' : '回滚'}` : ''}`,
    })),
)

const variantHint = computed(() => {
  if (variant.value === 'current') return '导出协作正文当前最新版本。'
  if (variant.value === 'revision') return '依据服务端保存的操作历史重建指定版本正文（保留最近 1000 个版本）。'
  return '在当前版本上内联高亮批注锚点并附批注清单（含回复、作者、状态）；锚点已删除的批注列入清单。'
})

watch(
  () => store.exportVisible,
  (v) => {
    if (v) {
      format.value = 'html'
      variant.value = 'current'
      revision.value = store.revisions.length ? store.revisions[store.revisions.length - 1]!.revision : null
      void store.loadRevisions()
    }
  },
)

function fmtTs(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function doExport() {
  if (variant.value === 'revision' && revision.value === null) {
    ElMessage.warning('请选择要导出的历史版本')
    return
  }
  exporting.value = true
  try {
    await store.exportDoc({
      format: format.value,
      variant: variant.value,
      revision: variant.value === 'revision' ? revision.value! : undefined,
      async: forceAsync.value,
    })
    if (!forceAsync.value) store.exportVisible = false
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="store.exportVisible" title="导出文档" width="560px" :close-on-click-modal="false">
    <el-form label-position="top">
      <el-form-item label="导出格式">
        <el-radio-group v-model="format">
          <el-radio-button v-for="(label, key) in EXPORT_FORMAT_LABEL" :key="key" :value="key">
            {{ label }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="导出版本">
        <el-radio-group v-model="variant">
          <el-radio value="current">当前版本</el-radio>
          <el-radio value="revision">历史版本</el-radio>
          <el-radio value="annotated">带批注版本</el-radio>
        </el-radio-group>
      </el-form-item>

      <div class="hint">{{ variantHint }}</div>

      <el-form-item v-if="variant === 'revision'" label="选择版本" style="margin-top: 12px">
        <el-select v-model="revision" filterable placeholder="选择历史版本" style="width: 100%">
          <el-option
            v-for="o in revisionOptions"
            :key="o.value"
            :value="o.value"
            :label="o.label"
          />
        </el-select>
        <div v-if="!revisionOptions.length" class="hint" style="margin-top: 6px">
          当前文档尚无已记录的版本步进（服务端重启前的历史操作不保留）。
        </div>
      </el-form-item>

      <el-form-item v-if="variant === 'annotated' && format !== 'html'" style="margin-top: 4px">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          :title="format === 'txt' ? 'TXT 批注版将在正文后追加纯文本批注清单' : 'Markdown 批注版将在正文后追加批注清单章节'"
        />
      </el-form-item>

      <el-form-item style="margin-top: 8px">
        <el-checkbox v-model="forceAsync">走异步任务（长文档推荐：可在任务中心查看进度、失败重试、取消）</el-checkbox>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="store.exportVisible = false">取消</el-button>
      <el-button type="primary" :loading="exporting" @click="doExport">导出</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.hint { color: #909399; font-size: 12px; line-height: 1.7; }
</style>
