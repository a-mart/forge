import { describe, expect, it } from 'vitest'
import { createElectronDevelopmentWorkspaceEnvironment } from '../dev-electron.mjs'

describe('Electron development backend routing', () => {
  it('lets every renderer derive the Electron backend host from its own page', () => {
    const environment = createElectronDevelopmentWorkspaceEnvironment({
      environment: { PRESERVED: 'yes' },
    })

    expect(environment).toEqual({
      PRESERVED: 'yes',
      VITE_FORGE_WS_PORT: '47287',
    })
    expect(environment).not.toHaveProperty('VITE_FORGE_WS_URL')
  })

  it('keeps remote mode as a thin network-exposure wrapper around the same routing', () => {
    const environment = createElectronDevelopmentWorkspaceEnvironment({
      environment: { PRESERVED: 'yes' },
      remote: true,
    })

    expect(environment).toEqual({
      PRESERVED: 'yes',
      VITE_FORGE_WS_PORT: '47287',
      FORGE_HOST: '0.0.0.0',
      FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
      VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS: 'true',
    })
    expect(environment).not.toHaveProperty('VITE_FORGE_WS_URL')
  })
})
