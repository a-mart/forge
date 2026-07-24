import type { ExternalChromeDeployer } from './deployer.js'

/** Startup seam kept separate so app lifecycle code does not know journal details. */
export class ExternalChromeDeploymentRecovery {
  constructor(private readonly deployer: Pick<ExternalChromeDeployer, 'recover'>) {}

  async run(): Promise<void> {
    await this.deployer.recover()
  }
}
