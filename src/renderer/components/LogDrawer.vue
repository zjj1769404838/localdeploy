<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { NDrawer, NDrawerContent, NButton, NSpace } from 'naive-ui'
import { api } from '@renderer/stores/app'
import type { ProjState, LogLine } from '@shared/types'

const props = defineProps<{ target: ProjState }>()
const emit = defineEmits<{ close: [] }>()

const lines = ref<LogLine[]>([])
const lastSeq = ref(0)
const show = ref(true)
const box = ref<HTMLElement | null>(null)
let timer: NodeJS.Timeout | null = null

async function pull(): Promise<void> {
  try {
    const r = await api.logs(props.target.project.id, lastSeq.value)
    if (r.lines.length) {
      lines.value.push(...r.lines)
      lastSeq.value = r.lines[r.lines.length - 1]!.seq
      if (lines.value.length > 3000) lines.value.splice(0, lines.value.length - 3000)
      await nextTick()
      if (box.value) box.value.scrollTop = box.value.scrollHeight
    }
  } catch { /* 引擎侧无该项目日志则空 */ }
}

onMounted(() => {
  void pull()
  timer = setInterval(() => void pull(), 1000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.target.project.id, () => { lines.value = []; lastSeq.value = 0 })

async function clearAll(): Promise<void> {
  await api.clearLogs(props.target.project.id)
  lines.value = []
}

function fmt(l: LogLine): string {
  return l.t.slice(11, 19) + ' ' + l.line
}
</script>

<template>
  <n-drawer :show="show" :width="720" placement="right" @update:show="(v: boolean) => { if (!v) emit('close') }">
    <n-drawer-content :title="`日志 — ${props.target.project.name}`" closable>
      <n-space class="acts">
        <n-button size="tiny" tertiary @click="clearAll">清空</n-button>
        <n-button size="tiny" tertiary @click="pull">刷新</n-button>
      </n-space>
      <div ref="box" class="logbox mono">
        <div v-for="l in lines" :key="l.seq" class="log-line" :class="'log-' + l.stream">{{ fmt(l) }}</div>
        <div v-if="!lines.length" class="dim">（暂无输出）</div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.acts { margin-bottom: 8px; }
.logbox { background: #101014; border: 1px solid #2a2a30; border-radius: 8px; padding: 10px; height: calc(100vh - 190px); overflow-y: auto; font-size: 12px; }
.dim { color: #6b6b70; }
</style>
