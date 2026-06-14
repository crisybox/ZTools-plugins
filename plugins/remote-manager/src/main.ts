import { createApp } from 'vue'
import './main.css'
import App from './App.vue'

if (import.meta.env.DEV) {
  const hostsFile: any[] = []
  window.ztools = {
    onPluginEnter: (cb: any) => cb({ code: 'remote-manager' }),
    onPluginOut: () => {},
    hideMainWindow: () => {},
    showTip: () => {},
    getClipboardContent: () => '',
    getPath: (type: string) => type === 'userData' ? '.' : '.'
  } as any
  window.services = {
    getHosts: () => hostsFile,
    addHost: (host: any) => { hostsFile.push({ ...host, password: btoa(host.password) }); return { success: true } },
    updateHost: (id: string, host: any) => {
      const idx = hostsFile.findIndex((h: any) => h.id === id)
      if (idx !== -1) { hostsFile[idx] = { ...host, password: host.password === hostsFile[idx].password ? host.password : btoa(host.password) } }
      return { success: true }
    },
    deleteHost: (id: string) => {
      const idx = hostsFile.findIndex((h: any) => h.id === id)
      if (idx !== -1) hostsFile.splice(idx, 1)
      return { success: true }
    },
    connectRdp: () => ({ success: true }),
    readFile: () => '',
    writeTextFile: () => '',
    writeImageFile: () => ''
  } as any
}

createApp(App).mount('#app')
