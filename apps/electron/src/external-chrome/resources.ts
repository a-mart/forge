import path from 'node:path'

export interface ExternalChromeResourceLocation {
  root: string
  development: boolean
}

/**
 * Keep unpacked development resources outside dist/app.asar while packaged
 * builds continue to consume electron-builder's resources directory.
 */
export function resolveExternalChromeResources(options: {
  isPackaged: boolean
  resourcesPath: string
  developmentAppRoot: string
}): ExternalChromeResourceLocation {
  return options.isPackaged
    ? { root: path.join(options.resourcesPath, 'external-chrome'), development: false }
    : { root: path.join(options.developmentAppRoot, '.dev-external-chrome'), development: true }
}
