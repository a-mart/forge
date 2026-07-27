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
   * Validate and stage the bundled package at Desktop startup. A development
   * rebuild may intentionally reuse the app/package version, so an exact
   * selector-bound content change is activated while no coordinator endpoint is
   * running. Release packages retain the normal immutable staged-update path.
   */
  async deployAtStartup(options: ExternalChromeStartupDeploymentOptions): Promise<ExternalChromeInstallRecord | null> {
    await this.run()
    const installed = await this.deployer.verifyDeployment()
    await this.deployer.stage()
    const staged = await this.deployer.pendingDeployment()
    const developmentContentRebuild = options.development
      && installed.state === 'ready'
      && staged !== null
      && staged.packageVersion === installed.install.packageVersion
      && !deploymentContentEquals(staged, installed.install)
    if (installed.state === 'missing' || developmentContentRebuild) {
      return this.deployer.activateStaged()
    }
    return null
  }
}
