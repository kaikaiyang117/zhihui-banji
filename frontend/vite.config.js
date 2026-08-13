import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import http from 'node:http'

// 构建产物输出到 backend/static，由 Node 服务托管
export default defineConfig({
  plugins: [vue(), workbenchApiMiddleware()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
    assetsDir: 'assets'
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})

/* 后端 API 转发：不用静态代理，因为后端端口在桌面启动后才确定
 * （macOS 上 5000 常被 AirTunes 占用，后端会自动换到下一个可用端口），
 * 且后端重启后端口可能变化。这里对每个 /api 请求实时探测并转发，
 * 连接失败时重新探测一次再重试。 */
function workbenchApiMiddleware() {
  let cachedPort = 0
  let cachedAt = 0
  let probing = null

  const probe = (port, timeout = 600) => new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/system/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.setTimeout(timeout, () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })

  const backendPort = async () => {
    const now = Date.now()
    if (cachedPort && now - cachedAt < 30000) return cachedPort
    if (probing) return probing
    probing = (async () => {
      const fixed = process.env.WORKBENCH_PORT && Number(process.env.WORKBENCH_PORT)
      const start = fixed || 5000
      const end = fixed || 5010
      for (let port = start; port <= end; port++) {
        if (await probe(port)) {
          cachedPort = port
          cachedAt = Date.now()
          return port
        }
      }
      cachedPort = 0
      cachedAt = Date.now()
      return null
    })()
    try {
      return await probing
    } finally {
      probing = null
    }
  }

  const fail = (res, status, detail) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ detail }))
  }

  const forward = (req, res, port, retried) => {
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) res.appendHeader(key, v)
        } else {
          res.setHeader(key, value)
        }
      }
      upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
      cachedPort = 0
      cachedAt = 0
      if (!retried) {
        backendPort().then((port) => {
          if (port) forward(req, res, port, true)
          else fail(res, 502, '工作台后端暂不可用，请确认桌面工作台已启动')
        })
        return
      }
      fail(res, 502, '工作台后端连接失败，请确认桌面工作台已启动')
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }

  return {
    name: 'workbench-api-middleware',
    configureServer(server) {
      /* 注意：不能用 use('/api', ...) 挂载，connect 会剥掉 req.url 的前缀，
       * 导致转发路径错误；这里手动判断前缀以保留完整 URL。 */
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/api')) return next()
        backendPort().then((port) => {
          if (port) forward(req, res, port, false)
          else fail(res, 502, '工作台后端未启动，请先启动桌面工作台')
        })
      })
    },
  }
}