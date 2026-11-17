<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import {
  NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, NLayout, NLayoutHeader,
  NLayoutContent, NButton, NSpace, NTag, NEmpty, NAlert, NBadge
} from 'naive-ui'
import { store, api, subscribe } from '@renderer/stores/app'
import type { ProjState } from '@shared/types'
import AddWizard from '@renderer/components/AddWizard.vue'
import LogDrawer from '@renderer/components/LogDrawer.vue'
import SettingsView from '@renderer/components/SettingsView.vue'
import Onboarding from '@renderer/components/Onboarding.vue'

const view = ref<'dash' | 'settings'>('dash')
const wizardOpen = ref(false)
const logTarget = ref<ProjState | null>(null)
const onboarding = ref(false)

const state = computed(() => store.state)
const runningCount = computed(() => state.value?.projects.filter(p => p.status === 'running').length ?? 0)

const statusText: Record<string, string> = {
  idle: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', crashed: '崩溃'
}

onMounted(async () => {
  subscribe()
  await api.refresh()
  if (!localStorage.getItem('ld.onboarded')) onboarding.value = true
})

function openedOnboarding(): void {
  localStorage.setItem('ld.onboarded', '1')
  onboarding.value = false
}

async function toggleRun(p: ProjState): Promise<void> {
  try {
    if (p.status === 'running' || p.status === 'starting') await api.stop(p.project.id)
    else await api.start(p.project.id)
  } catch (e) { window.alert(String((e as Error).message)) }
  await api.refresh()
}

async function restart(p: ProjState): Promise<void> {
  try { await api.restart(p.project.id) } catch (e) { window.alert(String((e as Error).message)) }
  await api.refresh()
}

async function remove(p: ProjState): Promise<void> {
  if (!window.confirm(`删除项目「${p.project.name}」？将停止进程并清理域名。`)) return
  try { await api.removeProject(p.project.id) } catch (e) { window.alert(String((e as Error).message)) }
  await api.refresh()
}

async function openUrl(url: string): Promise<void> { await api.openExternal(url) }

async function startAll(): Promise<void> {
  for (const p of state.value?.projects ?? []) {
    if (p.status !== 'running' && p.status !== 'starting') { try { await api.start(p.project.id) } catch { /* next */ } }
  }
  await api.refresh()
}
async function stopAll(): Promise<void> {
  for (const p of state.value?.projects ?? []) {
    try { await api.stop(p.project.id) } catch { /* next */ }
  }
  await api.refresh()
}
</script>

<template>
  <n-config-provider :theme="darkTheme">
    <n-message-provider>
      <n-dialog-provider>
        <n-layout class="h-full">
          <n-layout-header class="topbar">
            <div class="brand">LocalDeploy <n-tag size="small" :bordered="false">{{ runningCount }} 运行中</n-tag></div>
            <n-space>
              <n-button size="small" tertiary @click="view = 'dash'">仪表盘</n-button>
              <n-button size="small" tertiary @click="view = 'settings'">设置</n-button>
              <n-button size="small" @click="wizardOpen = true">+ 添加项目</n-button>
            </n-space>
          </n-layout-header>
          <n-layout-content class="content">
            <template v-if="view === 'dash'">
              <n-alert v-if="store.error" type="error" class="mb">{{ store.error }}</n-alert>
              <template v-for="w in state?.warnings ?? []" :key="w.code">
                <n-alert type="warning" class="mb" :title="w.code === 'W_HOSTS_DENIED' ? '域名未生效（权限）' : w.code === 'W_GATEWAY_BIND' ? '网关端口冲突' : '注意'">
                  {{ w.message }}
                  <n-button v-if="w.code === 'W_HOSTS_DENIED'" size="tiny" style="margin-left:8px" @click="api.hostsRetry().then(api.refresh)">重试写入</n-button>
                </n-alert>
              </template>
              <div v-if="state && state.projects.length" class="toolbar">
                <n-button size="tiny" tertiary @click="startAll">全部启动</n-button>
                <n-button size="tiny" tertiary @click="stopAll">全部停止</n-button>
              </div>
              <div class="grid">
                <div v-for="p in state?.projects ?? []" :key="p.project.id" class="card" :class="'card-' + p.status">
                  <div class="card-head">
                    <span><i class="status-dot" :class="'status-' + p.status" />{{ p.project.name }}</span>
                    <n-tag size="tiny" :bordered="false">{{ statusText[p.status] }}</n-tag>
                  </div>
                  <div class="card-meta mono">
                    {{ p.project.type === 'static' ? '静态 · ' + p.project.dir : '进程 · ' + p.project.command + ' ' + (p.project.args ?? []).join(' ') }}
                  </div>
                  <div class="card-urls">
                    <a v-for="u in p.urls" :key="u" class="url mono" href="#" @click.prevent="openUrl(u)">{{ u }}</a>
                    <span v-if="!p.urls.length" class="dim">无访问入口（端口未运行）</span>
                  </div>
                  <div v-for="w in p.warnings" :key="w.code" class="warn mono">⚠ {{ w.message }}</div>
                  <n-space class="card-acts">
                    <n-button size="tiny" type="primary" @click="toggleRun(p)">{{ p.status === 'running' || p.status === 'starting' ? '停止' : '启动' }}</n-button>
                    <n-button v-if="p.project.type === 'process'" size="tiny" tertiary @click="restart(p)">重启</n-button>
                    <n-button size="tiny" tertiary @click="logTarget = p">日志</n-button>
                    <n-button size="tiny" tertiary type="error" @click="remove(p)">删除</n-button>
                  </n-space>
                </div>
              </div>
              <n-empty v-if="!state?.projects.length && !store.error" description="还没有项目" class="empty">
                <n-button size="small" type="primary" @click="wizardOpen = true">添加第一个项目</n-button>
              </n-empty>
            </template>
            <SettingsView v-else @back="view = 'dash'" />
          </n-layout-content>
          <AddWizard v-model:open="wizardOpen" @added="api.refresh()" />
          <LogDrawer v-if="logTarget" :target="logTarget" @close="logTarget = null" />
          <Onboarding v-if="onboarding" @done="openedOnboarding" @add="openedOnboarding(); wizardOpen = true" />
        </n-layout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.h-full { height: 100%; }
.mb { margin: 8px 12px 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid #2a2a30; }
.brand { font-weight: 600; font-size: 15px; display: flex; gap: 8px; align-items: center; }
.content { padding: 12px 16px; height: calc(100% - 53px); overflow-y: auto; }
.toolbar { display: flex; gap: 8px; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.card { background: #212127; border: 1px solid #2e2e36; border-radius: 10px; padding: 12px 14px; }
.card-crashed { border-color: #e8808060; }
.card-head { display: flex; justify-content: space-between; align-items: center; font-size: 15px; font-weight: 600; }
.card-meta { color: #8a8a92; font-size: 12px; margin-top: 6px; word-break: break-all; }
.card-urls { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.url { color: #70b0ff; font-size: 12.5px; text-decoration: none; }
.url:hover { text-decoration: underline; }
.dim { color: #6b6b70; font-size: 12px; }
.warn { color: #f0a020; font-size: 12px; margin-top: 6px; }
.card-acts { margin-top: 10px; }
.empty { margin-top: 80px; }
</style>
