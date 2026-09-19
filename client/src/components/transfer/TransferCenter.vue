<script setup lang="ts">
/**
 * 文档导入导出与异步转换中心（抽屉）。
 * 四个页签：导入（预览/差异/确认）、导出（三变体）、任务（重试/取消/下载）、审计。
 */
import { computed } from 'vue'
import { useTransferStore } from '@/stores/transfer'
import ImportPane from './ImportPane.vue'
import ExportPane from './ExportPane.vue'
import TasksPane from './TasksPane.vue'
import AuditPane from './AuditPane.vue'

const transfer = useTransferStore()

const busyCount = computed(
  () => transfer.tasks.filter((t) => ['pending', 'running', 'retrying'].includes(t.status)).length,
)
</script>

<template>
  <el-drawer
    :model-value="transfer.drawerOpen"
    title="文档导入导出 · 异步转换中心"
    direction="rtl"
    size="62%"
    class="transfer-drawer"
    :before-close="(done: () => void) => { transfer.close(); done() }"
  >
    <el-tabs v-model="transfer.tab" class="transfer-tabs">
      <el-tab-pane name="import">
        <template #label>
          <span>📥 导入</span>
        </template>
        <ImportPane v-if="transfer.tab === 'import'" />
      </el-tab-pane>

      <el-tab-pane name="export" label="📤 导出">
        <ExportPane v-if="transfer.tab === 'export'" />
      </el-tab-pane>

      <el-tab-pane name="tasks">
        <template #label>
          <span>⚙️ 任务
            <el-badge v-if="busyCount" :value="busyCount" type="warning" />
          </span>
        </template>
        <TasksPane v-if="transfer.tab === 'tasks'" />
      </el-tab-pane>

      <el-tab-pane name="audit" label="📜 审计">
        <AuditPane v-if="transfer.tab === 'audit'" />
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.transfer-tabs :deep(.el-drawer__body) {
  overflow: auto;
}
</style>
