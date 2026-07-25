import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackagedExternalChromeResources } from './external-chrome-package-content-smoke.mjs'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stagedRoot = path.join(electronDir, '.stage', 'external-chrome')

export async function afterPackExternalChrome(context) {
  const platform = context.electronPlatformName
  const packagedRoot = packagedExternalChromeRoot(context)

  // electron-builder's Windows extraResources transformer signs every copied
  // .exe before afterPack. Restore the already-signed, manifest-hashed host here;
  // signApp does not revisit resources/. macOS instead uses mac.signIgnore so the
  // nested host remains byte-identical while the outer app is signed.
  if (platform === 'win32') {
    await restorePreSignedWindowsResources({ sourceRoot: stagedRoot, packagedRoot })
  }
  await verifyPackagedExternalChromeResources({
    root: packagedRoot,
    platform,
    allowValidation: validationOnly(),
  })
}

export async function restorePreSignedWindowsResources({ sourceRoot, packagedRoot }) {
  await rm(packagedRoot, { recursive: true, force: true })
  await cp(sourceRoot, packagedRoot, { recursive: true })
}

export async function afterSignExternalChrome(context) {
  await verifyPackagedExternalChromeResources({
    root: packagedExternalChromeRoot(context),
    platform: context.electronPlatformName,
    allowValidation: validationOnly(),
  })
}

export function packagedExternalChromeRoot(context) {
  if (context.electronPlatformName === 'darwin') {
    const product = context.packager.appInfo.productFilename
    return path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources', 'external-chrome')
  }
  return path.join(context.appOutDir, 'resources', 'external-chrome')
}

function validationOnly() {
  return process.env.FORGE_EXTERNAL_CHROME_BUILD_MODE === 'validation'
}
