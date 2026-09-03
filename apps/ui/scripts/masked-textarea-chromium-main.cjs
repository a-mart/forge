const { app, BrowserWindow } = require('electron')

const url = process.argv[2]
const canary = 'AX-CANARY-DO-NOT-EXPOSE'
const expectedValue = `first\r\n${canary}\r\nlast`
const labels = [
  'Create private value',
  'Replace private value',
  'Request private value',
]

async function waitForFixture(window) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (await window.webContents.executeJavaScript('Boolean(window.maskedTextareaAxFixture)')) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Masked textarea fixture did not initialize')
}

async function editWithKeyboard(window, selector, selectionStart, selectionEnd, keyCode, expectedMask) {
  const selected = await window.webContents.executeJavaScript(`
    (() => {
      const control = document.querySelector(${JSON.stringify(selector)})
      if (!(control instanceof HTMLTextAreaElement)) return false
      control.focus()
      control.setSelectionRange(${selectionStart}, ${selectionEnd})
      return document.activeElement === control
    })()
  `)
  if (selected !== true) throw new Error('Masked textarea could not receive keyboard input')
  await new Promise((resolve) => setTimeout(resolve, 10))

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  const result = await window.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() => {
      const control = document.querySelector(${JSON.stringify(selector)})
      resolve(control instanceof HTMLTextAreaElement && control.value === ${JSON.stringify(expectedMask)})
    }))
  `)
  if (result !== true) throw new Error('Masked textarea keyboard edit was not handled')
}

async function pasteValue(window, selector) {
  const result = await window.webContents.executeJavaScript(`
    (() => {
      const control = document.querySelector(${JSON.stringify(selector)})
      if (!(control instanceof HTMLTextAreaElement)) return false
      control.focus()
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', ${JSON.stringify(expectedValue)})
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      })
      control.dispatchEvent(event)
      return event.defaultPrevented
    })()
  `)
  if (result !== true) throw new Error('Masked textarea paste was not handled')
}

function axValueFor(node) {
  return typeof node.value?.value === 'string' ? node.value.value : ''
}

async function run() {
  if (!url) throw new Error('Masked textarea fixture URL is required')

  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  try {
    await window.loadURL(url)
    window.webContents.focus()
    await waitForFixture(window)

    const createControl = '#create-value'
    await editWithKeyboard(window, createControl, 0, 0, 'A', '•')
    await editWithKeyboard(window, createControl, 1, 1, 'B', '••')
    await editWithKeyboard(window, createControl, 1, 1, 'Backspace', '•')
    await editWithKeyboard(window, createControl, 0, 0, 'A', '••')
    await editWithKeyboard(window, createControl, 1, 1, 'Enter', '•\n•')
    await editWithKeyboard(window, createControl, 1, 1, 'Delete', '••')
    await editWithKeyboard(window, createControl, 0, 2, 'Z', '•')
    await window.webContents.executeJavaScript(
      "document.querySelector('#create-value')?.setSelectionRange(0, 1)",
    )

    for (const operation of ['create', 'replace', 'requestFulfillment']) {
      await pasteValue(window, `#${operation}-value`)
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-operation="${operation}"]')?.click()`,
      )
    }

    const fixtureStatus = await window.webContents.executeJavaScript(
      'window.maskedTextareaAxFixture?.status()',
    )
    const debuggerApi = window.webContents.debugger
    debuggerApi.attach('1.3')
    await debuggerApi.sendCommand('Accessibility.enable')
    const tree = await debuggerApi.sendCommand('Accessibility.getFullAXTree')
    const textboxes = tree.nodes.filter((node) => (
      node.role?.value === 'textbox' && labels.includes(node.name?.value)
    ))
    const report = {
      passed: fixtureStatus?.callbacksReceivedExactBytes === true
        && fixtureStatus.editingCallbacksPreserveRawOffsets === true
        && fixtureStatus.nativeValuesAreMasked === true
        && textboxes.length === labels.length
        && textboxes.every((node) => /^[•\n]*$/.test(axValueFor(node)))
        && !JSON.stringify(tree).includes(canary),
      callbackBytesExact: fixtureStatus?.callbacksReceivedExactBytes === true,
      editingCallbacksPreserveRawOffsets: fixtureStatus?.editingCallbacksPreserveRawOffsets === true,
      nativeValuesMasked: fixtureStatus?.nativeValuesAreMasked === true,
      accessibilityLabelsPresent: textboxes.length === labels.length,
      accessibilityValuesMasked: textboxes.every((node) => /^[•\n]*$/.test(axValueFor(node))),
      accessibilityCanaryAbsent: !JSON.stringify(tree).includes(canary),
    }
    process.stdout.write(`FORGE_MASKED_TEXTAREA_AX_RESULT=${JSON.stringify(report)}\n`)
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    if (!window.isDestroyed()) window.destroy()
    app.exit()
  }
}

run().catch(() => {
  console.error('Chromium masked textarea fixture failed')
  app.exit(1)
})
