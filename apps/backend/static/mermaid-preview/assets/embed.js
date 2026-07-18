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
const controlsElement = document.getElementById('controls')
const zoomLevelElement = document.getElementById('zoom-level')

if (!app || !statusElement || !canvasElement || !controlsElement || !zoomLevelElement) {
  throw new Error('Mermaid preview shell failed to initialize')
}

const MIN_SCALE = 0.1
const MAX_SCALE = 4
const MIN_READABLE_SCALE = 0.7
const ZOOM_FACTOR = 1.2

const state = {
  instanceId: readInstanceId(),
  requestId: null,
  renderedSvg: null,
  themeMode: readInitialThemeMode(),
  renderGeneration: 0,
  resizeObserver: null,
  svgElement: null,
  intrinsicWidth: 0,
  intrinsicHeight: 0,
  scale: 1,
  viewMode: 'initial',
  viewportWidth: 0,
  viewportHeight: 0,
  pan: null,
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
installViewportControls()

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
  controlsElement.hidden = true

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
    const dimensions = upgradeRenderedSvg(canvasElement.querySelector('svg'))
    state.svgElement = dimensions.svgElement
    state.intrinsicWidth = dimensions.width
    state.intrinsicHeight = dimensions.height
    controlsElement.hidden = false
    resetReadableView()
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
    state.svgElement = null
    controlsElement.hidden = true
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
    throw new Error('Rendered Mermaid output did not contain an SVG element')
  }

  const dimensions = readSvgDimensions(svgElement)
  svgElement.removeAttribute('width')
  svgElement.removeAttribute('height')
  svgElement.style.maxWidth = 'none'
  svgElement.style.display = 'block'
  return { svgElement, ...dimensions }
}

function readSvgDimensions(svgElement) {
  const viewBox = svgElement.viewBox?.baseVal
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height }
  }

  const bounds = svgElement.getBoundingClientRect()
  return {
    width: Math.max(bounds.width, 1),
    height: Math.max(bounds.height, 1),
  }
}

function installViewportControls() {
  controlsElement.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-view-action]')
      : null
    const action = button?.getAttribute('data-view-action')
    if (!action) return

    switch (action) {
      case 'zoom-out':
        setScale(state.scale / ZOOM_FACTOR, { mode: 'manual' })
        break
      case 'zoom-in':
        setScale(state.scale * ZOOM_FACTOR, { mode: 'manual' })
        break
      case 'fit':
        fitDiagram()
        break
      case 'actual-size':
        setScale(1, { mode: 'actual' })
        break
      case 'reset':
        resetReadableView()
        break
      default:
        break
    }
  })

  canvasElement.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return

    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      setScale(state.scale * ZOOM_FACTOR, { mode: 'manual' })
    } else if (event.key === '-') {
      event.preventDefault()
      setScale(state.scale / ZOOM_FACTOR, { mode: 'manual' })
    } else if (event.key === '0') {
      event.preventDefault()
      setScale(1, { mode: 'actual' })
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault()
      fitDiagram()
    }
  })

  canvasElement.addEventListener('wheel', (event) => {
    if (!state.svgElement || (!event.ctrlKey && !event.metaKey)) return
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.002)
    setScale(state.scale * factor, {
      mode: 'manual',
      focalPoint: { clientX: event.clientX, clientY: event.clientY },
    })
  }, { passive: false })

  canvasElement.addEventListener('pointerdown', (event) => {
    if (!state.svgElement || event.button !== 0 || event.pointerType === 'touch') return
    state.pan = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: canvasElement.scrollLeft,
      scrollTop: canvasElement.scrollTop,
    }
    canvasElement.dataset.panning = 'true'
    canvasElement.setPointerCapture(event.pointerId)
  })

  canvasElement.addEventListener('pointermove', (event) => {
    if (!state.pan || state.pan.pointerId !== event.pointerId) return
    canvasElement.scrollLeft = state.pan.scrollLeft - (event.clientX - state.pan.clientX)
    canvasElement.scrollTop = state.pan.scrollTop - (event.clientY - state.pan.clientY)
  })

  const stopPanning = (event) => {
    if (!state.pan || state.pan.pointerId !== event.pointerId) return
    if (canvasElement.hasPointerCapture(event.pointerId)) {
      canvasElement.releasePointerCapture(event.pointerId)
    }
    state.pan = null
    delete canvasElement.dataset.panning
  }
  canvasElement.addEventListener('pointerup', stopPanning)
  canvasElement.addEventListener('pointercancel', stopPanning)
}

function resetReadableView() {
  const fitScale = calculateFitScale()
  const initialScale = fitScale < MIN_READABLE_SCALE
    ? Math.min(1, MIN_READABLE_SCALE)
    : fitScale
  setScale(initialScale, { mode: 'initial', resetScroll: true })

  statusElement.textContent = fitScale < MIN_READABLE_SCALE
    ? `Large diagram — opened at ${formatScale(initialScale)} for readability`
    : 'Mermaid diagram ready'
}

function fitDiagram() {
  setScale(calculateFitScale(), { mode: 'fit', resetScroll: true })
  statusElement.textContent = 'Mermaid diagram ready — fitted to viewport'
}

function calculateFitScale() {
  if (!state.intrinsicWidth || !state.intrinsicHeight) return 1
  const styles = getComputedStyle(canvasElement)
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight)
  const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)
  const availableWidth = Math.max(canvasElement.clientWidth - horizontalPadding, 1)
  const availableHeight = Math.max(canvasElement.clientHeight - verticalPadding, 1)
  return clampScale(Math.min(
    availableWidth / state.intrinsicWidth,
    availableHeight / state.intrinsicHeight,
    1,
  ))
}

function setScale(nextScale, options = {}) {
  if (!state.svgElement || !state.intrinsicWidth || !state.intrinsicHeight) return

  const previousScale = state.scale || 1
  const scale = clampScale(nextScale)
  const canvasRect = canvasElement.getBoundingClientRect()
  const focalX = options.focalPoint
    ? options.focalPoint.clientX - canvasRect.left
    : canvasElement.clientWidth / 2
  const focalY = options.focalPoint
    ? options.focalPoint.clientY - canvasRect.top
    : canvasElement.clientHeight / 2
  const contentX = (canvasElement.scrollLeft + focalX) / previousScale
  const contentY = (canvasElement.scrollTop + focalY) / previousScale

  state.scale = scale
  state.viewMode = options.mode || 'manual'
  state.svgElement.style.width = `${Math.ceil(state.intrinsicWidth * scale)}px`
  state.svgElement.style.height = `${Math.ceil(state.intrinsicHeight * scale)}px`
  zoomLevelElement.textContent = formatScale(scale)

  requestAnimationFrame(() => {
    if (options.resetScroll) {
      canvasElement.scrollTo({ left: 0, top: 0 })
      return
    }
    canvasElement.scrollTo({
      left: Math.max(contentX * scale - focalX, 0),
      top: Math.max(contentY * scale - focalY, 0),
    })
  })
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(scale) ? scale : 1))
}

function formatScale(scale) {
  return `${Math.round(scale * 100)}%`
}

function observeSize() {
  disconnectResizeObserver()

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  state.viewportWidth = canvasElement.clientWidth
  state.viewportHeight = canvasElement.clientHeight

  state.resizeObserver = new ResizeObserver(() => {
    const viewportChanged = canvasElement.clientWidth !== state.viewportWidth
      || canvasElement.clientHeight !== state.viewportHeight
    state.viewportWidth = canvasElement.clientWidth
    state.viewportHeight = canvasElement.clientHeight

    if (viewportChanged) {
      if (state.viewMode === 'fit') {
        setScale(calculateFitScale(), { mode: 'fit', resetScroll: true })
      } else if (state.viewMode === 'initial') {
        resetReadableView()
      }
    }
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
