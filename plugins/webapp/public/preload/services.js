const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const zlib = require('node:zlib')
const { URL } = require('node:url')

// ============================================
// Cookie 持久化存储
// ============================================
const cookiesMap = new Map() // appId -> { [domain]: [cookie1, cookie2, ...] }
let cookieDirty = false // 标记是否有未保存的修改
let cookieSaveTimer = null // 延迟保存定时器

function getCookiePath() {
  let userDataPath
  try {
    userDataPath = window.ztools?.getPath('userData')
  } catch (e) {
    // ignore
  }
  if (!userDataPath) {
    userDataPath = process.env.USERPROFILE || process.env.HOME || '/tmp'
  }
  return path.join(userDataPath, 'webapp-cookies.json')
}

function loadCookies() {
  try {
    const cookiePath = getCookiePath()
    if (fs.existsSync(cookiePath)) {
      const data = fs.readFileSync(cookiePath, { encoding: 'utf-8' })
      const obj = JSON.parse(data)
      for (const [key, value] of Object.entries(obj)) {
        cookiesMap.set(key, value)
      }
    }
  } catch (e) {
    console.error('[Cookie] 加载失败:', e)
  }
}

function saveCookies(immediate = false) {
  cookieDirty = true

  // 清除之前的定时器
  if (cookieSaveTimer) {
    clearTimeout(cookieSaveTimer)
    cookieSaveTimer = null
  }

  const doSave = () => {
    if (!cookieDirty) return
    try {
      const cookiePath = getCookiePath()
      const dir = path.dirname(cookiePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const obj = Object.fromEntries(cookiesMap)
      fs.writeFileSync(cookiePath, JSON.stringify(obj, null, 2), { encoding: 'utf-8' })
      cookieDirty = false
    } catch (e) {
      console.error('[Cookie] 保存失败:', e)
    }
  }

  if (immediate) {
    doSave()
  } else {
    // 延迟 500ms 保存，避免频繁写入
    cookieSaveTimer = setTimeout(doSave, 500)
  }
}

// 解析 Set-Cookie 头，提取 cookie 名称和值
function parseSetCookie(setCookieHeader) {
  const parts = setCookieHeader.split(';')
  const [nameValue] = parts
  const eqIndex = nameValue.indexOf('=')
  if (eqIndex === -1) return null
  const name = nameValue.substring(0, eqIndex).trim()
  const value = nameValue.substring(eqIndex + 1).trim()
  return { name, value, full: setCookieHeader }
}

// 从 cookie 数组构建 Cookie 头
function buildCookieHeader(cookies) {
  if (!cookies || cookies.length === 0) return null
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

// 更新 appId 的 cookies
function updateCookies(appId, domain, setCookieHeaders) {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return

  if (!cookiesMap.has(appId)) {
    cookiesMap.set(appId, {})
  }
  const appCookies = cookiesMap.get(appId)

  if (!appCookies[domain]) {
    appCookies[domain] = []
  }

  for (const header of setCookieHeaders) {
    const cookie = parseSetCookie(header)
    if (!cookie) continue

    // 检查是否已存在同名 cookie，存在则更新
    const existingIndex = appCookies[domain].findIndex(c => c.name === cookie.name)
    if (existingIndex !== -1) {
      appCookies[domain][existingIndex] = cookie
    } else {
      appCookies[domain].push(cookie)
    }
  }

  // 延迟保存
  saveCookies()
}

// 获取 appId 的 cookies
function getCookies(appId) {
  return cookiesMap.get(appId) || {}
}

// 解压响应体（支持 gzip / deflate / br）
async function decompressResponse(stream, encoding) {
  const collectStream = (s) => {
    return new Promise((resolve, reject) => {
      const chunks = []
      s.on('data', c => chunks.push(c))
      s.on('end', () => resolve(Buffer.concat(chunks)))
      s.on('error', reject)
    })
  }

  if (!encoding) {
    return collectStream(stream)
  }

  const enc = encoding.toLowerCase().trim()
  if (enc === 'gzip' || enc === 'x-gzip') {
    return collectStream(stream.pipe(zlib.createGunzip()))
  }
  if (enc === 'deflate') {
    return collectStream(stream.pipe(zlib.createInflate()))
  }
  if (enc === 'br') {
    return collectStream(stream.pipe(zlib.createBrotliDecompress()))
  }

  // 未知编码，原样返回
  return collectStream(stream)
}

// ============================================
// 独立端口反向代理（每个应用一个端口）
// ============================================
const BASE_PORT = 18080 // 代理端口起始值
const appProxies = new Map() // appId -> { server, port, targetUrl, username, password }

// 启动时加载 cookies
loadCookies()

/**
 * 查找可用端口（迭代方式，避免栈溢出）
 */
function findAvailablePort(startPort, maxRetries = 100) {
  return new Promise((resolve, reject) => {
    let currentPort = startPort
    let retries = 0

    const tryPort = () => {
      if (retries >= maxRetries) {
        reject(new Error(`无法找到可用端口（已尝试 ${maxRetries} 个端口）`))
        return
      }

      const server = http.createServer()
      server.listen(currentPort, '127.0.0.1', () => {
        const port = server.address().port
        server.close(() => resolve(port))
      })
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          retries++
          currentPort++
          tryPort()
        } else {
          reject(err)
        }
      })
    }

    tryPort()
  })
}

/**
 * 创建应用代理服务器
 */
async function createAppProxy(appId, targetUrl, username, password) {
  // 如果已存在，先关闭旧的
  if (appProxies.has(appId)) {
    removeAppProxy(appId)
  }

  const port = await findAvailablePort(BASE_PORT)
  const targetObj = new URL(targetUrl)
  const targetDomain = targetObj.hostname

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1')
        const fullUrl = targetObj.origin + reqUrl.pathname + reqUrl.search

        const client = targetObj.protocol === 'https:' ? https : http

        // 构造转发请求头
        const fwdHeaders = {}
        // 转发部分原始请求头（不转发 accept-encoding，确保服务器返回未压缩内容）
        const passHeaders = ['accept', 'accept-language', 'content-type']
        for (const h of passHeaders) {
          if (req.headers[h]) fwdHeaders[h] = req.headers[h]
        }
        // 注入 Basic Auth
        if (username) {
          fwdHeaders['authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
        }

        // 添加保存的 cookies
        const appCookies = getCookies(appId)
        const domainCookies = appCookies[targetDomain] || []
        const clientCookieHeader = buildCookieHeader(domainCookies)
        if (clientCookieHeader) {
          fwdHeaders['cookie'] = clientCookieHeader
        }

        const proxyRes = await new Promise((resolveRes, rejectRes) => {
          const proxyReq = client.request(fullUrl, {
            method: req.method,
            headers: fwdHeaders,
            timeout: 30000
          }, resolveRes)
          proxyReq.on('error', rejectRes)
          proxyReq.on('timeout', () => { proxyReq.destroy(); rejectRes(new Error('timeout')) })
          if (req.method === 'POST' || req.method === 'PUT') {
            req.pipe(proxyReq)
          } else {
            proxyReq.end()
          }
        })

        // 保存 cookies
        const setCookieHeaders = proxyRes.headers['set-cookie']
        if (setCookieHeaders) {
          updateCookies(appId, targetDomain, setCookieHeaders)
        }

        // 读取并解压响应体
        const body = await decompressResponse(proxyRes, proxyRes.headers['content-encoding'])

        // 构造响应头 - 透传所有响应头，只移除必要的
        const resHeaders = {}
        const skipHeaders = new Set(['transfer-encoding', 'content-encoding', 'content-security-policy', 'x-frame-options'])
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!skipHeaders.has(k)) resHeaders[k] = v
        }
        resHeaders['access-control-allow-origin'] = '*'

        // 直接透传，不做 URL 重写
        resHeaders['content-length'] = body.length
        res.writeHead(proxyRes.statusCode, resHeaders)
        res.end(body)
      } catch (err) {
        console.error('[Proxy Error]', err.message)
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Proxy error: ' + err.message)
        }
      }
    })

    server.listen(port, '127.0.0.1', () => {
      console.log(`[Proxy] App ${appId} started on port ${port}`)
      appProxies.set(appId, { server, port, targetUrl, username, password })
      resolve(port)
    })

    server.on('error', (err) => {
      console.error(`[Proxy] Server error for ${appId}:`, err)
      reject(err)
    })
  })
}

/**
 * 获取已注册的代理 URL
 */
function getProxyUrl(appId) {
  const proxy = appProxies.get(appId)
  if (!proxy) return null
  return `http://127.0.0.1:${proxy.port}`
}

/**
 * 移除应用代理
 */
function removeAppProxy(appId) {
  const proxy = appProxies.get(appId)
  if (proxy) {
    proxy.server.close()
    appProxies.delete(appId)
    console.log(`[Proxy] App ${appId} stopped`)
  }
}

// ============================================
// 通过 window 向渲染进程注入 nodejs 能力
// ============================================
window.services = {
  getConfigPath() {
    let userDataPath
    try {
      userDataPath = window.ztools?.getPath('userData')
    } catch (e) {
      // ignore
    }
    if (!userDataPath) {
      userDataPath = process.env.USERPROFILE || process.env.HOME || '/tmp'
    }
    return path.join(userDataPath, 'webapp-configs.json')
  },

  readConfig() {
    try {
      const configPath = this.getConfigPath()
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, { encoding: 'utf-8' })
        return JSON.parse(data)
      }
    } catch (e) {
      console.error('读取配置失败:', e)
    }
    return []
  },

  saveConfig(configs) {
    try {
      const configPath = this.getConfigPath()
      const dir = path.dirname(configPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(configPath, JSON.stringify(configs, null, 2), { encoding: 'utf-8' })
      return true
    } catch (e) {
      console.error('保存配置失败:', e)
      return false
    }
  },

  async proxyFetch(url, options = {}) {
    try {
      const response = await fetch(url, options)
      const text = await response.text()
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: text
      }
    } catch (e) {
      console.error('代理请求失败:', e)
      throw e
    }
  },

  // Basic Auth 代理（每个应用独立端口）
  async setupAppProxy(appId, targetUrl, username, password) {
    await createAppProxy(appId, targetUrl, username, password)
    return getProxyUrl(appId)
  },

  getProxyUrl,
  removeAppProxy,

  // Cookie 管理
  getCookies(appId) {
    const cookies = getCookies(appId)
    // 检查是否有任何 cookies
    for (const domain of Object.keys(cookies)) {
      if (cookies[domain] && cookies[domain].length > 0) {
        return true
      }
    }
    return false
  },

  clearCookies(appId) {
    cookiesMap.delete(appId)
    saveCookies()
  }
}
