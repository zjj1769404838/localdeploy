<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NForm, NFormItem, NInput, NInputNumber, NSwitch, NButton, NSpace, NAlert, NRadio, NRadioGroup } from 'naive-ui'
import { api } from '@renderer/stores/app'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ added: [] }>()

const name = ref('')
const dir = ref('')
const type = ref<'static' | 'process'>('static')
const detected = ref<string | null>(null)
// 静态
const staticDir = ref('')
const spa = ref(true)
// 进程
const command = ref('')
const argsText = ref('')
const port = ref<number | undefined>(undefined)
const domain = ref('')
const autoStart = ref(false)
const busy = ref(false)
const err = ref('')

watch(dir, async (d) => {
  detected.value = null
  if (!d || d.length < 3) return
  try {
    const r = await api.detect(d)
    if (r) {
      detected.value = r.hint ?? '已识别'
      type.value = (r as { type?: string }).type as 'static' | 'process' ?? type.value
      if (r.type === 'static') { staticDir.value = (r as { dir?: string }).dir ?? d; spa.value = (r as { spa?: boolean }).spa ?? true }
      else {
        command.value = (r as { command?: string }).command ?? ''
        argsText.value = ((r as { args?: string[] }).args ?? []).join(' ')
        port.value = (r as { port?: number }).port
      }
    } else detected.value = '未识别到项目特征，请手动选择类型填写'
  } catch { detected.value = '识别失败，可手动填写' }
})

watch(name, (n) => {
  if (!domainTouched.value) domain.value = n.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '')
}, { immediate: true })
const domainTouched = ref(false)

async function submit(): Promise<void> {
  err.value = ''
  busy.value = true
  try {
    const spec: Parameters<typeof api.addProject>[0] = {
      name: name.value.trim(),
      type: type.value,
      domain: domain.value.trim() ? domain.value.trim() + (domain.value.includes('.') ? '' : '.zjj') : '',
      autoStart: autoStart.value
    }
    if (type.value === 'static') { spec.dir = staticDir.value.trim(); spec.spa = spa.value }
    else {
      spec.command = command.value.trim()
      spec.args = argsText.value.trim() ? argsText.value.trim().split(/\s+/) : []
      spec.cwd = dir.value.trim()
      spec.port = port.value
    }
    await api.addProject(spec)
    emit('added')
    open.value = false
    // reset
    name.value = ''; dir.value = ''; staticDir.value = ''; command.value = ''; argsText.value = ''; port.value = undefined; domain.value = ''; autoStart.value = false
  } catch (e) { err.value = String((e as Error).message) }
  finally { busy.value = false }
}
</script>

<template>
  <n-modal v-model:show="open" preset="card" title="添加项目" style="width:560px">
    <n-alert v-if="err" type="error" class="mb">{{ err }}</n-alert>
    <n-form label-placement="left" label-width="92">
      <n-form-item label="项目名" required>
        <n-input v-model:value="name" placeholder="如 博客前端" />
      </n-form-item>
      <n-form-item label="项目目录" required>
        <n-input v-model:value="dir" placeholder="选择/粘贴项目根目录，自动识别类型" />
      </n-form-item>
      <div v-if="detected" class="hint">🔎 {{ detected }}</div>
      <n-form-item label="类型">
        <n-radio-group v-model:value="type">
          <n-radio value="static">静态站点（构建产物）</n-radio>
          <n-radio value="process">后端进程（命令行启动）</n-radio>
        </n-radio-group>
      </n-form-item>
      <template v-if="type === 'static'">
        <n-form-item label="静态目录">
          <n-input v-model:value="staticDir" placeholder="构建产物目录，如 D:\sites\blog\dist" />
        </n-form-item>
        <n-form-item label="SPA 模式">
          <n-switch v-model:value="spa" />
        </n-form-item>
      </template>
      <template v-else>
        <n-form-item label="启动命令">
          <n-input v-model:value="command" placeholder="node / npm / java / python / 可执行文件路径" />
        </n-form-item>
        <n-form-item label="参数">
          <n-input v-model:value="argsText" placeholder="空格分隔，如 run start" />
        </n-form-item>
        <n-form-item label="端口">
          <n-input-number v-model:value="port" :min="1" :max="65535" placeholder="进程自身监听端口" style="width:160px" />
        </n-form-item>
      </template>
      <n-form-item label="本地域名">
        <n-input v-model:value="domain" placeholder="留空不启用；自动加 .zjj" @update:value="domainTouched = true">
          <template #suffix><span class="dim">.zjj 自动</span></template>
        </n-input>
      </n-form-item>
      <n-form-item label="随应用启动">
        <n-switch v-model:value="autoStart" />
      </n-form-item>
    </n-form>
    <n-space justify="end">
      <n-button @click="open = false">取消</n-button>
      <n-button type="primary" :loading="busy" @click="submit">添加</n-button>
    </n-space>
  </n-modal>
</template>

<style scoped>
.mb { margin-bottom: 10px; }
.hint { font-size: 12px; color: #8fd18f; margin: -6px 0 10px 92px; }
.dim { color: #6b6b70; font-size: 12px; }
</style>
