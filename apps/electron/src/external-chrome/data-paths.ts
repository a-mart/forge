import path from 'node:path'

export interface ExternalChromeDataPaths {
  dataRoot: string
  integrationRoot: string
  extension: string
  payloads: string
  nativeHost: string
  nativeHostExecutable: string
  nativeHostManifests: string
  state: string
  installState: string
  previousState: string
  auth: string
  authKey: string
  run: string
  rendezvous: string
  deployment: string
  journal: string
  lock: string
}

/**
 * Electron receives dataRoot from the backend's post-migration ready IPC message.
 * Keep the names in sync with the authoritative backend storage/data-paths helpers.
 */
export function resolveExternalChromeDataPaths(
  canonicalDataRoot: string,
  platform: NodeJS.Platform = process.platform,
): ExternalChromeDataPaths {
  if (!path.isAbsolute(canonicalDataRoot)) {
    throw new Error('External Chrome requires an absolute backend-resolved Forge data root')
  }

  const dataRoot = path.normalize(canonicalDataRoot)
  const integrationRoot = path.join(dataRoot, 'integrations', 'external-chrome')
  const extension = path.join(integrationRoot, 'extension')
  const nativeHost = path.join(integrationRoot, 'native-host')
  const state = path.join(integrationRoot, 'state')
  const auth = path.join(integrationRoot, 'auth')
  const run = path.join(integrationRoot, 'run')
  const deployment = path.join(integrationRoot, 'deployment')

  return {
    dataRoot,
    integrationRoot,
    extension,
    payloads: path.join(extension, 'payloads'),
    nativeHost,
    nativeHostExecutable: path.join(nativeHost, `forge-external-chrome-native-host${platform === 'win32' ? '.exe' : ''}`),
    nativeHostManifests: path.join(integrationRoot, 'native-host-manifests'),
    state,
    installState: path.join(state, 'install.json'),
    previousState: path.join(state, 'previous.json'),
    auth,
    authKey: path.join(auth, 'native-messaging.key'),
    run,
    rendezvous: path.join(run, 'rendezvous.json'),
    deployment,
    journal: path.join(deployment, 'journal.json'),
    lock: path.join(integrationRoot, 'deploy.lock'),
  }
}

export function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`External Chrome path escapes its root: ${candidate}`)
  }
}
