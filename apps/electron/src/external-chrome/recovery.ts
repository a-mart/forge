import {
  deploymentContentEquals,
  type ExternalChromeDeployer,
  type ExternalChromeInstallRecord,
} from './deployer.js'

type StartupExternalChromeDeployer = Pick<
  ExternalChromeDeployer,
  'recover' | 'verifyDeploymentForStartup' | 'stage' | 'pendingDeployment' | 'activateStaged'
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
    const installed = await this.deployer.verifyDeploymentForStartup()
    return installed.state === 'ready' ? null : this.deployer.activateStaged()
  }

  /**
   * Validate and stage the bundled package at Desktop startup. A development
   * rebuild may intentionally reuse the app/package version, so an exact
   * selector-bound content change is activated while no coordinator endpoint is
   * running. A release is also activated when the old installation is fully
   * integrity-proven and only its Desktop-version range is incompatible; ready
   * release installations retain the normal immutable staged-update path.
   */
  async deployAtStartup(options: ExternalChromeStartupDeploymentOptions): Promise<ExternalChromeInstallRecord | null> {
    await this.run()
    const installed = await this.deployer.verifyDeploymentForStartup()
    await this.deployer.stage()
    const staged = await this.deployer.pendingDeployment()
    const developmentContentRebuild = options.development
      && installed.state === 'ready'
      && staged !== null
      && staged.packageVersion === installed.install.packageVersion
      && !deploymentContentEquals(staged, installed.install)
    if (installed.state === 'missing' || installed.state === 'desktop-incompatible' || developmentContentRebuild) {
      return this.deployer.activateStaged()
    }
    return null
  }
}
