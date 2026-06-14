const fs = require('node:fs')
const path = require('node:path')
const { execSync, exec } = require('node:child_process')
const os = require('node:os')

function getHostsFilePath() {
  const userDataPath = window.ztools.getPath('userData')
  return path.join(userDataPath, 'hosts.json')
}

function loadHosts() {
  const filePath = getHostsFilePath()
  if (!fs.existsSync(filePath)) {
    return []
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

function saveHostsToFile(hosts) {
  const filePath = getHostsFilePath()
  fs.writeFileSync(filePath, JSON.stringify(hosts, null, 2), 'utf-8')
}

function encodePassword(pwd) {
  return Buffer.from(pwd, 'utf-8').toString('base64')
}

function decodePassword(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

window.services = {
  getHosts() {
    return loadHosts()
  },

  addHost(host) {
    const hosts = loadHosts()
    if (hosts.some(h => h.id === host.id)) {
      return { success: false, error: '编号已存在' }
    }
    const newHost = {
      ...host,
      password: encodePassword(host.password)
    }
    hosts.push(newHost)
    saveHostsToFile(hosts)
    return { success: true }
  },

  updateHost(originalId, host) {
    const hosts = loadHosts()
    const index = hosts.findIndex(h => h.id === originalId)
    if (index === -1) {
      return { success: false, error: '主机不存在' }
    }
    if (host.id !== originalId && hosts.some(h => h.id === host.id)) {
      return { success: false, error: '编号已存在' }
    }
    hosts[index] = {
      ...host,
      password: host.password === hosts[index].password
        ? host.password
        : encodePassword(host.password)
    }
    saveHostsToFile(hosts)
    return { success: true }
  },

  deleteHost(id) {
    const hosts = loadHosts()
    const filtered = hosts.filter(h => h.id !== id)
    if (filtered.length === hosts.length) {
      return { success: false, error: '主机不存在' }
    }
    saveHostsToFile(filtered)
    return { success: true }
  },

  connectRdp(address, username, password) {
    try {
      const decodedPassword = password.startsWith('base64:')
        ? decodePassword(password.replace('base64:', ''))
        : password

      const tempDir = os.tmpdir()
      const rdpFile = path.join(tempDir, `rdp_${Date.now()}.rdp`)

      const rdpContent = [
        `full address:s:${address}`,
        `username:s:${username}`,
        `screen mode id:i:2`,
        `session bpp:i:32`,
        `compression:i:1`,
        `keyboardhook:i:2`,
        `connection type:i:7`,
        `displayconnectionbar:i:1`,
        `allow font smoothing:i:1`,
        `allow desktop composition:i:1`,
        `bitmapcachepersistenable:i:1`,
        `authentication level:i:2`,
        `prompt for credentials:i:0`,
        `negotiate security layer:i:1`,
        `autoreconnection enabled:i:1`
      ].join('\r\n')

      fs.writeFileSync(rdpFile, rdpContent, 'utf-8')
      console.log('[RDP] RDP 文件已写入:', rdpFile)

      try {
        const cmdkeyResult = execSync(
          `cmdkey /generic:TERMSRV/${address} /user:"${username}" /pass:"${decodedPassword}"`,
          { encoding: 'utf-8' }
        )
        console.log('[RDP] cmdkey 输出:', cmdkeyResult)
      } catch (cmdErr) {
        console.error('[RDP] cmdkey 失败:', cmdErr.message)
      }

      const mstscPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'mstsc.exe')
      console.log('[RDP] 启动 mstsc:', mstscPath, rdpFile)

      exec(`"${mstscPath}" "${rdpFile}"`, (err, stdout, stderr) => {
        if (err) {
          console.error('[RDP] mstsc 启动失败:', err.message)
        } else {
          console.log('[RDP] mstsc 已启动')
        }
      })

      setTimeout(() => {
        try {
          execSync(`cmdkey /delete:TERMSRV/${address}`, { encoding: 'utf-8' })
        } catch {}
        try {
          if (fs.existsSync(rdpFile)) {
            fs.unlinkSync(rdpFile)
          }
        } catch {}
      }, 5000)

      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }
}
