import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExternalChromeResources } from '../resources.js'

describe('External Chrome runtime resource resolution', () => {
  it('uses the prepared workspace inventory for development Electron', () => {
    const appRoot = path.resolve('/workspace', 'apps', 'electron')
    expect(resolveExternalChromeResources({
      isPackaged: false,
      resourcesPath: path.resolve('/unused', 'resources'),
      developmentAppRoot: appRoot,
    })).toEqual({
      root: path.join(appRoot, '.dev-external-chrome'),
      development: true,
    })
  })

  it('preserves the packaged electron-builder resource layout and release policy', () => {
    const resourcesPath = path.resolve('/Applications', 'Forge.app', 'Contents', 'Resources')
    expect(resolveExternalChromeResources({
      isPackaged: true,
      resourcesPath,
      developmentAppRoot: path.resolve('/unused', 'app'),
    })).toEqual({
      root: path.join(resourcesPath, 'external-chrome'),
      development: false,
    })
  })
})
