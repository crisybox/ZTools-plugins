const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const zlib = require('node:zlib')
const { URL } = require('node:url')

// 解压响应体（支持 gzip / deflate / br）
function decompressResponse(stream, encoding) {
  if (!encoding) return Promise.resolve(stream)
  const enc = encoding.toLowerCase().trim()
  if (enc === 'gzip' || enc === 'x-gzip') {
    return new Promise((resolve, reject) => {
      const chunks = []
      stream.pipe(zlib.createGunzip()).on('data', c => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject)
    })
  }
  if (enc === 'deflate') {
    return new Promise((resolve, reject) => {
      const chunks = []
      stream.pipe(zlib.createInflate()).on('data', c => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject)
    })
  }
  if (enc === 'br') {
    return new Promise((resolve, reject) => {
      const chunks = []
      stream.pipe(zlib.createBrotliDecompress()).on('data', c => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject)
    })
  }
  // 未知编码，原样返回
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', c => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

// ============================================
// 本地 HTTP 反向代理（Basic Auth 场景）
// ============================================
let proxyServer = null
let proxyPort = null
let proxyReady = null // Promise<void>，用于等待代理启动完成
const appAuthMap = new Map()

function startProxyServer() {
  if (proxyReady) return proxyReady

  proxyReady = new Promise((resolve, reject) => {
    proxyServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1')
        const pathParts = reqUrl.pathname.split('/').filter(Boolean)
        const appId = pathParts.shift() // 取出 appId，剩余部分为目标路径
        const targetPath = '/' + pathParts.join('/')

        if (!appId || !appAuthMap.has(appId)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('App not found')
          return
        }

        const { targetUrl, username, password } = appAuthMap.get(appId)
        const base = targetUrl.replace(/\/+$/, '')
        const fullUrl = base + targetPath + reqUrl.search

        const targetObj = new URL(fullUrl)
        const client = targetObj.protocol === 'https:' ? https : http

        // 构造转发请求头
        const fwdHeaders = {}
        // 转发部分原始请求头（不转发 accept-encoding，确保服务器返回未压缩内容）
        const passHeaders = ['accept', 'accept-language', 'content-type', 'cookie']
        for (const h of passHeaders) {
          if (req.headers[h]) fwdHeaders[h] = req.headers[h]
        }
        // 注入 Basic Auth
        if (username) {
          fwdHeaders['authorization'] = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
        }

        const proxyRes = await new Promise((resolveRes, rejectRes) => {
          const proxyReq = client.request(targetObj, {
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

        // 读取并解压响应体
        const body = await decompressResponse(proxyRes, proxyRes.headers['content-encoding'])

        // 构造响应头
        const resHeaders = {}
        const skipHeaders = new Set(['transfer-encoding', 'content-encoding', 'content-security-policy', 'x-frame-options'])
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!skipHeaders.has(k)) resHeaders[k] = v
        }
        resHeaders['access-control-allow-origin'] = '*'

        const ct = (proxyRes.headers['content-type'] || '').toLowerCase()

        // 对 HTML 响应做 URL 重写：将目标域的绝对 URL 替换为代理 URL
        if (ct.includes('text/html')) {
          let html = body.toString('utf-8')
          const origin = targetObj.origin // e.g. https://target.com
          const proxyBase = 'http://127.0.0.1:' + proxyPort + '/' + appId
          // 替换目标源的绝对 URL（href="https://target.com/...", src="https://target.com/..."）
          while (html.includes(origin)) {
            html = html.replace(origin, proxyBase)
          }
          // 替换协议相对 URL（//target.com/...）
          const protoRelative = '//' + targetObj.host
          while (html.includes(protoRelative)) {
            html = html.replace(protoRelative, proxyBase)
          }
          const newBody = Buffer.from(html, 'utf-8')
          resHeaders['content-length'] = newBody.length
          res.writeHead(proxyRes.statusCode, resHeaders)
          res.end(newBody)
        } else {
          resHeaders['content-length'] = body.length
          res.writeHead(proxyRes.statusCode, resHeaders)
          res.end(body)
        }
      } catch (err) {
        console.error('[Proxy Error]', err.message)
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Proxy error: ' + err.message)
        }
      }
    })

    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port
      console.log('[Proxy] started on port ' + proxyPort)
      resolve()
    })

    proxyServer.on('error', (err) => {
      console.error('[Proxy] server error:', err)
      reject(err)
    })
  })

  return proxyReady
}

/**
 * 注册应用认证信息，返回代理 URL
 */
async function setupAppProxy(appId, targetUrl, username, password) {
  appAuthMap.set(appId, { targetUrl, username, password })
  await startProxyServer()
  return 'http://127.0.0.1:' + proxyPort + '/' + appId + '/'
}

/**
 * 获取已注册的代理 URL（不等待启动）
 */
function getProxyUrl(appId) {
  if (!proxyPort) return null
  return 'http://127.0.0.1:' + proxyPort + '/' + appId + '/'
}

function removeAppProxy(appId) {
  appAuthMap.delete(appId)
}

// ============================================
// 通过 window 向渲染进程注入 nodejs 能力
// ============================================
window.services = {
  getConfigPath() {
    const userDataPath = window.ztools.getPath('userData') || path.join(process.env.USERPROFILE, '.ztools')
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

  // Basic Auth 代理
  setupAppProxy,
  getProxyUrl,
  removeAppProxy
}
