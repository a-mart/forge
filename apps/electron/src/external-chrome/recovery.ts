import {
  deploymentContentEquals,
  type ExternalChromeDeployer,
  type ExternalChromeInstallRecord,
} from './deployer.js'

type StartupExternalChromeDeployer = Pick<
  ExternalChromeDeployer,
  'recover' | 'verifyDeployment' | 'stage' | 'pendingDeployment' | 'activateStaged'
>

export interface ExternalChromeStartupDeploymentOptions {
  development: boolean
}

/** Startup seam kept separate so app lifecycle code does not know journal details. */
export class ExternalChromeDeploymentRecovery {
  constructor(private readonly deployer: StartupExternalChromeDeployer) {}

  async run(): Promise<void> {
    await this.deployer.recover()
  }

  /**
   * Qualified user repair stages the packaged deployment, then replaces the
   * active selection only when verification still finds it missing or invalid.
   * A ready compatible update remains staged for the connected-runtime prepare
   * handshake.
   */
  async repair(): Promise<ExternalChromeInstallRecord | null> {
    await this.deployer.stage()
    const installed = await this.deployer.verifyDeployment()
    return installed.state === 'ready' ? null : this.deployer.activateStaged()
  }

  /**
   * Validate and stage the bundled package at Desktop startup. A development
   * rebuild may change selector-bound content with or without a package-version
   * bump, so that exact inventory is activated while no coordinator endpoint is
   * running. Ready compatible installations retain the immutable staged-update
   * path; protocol, shell ABI, platform, and hash mismatches stay fail-closed.
   */
  async deployAtStartup(options: ExternalChromeStartupDeploymentOptions): Promise<ExternalChromeInstallRecord | null> {
    await this.run()
    const installed = await this.deployer.verifyDeployment()
    await this.deployer.stage()
    const staged = await this.deployer.pendingDeployment()
    const developmentContentRebuild = options.development
      && installed.state === 'ready'
      && staged !== null
      && !deploymentContentEquals(staged, installed.install)
    if (installed.state === 'missing' || developmentContentRebuild) {
      return this.deployer.activateStaged()
    }
    return null
  }
}
