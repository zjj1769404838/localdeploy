<script setup lang="ts">
import { reactive, watch, ref } from 'vue'
import { NForm, NFormItem, NInputNumber, NSwitch, NInput, NButton, NAlert, NDivider } from 'naive-ui'
import { store, api } from '@renderer/stores/app'
import type { Settings } from '@shared/types'

const emit = defineEmits<{ back: [] }>()
const s = reactive<Settings>(structuredClone(store.state?.settings ?? ({} as Settings)))
const saved = ref('')
const err = ref('')
const httpsBusy = ref(false)

watch(() => store.state?.settings, (n) => { if (n) Object.assign(s, structuredClone(n)) })

async function save(): Promise<void> {
  err.value = ''; saved.value = ''
  try {
    await api.updateSettings(structuredClone(s))
    await api.refresh()
    saved.value = '已保存并热应用'
    setTimeout(() => (saved.value = ''), 2000)
  } catch (e) { err.value = String((e as Error).message) }
}

async function toggleHttps(v: boolean): Promise<void> {
  if (!v) return
  httpsBusy.value = true
  err.value = ''
  try {
    await api.updateSettings({ gateway: { ...s.gateway, httpsEnabled: true } })
    await api.refresh()
    err.value = 'HTTPS 已开启；首次签发证书可能弹出 UAC/安装根证书提示'
  } catch (e) { err.value = String((e as Error).message) }
  finally { httpsBusy.value = false }
}

async function setAutostart(v: boolean): Promise<void> {
  try { await api.autostartSet(v); await api.refresh() }
  catch (e) { err.value = '开机自启设置失败：' + String((e as Error).message) }
}
</script>

<template>
  <div class="wrap">
    <h3>设置 <span class="sub">全部改动写入 config.yaml 并即时热应用，也可直接编辑该文件</span></h3>
    <n-alert v-if="err" type="error" class="mb">{{ err }}</n-alert>
    <n-alert v-if="saved" type="success" class="mb">{{ saved }}</n-alert>
    <n-form label-placement="left" label-width="190" class="form">
      <n-divider title-placement="left">网关</n-divider>
      <n-form-item label="HTTP 端口（默认 80）">
        <n-input-number v-model:value="s.gateway.httpPort" :min="1" :max="65535" style="width:140px" />
      </n-form-item>
      <n-form-item label="HTTPS 端口（默认 443）">
        <n-input-number v-model:value="s.gateway.httpsPort" :min="1" :max="65535" style="width:140px" />
      </n-form-item>
      <n-form-item label="启用本地 HTTPS">
        <n-switch :value="s.gateway.httpsEnabled" :loading="httpsBusy" @update:value="toggleHttps" />
      </n-form-item>
      <n-form-item label="HTTP 自动跳转 HTTPS">
        <n-switch v-model:value="s.gateway.httpsRedirect" />
      </n-form-item>

      <n-divider title-placement="left">域名</n-divider>
      <n-form-item label="域名后缀">
        <n-input v-model:value="s.domain.suffix" placeholder=".zjj" style="width:180px" />
      </n-form-item>
      <n-form-item label="托管 hosts 写入">
        <n-switch v-model:value="s.domain.hostsManaged" />
      </n-form-item>

      <n-divider title-placement="left">进程守护</n-divider>
      <n-form-item label="崩溃自动重启（全局默认）">
        <n-switch v-model:value="s.proc.restartOnCrash" />
      </n-form-item>
      <n-form-item label="重启退避基数 ms">
        <n-input-number v-model:value="s.proc.backoffBaseMs" :min="100" :max="60000" style="width:140px" />
      </n-form-item>
      <n-form-item label="退避封顶 ms">
        <n-input-number v-model:value="s.proc.backoffCapMs" :min="1000" :max="600000" style="width:140px" />
      </n-form-item>
      <n-form-item label="连败上限（超过标记崩溃）">
        <n-input-number v-model:value="s.proc.maxRestarts" :min="0" :max="100" style="width:140px" />
      </n-form-item>

      <n-divider title-placement="left">日志</n-divider>
      <n-form-item label="界面保留行数（环形缓冲）">
        <n-input-number v-model:value="s.logs.ringLines" :min="100" :max="100000" style="width:140px" />
      </n-form-item>
      <n-form-item label="单文件大小 MB / 保留份数">
        <n-space>
          <n-input-number v-model:value="s.logs.fileSizeMb" :min="1" :max="100" style="width:110px" />
          <n-input-number v-model:value="s.logs.fileKeep" :min="1" :max="10" style="width:110px" />
        </n-space>
      </n-form-item>

      <n-divider title-placement="left">启动</n-divider>
      <n-form-item label="开机自启（当前用户）">
        <n-switch :value="s.autostart.appOnBoot" @update:value="setAutostart" />
      </n-form-item>
      <n-form-item label="启动时恢复上次项目">
        <n-switch v-model:value="s.autostart.resumeProjects" />
      </n-form-item>
    </n-form>
    <n-space>
      <n-button @click="emit('back')">返回</n-button>
      <n-button type="primary" @click="save">保存</n-button>
      <n-button tertiary @click="api.certsRenew()">重签证书</n-button>
    </n-space>
  </div>
</template>

<style scoped>
.wrap { max-width: 680px; }
h3 { margin: 4px 0 14px; }
.sub { font-size: 12px; color: #8a8a92; font-weight: 400; margin-left: 8px; }
.mb { margin-bottom: 10px; }
.form :deep(.n-divider) { margin: 14px 0 6px; }
</style>
