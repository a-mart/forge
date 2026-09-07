import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual callbacks without booting Electron or copying their logic.
const source = readFileSync(new URL('../main.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
let beforeQuit = ''
let prepareUpdate = ''
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'app.on'
    && node.arguments[0]?.getText(ast) === "'before-quit'") {
    beforeQuit = node.arguments[1].getText(ast)
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'prepareQuitForUpdate') {
    prepareUpdate = node.getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(quiesce = vi.fn(async () => {})) {
  expect(beforeQuit).not.toBe('')
  expect(prepareUpdate).not.toBe('')
  const backend = gate()
  const app = { exit: vi.fn() }
  const backendSupervisor = { stop: vi.fn(() => backend.promise) }
  const context = vm.createContext({
    app, backendSupervisor, externalChromeCoordinator: { quiesce },
    lifecycleLog: { record: vi.fn() }, console: { warn: vi.fn() },
    stopPackagedRemoteUiServer: vi.fn(async () => {}),
    browserPopoutWindow: null, sleepBlockerService: null, browserWorkspaceIpc: null,
    mainRendererRecovery: null, disposeBrowserHost: null,
    disposeExternalChromeIpc: null, disposeOpenPdfIpc: null, allowPopoutClose: false,
  })
  const script = ts.transpileModule(`
    let appIsQuitting = false;
    let appQuitCleanupComplete = false;
    ${prepareUpdate}
    globalThis.onBeforeQuit = ${beforeQuit};
    globalThis.prepareUpdate = prepareQuitForUpdate;
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(script, context)
  const quit = () => {
    const event = { preventDefault: vi.fn() }
    context.onBeforeQuit(event)
    return event
  }
  return { backend, app, backendSupervisor, context, quit, quiesce }
}

describe('Electron quit cleanup', () => {
  it('prevents repeated quit events while backend shutdown is pending', async () => {
    const fx = fixture()
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fx.backendSupervisor.stop).toHaveBeenCalledOnce())
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    expect(fx.app.exit).not.toHaveBeenCalled()
    expect(fx.quiesce).toHaveBeenCalledOnce()
    fx.backend.resolve()
    await vi.waitFor(() => expect(fx.app.exit).toHaveBeenCalledExactlyOnceWith(0))
  })

  it('allows updater quit only after backend preparation finishes', async () => {
    const fx = fixture()
    const preparation = fx.context.prepareUpdate()
    await vi.waitFor(() => expect(fx.backendSupervisor.stop).toHaveBeenCalledOnce())
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    fx.backend.resolve()
    await preparation
    expect(fx.quit().preventDefault).not.toHaveBeenCalled()
    expect(fx.backendSupervisor.stop).toHaveBeenCalledOnce()
    expect(fx.app.exit).not.toHaveBeenCalled()
  })

  it('continues backend cleanup after Chrome retains unresolved recovery state', async () => {
    const fx = fixture(vi.fn(async () => { throw new Error('release unproven') }))
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(fx.backendSupervisor.stop).toHaveBeenCalledOnce())
    expect(fx.context.console.warn).toHaveBeenCalledOnce()
    expect(fx.quit().preventDefault).toHaveBeenCalledOnce()
    fx.backend.resolve()
    await vi.waitFor(() => expect(fx.app.exit).toHaveBeenCalledExactlyOnceWith(0))
  })
})
