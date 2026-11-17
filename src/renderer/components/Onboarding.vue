<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NButton, NSpace, NSwitch, NSteps, NStep } from 'naive-ui'
import { api, store } from '@renderer/stores/app'

const emit = defineEmits<{ done: []; add: [] }>()
const step = ref(1)
const enableHttps = ref(false)
const busy = ref(false)

async function applyStep2(): Promise<void> {
  busy.value = true
  try {
    if (enableHttps.value) {
      const s = store.state?.settings
      if (s) await api.updateSettings({ gateway: { ...s.gateway, httpsEnabled: true } })
    }
  } catch { /* 降级：引导不打断 */ }
  finally { busy.value = false; step.value = 3 }
}
</script>

<template>
  <n-modal :show="true" preset="card" title="欢迎使用 LocalDeploy" style="width:520px" :mask-closable="false" :closable="false">
    <n-steps :current="step" size="small" class="steps">
      <n-step title="认识它" />
      <n-step title="域名与 HTTPS" />
      <n-step title="添加项目" />
    </n-steps>

    <div v-if="step === 1" class="body">
      <p>LocalDeploy 把本机的<b>前端构建产物</b>和<b>后端进程</b>统一管起来：</p>
      <ul>
        <li>一键启停、崩溃自动拉起、日志随看</li>
        <li>每个项目自动获得 <code>名字.zjj</code> 本地域名</li>
        <li>所有行为在设置页可调，也可直接编辑 config.yaml</li>
      </ul>
    </div>
    <div v-else-if="step === 2" class="body">
      <p>域名访问需要写入系统 hosts 文件，第一次会弹出一次管理员授权（UAC）；拒绝也不影响使用——项目仍可用端口直接访问。</p>
      <p>本地 HTTPS（绿色小锁）基于内置 mkcert 自签证书，同样需要一次授权。</p>
      <n-switch v-model:value="enableHttps"> <template #checked>开启本地 HTTPS（推荐稍后在设置里开也行）</template><template #unchecked>暂不开启 HTTPS</template></n-switch>
    </div>
    <div v-else class="body">
      <p>点「添加项目」，选择项目目录——LocalDeploy 会自动识别是静态站点还是后端进程，并预填配置，确认后即用。</p>
    </div>

    <n-space justify="end">
      <n-button text @click="step === 3 ? emit('done') : emit('add')">跳过</n-button>
      <n-button v-if="step === 1" type="primary" @click="step = 2">下一步</n-button>
      <n-button v-else-if="step === 2" type="primary" :loading="busy" @click="applyStep2">下一步</n-button>
      <n-button v-else type="primary" @click="emit('add')">添加第一个项目</n-button>
    </n-space>
  </n-modal>
</template>

<style scoped>
.steps { margin-bottom: 16px; }
.body { min-height: 130px; font-size: 13.5px; color: #c9c9cf; }
.body ul { padding-left: 18px; }
code { background: #2a2a32; padding: 1px 5px; border-radius: 4px; }
</style>
