const READY_MESSAGE = 'forge:mermaid-ready'
const PING_MESSAGE = 'forge:mermaid-ping'
const RENDER_MESSAGE = 'forge:mermaid-render'
const RENDERED_MESSAGE = 'forge:mermaid-rendered'
const ERROR_MESSAGE = 'forge:mermaid-error'
const SIZE_MESSAGE = 'forge:mermaid-size'
const EXPORT_SVG_MESSAGE = 'forge:mermaid-export-svg'
const EXPORT_SVG_RESULT_MESSAGE = 'forge:mermaid-export-svg-result'
const DEFAULT_ERROR_MESSAGE = 'Unable to render Mermaid diagram.'

const app = document.getElementById('app')
const statusElement = document.getElementById('status')
const canvasElement = document.getElementById('canvas')

if (!app || !statusElement || !canvasElement) {
  throw new Error('Mermaid preview shell failed to initialize')
}

const state = {
  instanceId: readInstanceId(),
  requestId: null,
  renderedSvg: null,
  themeMode: readInitialThemeMode(),
  renderGeneration: 0,
  resizeObserver: null,
}

const targetOrigin = resolveTargetOrigin()

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) {
    return
  }

  const payload = asObject(event.data)
  if (!payload || typeof payload.type !== 'string') {
    return
  }

  if (typeof payload.instanceId === 'string' && state.instanceId && payload.instanceId !== state.instanceId) {
    return
  }

  if (!state.instanceId && typeof payload.instanceId === 'string' && payload.instanceId.trim()) {
    state.instanceId = payload.instanceId.trim()
  }

  switch (payload.type) {
    case PING_MESSAGE:
      postReadyMessage()
      break
    case RENDER_MESSAGE:
      void handleRenderRequest(payload)
      break
    case EXPORT_SVG_MESSAGE:
      handleExportSvgRequest(payload)
      break
    default:
      break
  }
})

window.addEventListener('error', (event) => {
  postToParent(ERROR_MESSAGE, {
    requestId: state.requestId,
    error: event.message || DEFAULT_ERROR_MESSAGE,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  postToParent(ERROR_MESSAGE, {
    requestId: state.requestId,
    error: reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : DEFAULT_ERROR_MESSAGE,
  })
})

applyThemeMode(state.themeMode)
renderPlaceholder('Waiting for Mermaid source…')
postReadyMessage()

function postReadyMessage() {
  postToParent(READY_MESSAGE, {
    capabilities: {
      render: true,
      exportSvg: true,
    },
    renderer: 'mermaid',
  })
}

async function handleRenderRequest(payload) {
  const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : null
  const source = typeof payload.source === 'string'
    ? payload.source
    : typeof payload.code === 'string'
      ? payload.code
      : ''
  const themeMode = payload.themeMode === 'light' ? 'light' : 'dark'
  const renderGeneration = ++state.renderGeneration

  state.requestId = requestId
  state.themeMode = themeMode
  state.renderedSvg = null

  applyThemeMode(themeMode)
  statusElement.textContent = 'Rendering Mermaid diagram…'
  canvasElement.replaceChildren(createLoadingMessage())

  try {
    const mermaidApi = resolveMermaidApi()
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: themeMode === 'dark' ? 'dark' : 'default',
    })

    const renderId = buildRenderId(requestId)
    const result = await mermaidApi.render(renderId, source)

    if (renderGeneration !== state.renderGeneration) {
      return
    }

    state.renderedSvg = typeof result?.svg === 'string' ? result.svg : null
    if (!state.renderedSvg) {
      throw new Error(DEFAULT_ERROR_MESSAGE)
    }

    canvasElement.innerHTML = state.renderedSvg
    upgradeRenderedSvg(canvasElement.querySelector('svg'))
    statusElement.textContent = 'Mermaid diagram ready'
    observeSize()

    postToParent(RENDERED_MESSAGE, {
      requestId,
      size: measureFrame(),
      renderMode: 'mermaid',
    })
  } catch (error) {
    if (renderGeneration !== state.renderGeneration) {
      return
    }

    state.renderedSvg = null
    disconnectResizeObserver()

    const message = error instanceof Error ? error.message : DEFAULT_ERROR_MESSAGE
    statusElement.textContent = message
    canvasElement.replaceChildren(createErrorMessage(message))

    postToParent(ERROR_MESSAGE, {
      requestId,
      message,
      error: message,
      renderMode: 'mermaid',
    })
  }
}

function handleExportSvgRequest(payload) {
  const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() ? payload.requestId.trim() : null

  postToParent(EXPORT_SVG_RESULT_MESSAGE, {
    requestId,
    svg: state.renderedSvg || undefined,
    error: state.renderedSvg ? undefined : 'No rendered Mermaid preview is available yet',
    renderMode: 'mermaid',
  })
}

function resolveMermaidApi() {
  const mermaidApi = window.mermaid
  if (!mermaidApi || typeof mermaidApi.initialize !== 'function' || typeof mermaidApi.render !== 'function') {
    throw new Error('Mermaid runtime failed to load in preview iframe')
  }

  return mermaidApi
}

function buildRenderId(requestId) {
  const instanceId = state.instanceId || 'mermaid-preview'
  const suffix = requestId || String(Date.now())
  return `${instanceId}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function upgradeRenderedSvg(svgElement) {
  if (!(svgElement instanceof SVGElement)) {
    return
  }

  svgElement.removeAttribute('height')
  svgElement.style.maxWidth = '100%'
  svgElement.style.height = 'auto'
  svgElement.style.display = 'block'
}

function observeSize() {
  disconnectResizeObserver()

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  state.resizeObserver = new ResizeObserver(() => {
    postToParent(SIZE_MESSAGE, {
      requestId: state.requestId,
      size: measureFrame(),
    })
  })

  state.resizeObserver.observe(document.body)
  state.resizeObserver.observe(canvasElement)

  const svgElement = canvasElement.querySelector('svg')
  if (svgElement) {
    state.resizeObserver.observe(svgElement)
  }
}

function disconnectResizeObserver() {
  state.resizeObserver?.disconnect()
  state.resizeObserver = null
}

function measureFrame() {
  const documentElement = document.documentElement
  const width = Math.max(
    Math.ceil(documentElement.scrollWidth || 0),
    Math.ceil(document.body.scrollWidth || 0),
    Math.ceil(canvasElement.scrollWidth || 0),
    1,
  )
  const height = Math.max(
    Math.ceil(documentElement.scrollHeight || 0),
    Math.ceil(document.body.scrollHeight || 0),
    Math.ceil(canvasElement.scrollHeight || 0),
    1,
  )

  return { width, height }
}

function renderPlaceholder(message) {
  canvasElement.replaceChildren(createMessageElement(message, 'mermaid-preview-empty'))
}

function createLoadingMessage() {
  return createMessageElement('Rendering Mermaid diagram…', 'mermaid-preview-loading')
}

function createErrorMessage(message) {
  return createMessageElement(message, 'mermaid-preview-error')
}

function createMessageElement(message, className) {
  const element = document.createElement('div')
  element.className = `mermaid-preview-message ${className}`
  element.textContent = message
  return element
}

function postToParent(type, payload) {
  if (window.parent === window) {
    return
  }

  window.parent.postMessage(
    {
      type,
      instanceId: state.instanceId,
      ...payload,
    },
    targetOrigin,
  )
}

function applyThemeMode(themeMode) {
  app.dataset.themeMode = themeMode
  document.body.dataset.themeMode = themeMode
}

function resolveTargetOrigin() {
  try {
    if (document.referrer) {
      const origin = new URL(document.referrer).origin
      if (origin && origin !== 'null') {
        return origin
      }
    }

    if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
      const ancestor = window.location.ancestorOrigins[0]
      if (ancestor && ancestor !== 'null') {
        return ancestor
      }
    }

    return '*'
  } catch {
    return '*'
  }
}

function readInstanceId() {
  try {
    const params = new URLSearchParams(window.location.search)
    const value = params.get('instanceId')?.trim()
    return value || null
  } catch {
    return null
  }
}

function readInitialThemeMode() {
  return document.body.dataset.themeMode === 'light' ? 'light' : 'dark'
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
