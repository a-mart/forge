import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExternalChromeRendezvousDocument } from '@forge/protocol'
import { resolveExternalChromeDataPaths, type ExternalChromeDataPaths } from './data-paths.js'

const execFileAsync = promisify(execFile)
const AUTH_KEY_BYTES = 32
const POSIX_PRIVATE_DIRECTORY_MODE = 0o700
const POSIX_PRIVATE_FILE_MODE = 0o600

interface AuthorityDocument {
  schemaVersion: 1
  desktopInstanceId: string
  desktopPid: number
  expiresAt: string
}

export type PrivateFileVerification = 'secure' | 'insecure' | 'missing'

export interface CurrentUserAccessController {
  preparePrivateDirectory(directory: string): Promise<void>
  securePrivateFile(file: string): Promise<void>
  verifyPrivateFile(file: string): Promise<PrivateFileVerification>
}

export class PosixCurrentUserAccessController implements CurrentUserAccessController {
  constructor(private readonly currentUid: number | undefined = process.getuid?.()) {}

  async preparePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: POSIX_PRIVATE_DIRECTORY_MODE })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (this.currentUid !== undefined && info.uid !== this.currentUid)) {
      throw new Error('External Chrome private directory is not owned by the current user')
    }
    await fs.chmod(directory, POSIX_PRIVATE_DIRECTORY_MODE)
  }

  async securePrivateFile(file: string): Promise<void> {
    await fs.chmod(file, POSIX_PRIVATE_FILE_MODE)
  }

  async verifyPrivateFile(file: string): Promise<PrivateFileVerification> {
    try {
      const stat = await fs.lstat(file)
      const modeIsPrivate = (stat.mode & 0o777) === POSIX_PRIVATE_FILE_MODE
      const ownerMatches = this.currentUid === undefined || stat.uid === this.currentUid
      return stat.isFile() && !stat.isSymbolicLink() && modeIsPrivate && ownerMatches ? 'secure' : 'insecure'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }
}

export interface ExternalCommandRunner {
  run(file: string, args: string[]): Promise<string>
}

export class ProcessCommandRunner implements ExternalCommandRunner {
  async run(file: string, args: string[]): Promise<string> {
    const result = await execFileAsync(file, args, { windowsHide: true })
    return result.stdout
  }
}

/** Windows ACL mutation is isolated behind a facade so tests and non-Windows hosts never invoke it. */
export class WindowsCurrentUserAccessController implements CurrentUserAccessController {
  constructor(
    private readonly username: string,
    private readonly runner: ExternalCommandRunner = new ProcessCommandRunner(),
  ) {}

  async preparePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    await this.apply(directory)
  }

  async securePrivateFile(file: string): Promise<void> {
    await this.apply(file)
  }

  async verifyPrivateFile(file: string): Promise<PrivateFileVerification> {
    try {
      const info = await fs.lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) return 'insecure'
      const escaped = file.replaceAll("'", "''")
      const script = [
        `$acl=Get-Acl -LiteralPath '${escaped}'`,
        '$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        "$allowed=@($me,'S-1-5-18','S-1-5-32-544')",
        '$bad=@($acl.Access | Where-Object { $_.AccessControlType -eq \'Allow\' -and $allowed -notcontains $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })',
        '$mine=@($acl.Access | Where-Object { $_.AccessControlType -eq \'Allow\' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $me })',
        "if (-not $acl.AreAccessRulesProtected -or $bad.Count -ne 0 -or $mine.Count -eq 0) { exit 3 }; 'secure'",
      ].join(';')
      const output = await this.runner.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
      return output.trim() === 'secure' ? 'secure' : 'insecure'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'insecure'
    }
  }

  private async apply(target: string): Promise<void> {
    await this.runner.run('icacls.exe', [target, '/inheritance:r', '/grant:r', `${this.username}:(F)`])
  }
}

export function createCurrentUserAccessController(
  platform: NodeJS.Platform,
  username = os.userInfo().username,
): CurrentUserAccessController {
  return platform === 'win32'
    ? new WindowsCurrentUserAccessController(username)
    : new PosixCurrentUserAccessController()
}

export interface AuthKeyRecord {
  key: Uint8Array
  keyId: string
  created: boolean
}

export class ExternalChromeAuthStore {
  private readonly paths: ExternalChromeDataPaths

  constructor(
    dataRoot: string,
    platform: NodeJS.Platform,
    private readonly access: CurrentUserAccessController,
  ) {
    this.paths = resolveExternalChromeDataPaths(dataRoot, platform)
  }

  async status(): Promise<'missing' | 'secure' | 'insecure' | 'invalid'> {
    const access = await this.access.verifyPrivateFile(this.paths.authKey)
    if (access !== 'secure') return access
    try {
      parseAuthKey(await fs.readFile(this.paths.authKey, 'utf8'))
      return 'secure'
    } catch {
      return 'invalid'
    }
  }

  async ensure(): Promise<AuthKeyRecord> {
    if (await this.status() === 'secure') {
      const key = parseAuthKey(await fs.readFile(this.paths.authKey, 'utf8'))
      return { key, keyId: authKeyId(key), created: false }
    }
    return this.rotate()
  }

  async rotate(): Promise<AuthKeyRecord> {
    await this.access.preparePrivateDirectory(this.paths.auth)
    const key = randomBytes(AUTH_KEY_BYTES)
    await atomicWrite(this.paths.authKey, `${key.toString('base64')}\n`, POSIX_PRIVATE_FILE_MODE)
    await this.access.securePrivateFile(this.paths.authKey)
    if (await this.access.verifyPrivateFile(this.paths.authKey) !== 'secure') {
      key.fill(0)
      throw new Error('External Chrome authentication key permissions are not private to the current user')
    }
    return { key, keyId: authKeyId(key), created: true }
  }

  async remove(): Promise<void> {
    await fs.rm(this.paths.authKey, { force: true })
  }
}

export interface AuthorityClaim {
  state: 'owned' | 'other-live' | 'stale'
  owner?: AuthorityDocument
  tookOver?: boolean
}

export class ExternalChromeAuthorityStore {
  readonly authorityPath: string
  readonly rendezvousPath: string

  constructor(
    dataRoot: string,
    platform: NodeJS.Platform,
    private readonly instanceId: string,
    private readonly pid: number,
    private readonly access: CurrentUserAccessController,
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
    private readonly now: () => number = Date.now,
  ) {
    const paths = resolveExternalChromeDataPaths(dataRoot, platform)
    this.authorityPath = path.join(paths.run, 'authority.json')
    this.rendezvousPath = paths.rendezvous
  }

  async inspect(): Promise<AuthorityClaim | { state: 'none' }> {
    const owner = await readJson<AuthorityDocument>(this.authorityPath)
    if (!owner) return { state: 'none' }
    if (owner.desktopInstanceId === this.instanceId && owner.desktopPid === this.pid) return { state: 'owned', owner }
    const live = isValidAuthority(owner) && Date.parse(owner.expiresAt) > this.now() && this.isProcessAlive(owner.desktopPid)
    return { state: live ? 'other-live' : 'stale', owner }
  }

  async claim(expiresAt: string): Promise<AuthorityClaim> {
    await this.access.preparePrivateDirectory(path.dirname(this.authorityPath))
    const document: AuthorityDocument = {
      schemaVersion: 1,
      desktopInstanceId: this.instanceId,
      desktopPid: this.pid,
      expiresAt,
    }
    let tookOver = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await fs.open(this.authorityPath, 'wx', POSIX_PRIVATE_FILE_MODE)
        try {
          await handle.writeFile(`${JSON.stringify(document)}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.access.securePrivateFile(this.authorityPath)
        return { state: 'owned', owner: document, tookOver }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const inspected = await this.inspect()
        if (inspected.state === 'owned' || inspected.state === 'other-live') return inspected
        tookOver = true
        await fs.rm(this.authorityPath, { force: true })
      }
    }
    throw new Error('External Chrome authority takeover did not converge')
  }

  async refresh(expiresAt: string): Promise<void> {
    const inspected = await this.inspect()
    if (inspected.state !== 'owned') throw new Error('External Chrome authority was lost')
    await atomicWrite(this.authorityPath, `${JSON.stringify({
      schemaVersion: 1,
      desktopInstanceId: this.instanceId,
      desktopPid: this.pid,
      expiresAt,
    } satisfies AuthorityDocument)}\n`, POSIX_PRIVATE_FILE_MODE)
    await this.access.securePrivateFile(this.authorityPath)
  }

  async publish(document: ExternalChromeRendezvousDocument): Promise<void> {
    if ((await this.inspect()).state !== 'owned') throw new Error('Cannot publish External Chrome rendezvous without authority')
    await atomicWrite(this.rendezvousPath, `${JSON.stringify(document)}\n`, POSIX_PRIVATE_FILE_MODE)
    await this.access.securePrivateFile(this.rendezvousPath)
    if (await this.access.verifyPrivateFile(this.rendezvousPath) !== 'secure') {
      await fs.rm(this.rendezvousPath, { force: true })
      throw new Error('External Chrome rendezvous permissions are not private to the current user')
    }
  }

  async readRendezvous(): Promise<ExternalChromeRendezvousDocument | null> {
    return readJson<ExternalChromeRendezvousDocument>(this.rendezvousPath)
  }

  async withdraw(): Promise<void> {
    const inspected = await this.inspect()
    if (inspected.state === 'owned') {
      await fs.rm(this.rendezvousPath, { force: true })
      await fs.rm(this.authorityPath, { force: true })
    }
  }
}

export function externalChromeUserScope(platform: NodeJS.Platform, username: string, uid?: number): string {
  const digest = createHash('sha256').update(`${platform}\0${username}\0${uid ?? ''}`).digest('base64url').slice(0, 32)
  return `user_${digest}`
}

export function createDesktopInstanceId(): string {
  return randomUUID().replaceAll('-', '')
}

export function createRendezvousEpoch(): string {
  return randomBytes(24).toString('base64url')
}

function parseAuthKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=\n?$/u.test(value)) throw new Error('External Chrome authentication key is malformed')
  const key = Buffer.from(value.trim(), 'base64')
  if (key.byteLength !== AUTH_KEY_BYTES) throw new Error('External Chrome authentication key must contain 256 bits')
  return new Uint8Array(key)
}

function authKeyId(key: Uint8Array): string {
  return `key-${createHash('sha256').update(key).digest('base64url').slice(0, 24)}`
}

async function atomicWrite(file: string, value: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: POSIX_PRIVATE_DIRECTORY_MODE })
  const temporary = `${file}.new-${randomUUID()}`
  const handle = await fs.open(temporary, 'wx', mode)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function isValidAuthority(value: AuthorityDocument): boolean {
  return value?.schemaVersion === 1
    && /^[A-Za-z0-9_-]{16,128}$/u.test(value.desktopInstanceId)
    && Number.isSafeInteger(value.desktopPid)
    && value.desktopPid > 0
    && Number.isFinite(Date.parse(value.expiresAt))
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
