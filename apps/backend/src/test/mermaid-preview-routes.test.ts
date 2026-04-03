import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createMermaidPreviewRoutes } from '../ws/routes/mermaid-preview-routes.js'

interface TestServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

const activeServers: TestServer[] = []

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
})

describe('mermaid preview shipped asset pair', () => {
  it('embed.js contains the forge:mermaid-ping handler so parents can recover from a missed READY', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/assets/embed.js`)
    expect(response.status).toBe(200)
    const source = await response.text()

    // The embed must post READY at bootstrap
    expect(source).toContain('forge:mermaid-ready')
    // The embed must handle pings from the parent to re-post READY
    expect(source).toContain('forge:mermaid-ping')
    // The embed must handle render requests
    expect(source).toContain('forge:mermaid-render')
    // The embed must handle export requests
    expect(source).toContain('forge:mermaid-export-svg')
    // The embed must post results back
    expect(source).toContain('forge:mermaid-rendered')
    expect(source).toContain('forge:mermaid-export-svg-result')
    // The embed must post error messages
    expect(source).toContain('forge:mermaid-error')
  })

  it('embed HTML loads the vendored mermaid runtime and embed.js', async () => {
    const server = await createMermaidPreviewTestServer()

    const htmlResponse = await fetch(
      `${server.baseUrl}/mermaid-preview/embed?instanceId=test-1&theme=dark`,
    )
    expect(htmlResponse.status).toBe(200)
    const html = await htmlResponse.text()

    // Verify script references
    expect(html).toContain('/mermaid-preview/assets/vendor/mermaid.min.js')
    expect(html).toContain('/mermaid-preview/assets/embed.js')
    expect(html).toContain('/mermaid-preview/assets/embed.css')

    // Verify all three referenced assets are actually fetchable
    const assetPaths = [
      '/mermaid-preview/assets/vendor/mermaid.min.js',
      '/mermaid-preview/assets/embed.js',
      '/mermaid-preview/assets/embed.css',
    ]

    for (const assetPath of assetPaths) {
      const assetResponse = await fetch(`${server.baseUrl}${assetPath}`)
      expect(assetResponse.status).toBe(200)
      const body = await assetResponse.text()
      expect(body.length).toBeGreaterThan(0)
    }
  })

  it('vendored mermaid.min.js exposes a mermaid global', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(
      `${server.baseUrl}/mermaid-preview/assets/vendor/mermaid.min.js`,
    )
    expect(response.status).toBe(200)
    const source = await response.text()

    // The vendored mermaid runtime must expose itself as a global
    expect(source).toContain('globalThis["mermaid"]')
    // It should be non-trivial (the real library is >1MB minified)
    expect(source.length).toBeGreaterThan(10_000)
  })

  it('embed.js ping handler calls the same postReadyMessage as bootstrap', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/assets/embed.js`)
    expect(response.status).toBe(200)
    const source = await response.text()

    // The ping handler must call postReadyMessage (the same function
    // used at bootstrap) so the READY payload is always identical
    expect(source).toMatch(/case\s+PING_MESSAGE\s*:\s*\n?\s*postReadyMessage\(\)/)

    // Bootstrap must also call postReadyMessage
    const bootstrapMatch = source.match(/renderPlaceholder\([^)]+\)\s*\n\s*postReadyMessage\(\)/)
    expect(bootstrapMatch).toBeTruthy()
  })
})

describe('mermaid preview routes', () => {
  it('serves the embed shell with restrictive headers', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/embed?instanceId=diagram-1&theme=light`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')

    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    // Mermaid requires 'unsafe-eval' (uses Function("return this")()) and
    // 'unsafe-inline' for injected <style> elements (theme CSS).
    expect(csp).toContain("script-src 'self' 'unsafe-eval'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain('frame-ancestors')

    const html = await response.text()
    expect(html).toContain('/mermaid-preview/assets/embed.css')
    expect(html).toContain('/mermaid-preview/assets/vendor/mermaid.min.js')
    expect(html).toContain('/mermaid-preview/assets/embed.js')
    expect(html).toContain('Waiting for Mermaid source…')
    expect(html).toContain('data-theme-mode="light"')
    expect(html).not.toContain('diagram-1')
  })

  it('serves static assets with expected content types', async () => {
    const server = await createMermaidPreviewTestServer()

    const jsResponse = await fetch(`${server.baseUrl}/mermaid-preview/assets/embed.js`)
    expect(jsResponse.status).toBe(200)
    expect(jsResponse.headers.get('content-type')).toContain('text/javascript')
    expect(jsResponse.headers.get('cache-control')).toBe('no-store')
    expect(await jsResponse.text()).toContain('forge:mermaid-ready')

    const cssResponse = await fetch(`${server.baseUrl}/mermaid-preview/assets/embed.css`)
    expect(cssResponse.status).toBe(200)
    expect(cssResponse.headers.get('content-type')).toContain('text/css')
    expect(cssResponse.headers.get('cache-control')).toBe('no-store')
    expect(await cssResponse.text()).toContain('.mermaid-preview-shell')

    const mermaidResponse = await fetch(
      `${server.baseUrl}/mermaid-preview/assets/vendor/mermaid.min.js`,
    )
    expect(mermaidResponse.status).toBe(200)
    expect(mermaidResponse.headers.get('content-type')).toContain('text/javascript')
    expect(mermaidResponse.headers.get('cache-control')).toBe('no-store')
    expect(await mermaidResponse.text()).toContain('globalThis["mermaid"]')
  })

  it('rejects attempted asset path traversal', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/assets/%2E%2E%2Fsecret.js`)
    expect(response.status).toBe(403)

    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toBe('Forbidden')
  })

  it('returns 404 for missing assets inside the allowed root', async () => {
    const server = await createMermaidPreviewTestServer()

    const response = await fetch(`${server.baseUrl}/mermaid-preview/assets/missing.js`)
    expect(response.status).toBe(404)

    const payload = (await response.json()) as { error?: string }
    expect(payload.error).toBe('Asset not found')
  })
})

async function createMermaidPreviewTestServer(): Promise<TestServer> {
  const routes = createMermaidPreviewRoutes()

  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve test server address')
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }

  activeServers.push(testServer)
  return testServer
}

async function handleRouteRequest(
  routes: ReturnType<typeof createMermaidPreviewRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname))
  if (!route) {
    response.statusCode = 404
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ error: 'Not Found' }))
    return
  }

  await route.handle(request, response, requestUrl)
}
