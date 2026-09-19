<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useConvertStore } from '@/stores/convert'
import LoginGate from '@/components/LoginGate.vue'
import TopBar from '@/components/TopBar.vue'
import EditorView from '@/components/EditorView.vue'
import AnnotationPanel from '@/components/AnnotationPanel.vue'
import ImportDialog from '@/components/ImportDialog.vue'
import ExportDialog from '@/components/ExportDialog.vue'
import TaskCenterDrawer from '@/components/TaskCenterDrawer.vue'

const session = useSessionStore()
const convert = useConvertStore()

onMounted(() => convert.startPolling())
onUnmounted(() => convert.stopPolling())
</script>

<template>
  <LoginGate v-if="!session.joined" />
  <div v-else class="app-shell">
    <TopBar />
    <el-alert
      v-if="session.status === 'offline'"
      type="warning"
      :closable="false"
      show-icon
      title="当前处于离线状态：本地编辑与批注已暂存，重新连接后自动同步"
    />
    <el-alert
      v-else-if="session.status === 'reconnecting' || session.status === 'connecting'"
      type="info"
      :closable="false"
      show-icon
      :title="`连接已断开，正在重连（第 ${session.reconnectAttempt} 次）…`"
    />
    <div class="app-main">
      <div class="editor-pane">
        <EditorView />
      </div>
      <AnnotationPanel />
    </div>

    <ImportDialog />
    <ExportDialog />
    <TaskCenterDrawer />
  </div>
</template>
