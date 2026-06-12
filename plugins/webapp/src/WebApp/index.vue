<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import AppDialog from './AppDialog.vue'
import SettingsDialog from './SettingsDialog.vue'

interface AppConfig {
  id: string
  name: string
  url: string
  icon: string
  description: string
  defaultLoad: boolean
  createdAt: number
  basicAuth?: {
    username: string
    password: string
  }
}

const apps = ref<AppConfig[]>([])
const currentApp = ref<AppConfig | null>(null)
const iframeSrc = ref('')
const iframeLoading = ref(false)
const showAppDialog = ref(false)
const showSettingsDialog = ref(false)
const editApp = ref<AppConfig | null>(null)

// 解码 Basic Auth 密码（仅用于显示/传递，不修改原始存储数据）
const decodePassword = (encoded: string): string => {
  try {
    return atob(encoded)
  } catch {
    return encoded
  }
}

// 加载保存的应用列表
const loadApps = () => {
  try {
    if (window.services?.readConfig) {
      apps.value = window.services.readConfig() || []
    } else {
      const ztools = window.ztools as any
      const data = ztools?.getData?.('webapp-configs')
      if (data) {
        // ztools.getData 可能返回已解析的对象或 JSON 字符串
        apps.value = typeof data === 'string' ? JSON.parse(data) : data
      }
    }
  } catch (e) {
    console.error('加载应用列表失败:', e)
  }
}

// 保存应用列表
const saveApps = () => {
  try {
    if (window.services?.saveConfig) {
      window.services.saveConfig(apps.value)
    } else {
      const ztools = window.ztools as any
      ztools?.setData?.('webapp-configs', JSON.stringify(apps.value))
    }
  } catch (e) {
    console.error('保存应用列表失败:', e)
  }
}

// 加载默认应用
const loadDefaultApp = () => {
  // 找到最后一个设置为默认加载的应用
  const defaultApps = apps.value.filter(app => app.defaultLoad)
  if (defaultApps.length > 0) {
    selectApp(defaultApps[defaultApps.length - 1])
  }
}

// 添加新应用
const addApp = () => {
  editApp.value = null
  showAppDialog.value = true
}

// 编辑应用
const editExistingApp = (app: AppConfig) => {
  editApp.value = { ...app }
  showAppDialog.value = true
}

// 保存应用配置
const saveApp = (config: AppConfig) => {
  if (editApp.value) {
    // 编辑现有应用
    const index = apps.value.findIndex(a => a.id === config.id)
    if (index !== -1) {
      // 如果勾选了默认加载，取消其他应用的默认加载
      if (config.defaultLoad) {
        apps.value.forEach(app => {
          if (app.id !== config.id) {
            app.defaultLoad = false
          }
        })
      }
      apps.value[index] = config
    }
  } else {
    // 添加新应用
    // 如果勾选了默认加载，取消其他应用的默认加载
    if (config.defaultLoad) {
      apps.value.forEach(app => {
        app.defaultLoad = false
      })
    }
    apps.value.push(config)
  }
  saveApps()
  showAppDialog.value = false
  editApp.value = null
}

// 删除应用
const deleteApp = (id: string) => {
  apps.value = apps.value.filter(a => a.id !== id)
  saveApps()
  if (currentApp.value?.id === id) {
    currentApp.value = null
  }
  showAppDialog.value = false
  editApp.value = null
}

// 选择应用
const selectApp = async (app: AppConfig) => {
  currentApp.value = app
  iframeLoading.value = true
  iframeSrc.value = '' // 先清空，避免显示旧内容
  if (app.basicAuth?.username && window.services?.setupAppProxy) {
    try {
      // 密码在存储中是 base64 编码的，使用时解码
      const password = decodePassword(app.basicAuth.password)
      await window.services.setupAppProxy(app.id, app.url, app.basicAuth.username, password)
      const rawUrl = window.services.getProxyUrl(app.id)
      const url = extractUrl(rawUrl, app.url)
      if (isValidUrl(url)) {
        iframeSrc.value = url
      } else {
        iframeSrc.value = app.url
      }
    } catch (e) {
      console.error('[WebApp] 代理启动失败:', e)
      iframeSrc.value = app.url // 降级直接加载
    }
  } else {
    iframeSrc.value = app.url
  }
}

// 从可能的对象中安全提取 URL 字符串
const extractUrl = (value: any, fallback: string): string => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    // 尝试常见的 URL 属性名
    return value.url || value.href || value.proxyUrl || value.proxy_url || String(value)
  }
  return fallback
}

// 验证 URL 格式
const isValidUrl = (url: string): boolean => {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

// iframe 加载完成回调
const onIframeLoad = () => {
  iframeLoading.value = false
}

// 关闭应用对话框
const closeAppDialog = () => {
  showAppDialog.value = false
  editApp.value = null
}

onMounted(() => {
  loadApps()
  // 页面加载时自动加载默认应用
  loadDefaultApp()
})
</script>

<template>
  <div class="app">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <!-- 添加按钮 -->
      <button class="sidebar-add" @click="addApp" title="添加应用">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>

      <!-- 分隔线 -->
      <div class="sidebar-divider"></div>

      <!-- 应用列表 -->
      <nav class="sidebar-nav">
        <button
          v-for="app in apps"
          :key="app.id"
          class="sidebar-item"
          :class="{ active: currentApp?.id === app.id }"
          @click="selectApp(app)"
          @contextmenu.prevent="editExistingApp(app)"
          :title="app.name"
        >
          <img
            v-if="app.icon"
            :src="app.icon"
            class="sidebar-item-icon"
            :alt="app.name"
          />
          <span v-else class="sidebar-item-initial">
            {{ app.name.charAt(0).toUpperCase() }}
          </span>
        </button>
      </nav>

      <!-- 底部按钮 -->
      <div class="sidebar-actions">
        <button class="sidebar-action" @click="showSettingsDialog = true" title="设置">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>
    </aside>

    <!-- 主内容区 -->
    <main class="main">
      <!-- iframe视图 -->
      <template v-if="currentApp && iframeSrc">
        <iframe
          :src="iframeSrc"
          class="iframe"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
          @load="onIframeLoad"
        ></iframe>
        <!-- Loading 遮罩 -->
        <div v-if="iframeLoading" class="iframe-loading">
          <div class="iframe-spinner"></div>
          <span class="iframe-loading-text">加载中...</span>
        </div>
      </template>

      <!-- 空状态 -->
      <div v-else class="empty">
        <div class="empty-icon">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>
        <h2 class="empty-title">WebApp</h2>
        <p class="empty-desc">添加您的第一个 Web 应用</p>
        <button class="empty-btn" @click="addApp">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          添加应用
        </button>
      </div>
    </main>

    <!-- 应用对话框 -->
    <AppDialog
      v-if="showAppDialog"
      :app="editApp"
      @save="saveApp"
      @delete="deleteApp"
      @close="closeAppDialog"
    />

    <!-- 设置对话框 -->
    <SettingsDialog
      v-if="showSettingsDialog"
      :apps="apps"
      @close="showSettingsDialog = false"
      @update="saveApps"
    />
  </div>
</template>

<style>
/* ================================================
   DESIGN SYSTEM - Global Tokens
   ================================================ */
:root {
  /* Colors - Dark */
  --color-bg: oklch(0.13 0 0);
  --color-surface: oklch(0.16 0 0);
  --color-surface-hover: oklch(0.20 0 0);
  --color-border: oklch(0.25 0 0);
  --color-text: oklch(0.95 0 0);
  --color-text-secondary: oklch(0.65 0 0);
  --color-text-muted: oklch(0.50 0 0);

  /* Accent - Logo Gradient: Cyan → Blue */
  --color-accent: oklch(0.62 0.18 255);
  --color-accent-hover: oklch(0.68 0.18 255);
  --color-accent-subtle: oklch(0.62 0.18 255 / 0.12);
  --color-gradient-start: oklch(0.78 0.12 235);   /* Cyan #4DC8FF */
  --color-gradient-end: oklch(0.58 0.20 255);      /* Blue #1A6BF5 */
  --gradient-brand: linear-gradient(135deg, var(--color-gradient-start) 0%, var(--color-gradient-end) 100%);

  /* Danger */
  --color-danger: oklch(0.65 0.2 25);
  --color-danger-hover: oklch(0.70 0.2 25);
  --color-danger-subtle: oklch(0.65 0.2 25 / 0.12);

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 20px;
  --space-2xl: 24px;
  --space-3xl: 32px;

  /* Radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-full: 9999px;

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --text-xs: 11px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-lg: 16px;
  --text-xl: 18px;
  --text-2xl: 24px;
  --font-medium: 500;
  --font-semibold: 600;

  /* Shadows */
  --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.1);
  --shadow-md: 0 4px 12px oklch(0 0 0 / 0.15);
  --shadow-lg: 0 8px 24px oklch(0 0 0 / 0.2);
  --shadow-xl: 0 16px 48px oklch(0 0 0 / 0.25);

  /* Transitions */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
  --duration-fast: 120ms;
  --duration-hover: 200ms;
  --duration-click: 100ms;
  --duration-normal: 200ms;
}

/* Light Theme */
@media (prefers-color-scheme: light) {
  :root {
    --color-bg: oklch(0.98 0 0);
    --color-surface: oklch(1 0 0);
    --color-surface-hover: oklch(0.96 0 0);
    --color-border: oklch(0.92 0 0);
    --color-text: oklch(0.13 0 0);
    --color-text-secondary: oklch(0.40 0 0);
    --color-text-muted: oklch(0.55 0 0);

    --color-accent: oklch(0.52 0.18 255);
    --color-accent-hover: oklch(0.48 0.18 255);
    --color-accent-subtle: oklch(0.52 0.18 255 / 0.1);
    --color-gradient-start: oklch(0.72 0.12 235);
    --color-gradient-end: oklch(0.50 0.20 255);
    --gradient-brand: linear-gradient(135deg, var(--color-gradient-start) 0%, var(--color-gradient-end) 100%);

    --color-danger: oklch(0.55 0.2 25);
    --color-danger-hover: oklch(0.50 0.2 25);
    --color-danger-subtle: oklch(0.55 0.2 25 / 0.1);

    --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.05);
    --shadow-md: 0 4px 12px oklch(0 0 0 / 0.08);
    --shadow-lg: 0 8px 24px oklch(0 0 0 / 0.1);
    --shadow-xl: 0 16px 48px oklch(0 0 0 / 0.12);
  }
}

/* Reset */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>

<style scoped>
/* ================================================
   LAYOUT
   ================================================ */
.app {
  display: flex;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg);
  color: var(--color-text);
  overflow: hidden;
}

/* ================================================
   SIDEBAR
   ================================================ */
.sidebar {
  width: 56px;
  min-width: 56px;
  background: var(--color-surface);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-md) 0;
  gap: var(--space-sm);
}

.sidebar-add {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-brand);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-hover) var(--ease-out);
  box-shadow: 0 2px 6px var(--color-accent-subtle);
  position: relative;
}

.sidebar-add::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 100%);
  opacity: 0;
  transition: opacity var(--duration-hover) var(--ease-out);
}

.sidebar-add:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 12px var(--color-accent-subtle);
}

.sidebar-add:hover::before {
  opacity: 1;
}

.sidebar-add:active {
  transform: scale(0.95);
  transition-duration: var(--duration-click);
}

.sidebar-divider {
  width: 24px;
  height: 1px;
  background: var(--color-border);
}

.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  overflow-y: auto;
  overflow-x: hidden;
  width: 100%;
  padding: 0 var(--space-sm);
  scrollbar-width: none;
}

.sidebar-nav::-webkit-scrollbar {
  display: none;
}

.sidebar-item {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-hover) var(--ease-out);
  flex-shrink: 0;
  position: relative;
}

.sidebar-item::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: calc(var(--radius-md) + 1px);
  background: var(--gradient-brand);
  opacity: 0;
  z-index: -1;
  transition: opacity var(--duration-hover) var(--ease-out);
}

.sidebar-item:hover {
  transform: scale(1.05);
}

.sidebar-item:hover::after {
  opacity: 0.12;
}

.sidebar-item.active {
  transform: scale(1.0);
}

.sidebar-item.active::after {
  opacity: 1;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 var(--color-accent-subtle);
  }
  50% {
    box-shadow: 0 0 0 4px transparent;
  }
}

.sidebar-item-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  object-fit: cover;
  position: relative;
  z-index: 1;
}

.sidebar-item-initial {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--gradient-brand);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: white;
  position: relative;
  z-index: 1;
}

.sidebar-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
}

.sidebar-action {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-hover) var(--ease-out);
}

.sidebar-action:hover {
  background: var(--color-surface-hover);
  color: var(--color-text);
  transform: scale(1.04);
}

.sidebar-action:active {
  transform: scale(0.95);
  transition-duration: var(--duration-click);
}

/* ================================================
   MAIN CONTENT
   ================================================ */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-bg);
  position: relative;
}

/* ================================================
   IFRAME
   ================================================ */
.iframe {
  flex: 1;
  width: 100%;
  border: none;
  background: var(--color-bg);
}

.iframe-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  background: var(--color-bg);
  z-index: 10;
}

.iframe-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.iframe-loading-text {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

/* ================================================
   EMPTY STATE
   ================================================ */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-lg);
  animation: fadeIn 400ms var(--ease-out);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.empty-icon {
  width: 80px;
  height: 80px;
  background: var(--color-surface);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.empty-title {
  font-size: var(--text-2xl);
  font-weight: var(--font-semibold);
  color: var(--color-text);
}

.empty-desc {
  font-size: var(--text-base);
  color: var(--color-text-muted);
}

.empty-btn {
  padding: var(--space-sm) var(--space-lg);
  background: var(--gradient-brand);
  border: none;
  border-radius: var(--radius-sm);
  color: white;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: var(--font-medium);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  transition: all var(--duration-fast) var(--ease-out);
}

.empty-btn:hover {
  background: var(--gradient-brand);
  filter: brightness(1.1);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px var(--color-accent-subtle);
}

.empty-btn:active {
  transform: translateY(0);
}
</style>
