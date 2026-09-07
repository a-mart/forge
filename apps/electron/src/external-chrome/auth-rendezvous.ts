import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
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
  dataDirHash: string
  expiresAt: string
}

export type PrivateFileVerification = 'secure' | 'insecure' | 'missing'

export interface CurrentUserAccessController {
  preparePrivateDirectory(directory: string): Promise<void>
  /** Establish and verify file privacy, optionally securing its containing directory in the same operation. */
  securePrivateFile(file: string, prepareDirectory?: boolean): Promise<void>
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

  async securePrivateFile(file: string, prepareDirectory = false): Promise<void> {
    if (prepareDirectory) await this.preparePrivateDirectory(path.dirname(file))
    await fs.chmod(file, POSIX_PRIVATE_FILE_MODE)
    if (await this.verifyPrivateFile(file) !== 'secure') {
      throw new Error('External Chrome private file permissions could not be verified; check folder ownership and retry Chrome setup')
    }
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
  constructor(private readonly runner: ExternalCommandRunner = new ProcessCommandRunner()) {}

  async preparePrivateDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true })
    await this.apply(directory, true)
  }

  async securePrivateFile(file: string, prepareDirectory = false): Promise<void> {
    await this.apply(file, false, prepareDirectory)
  }

  async verifyPrivateFile(file: string): Promise<PrivateFileVerification> {
    try {
      const info = await fs.lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) return 'insecure'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'insecure'
    }
    try {
      return await this.checkAccess(file, false, false) ? 'secure' : 'insecure'
    } catch {
      return 'insecure'
    }
  }

  private async apply(target: string, directory: boolean, prepareDirectory = false): Promise<void> {
    const info = await fs.lstat(target)
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error('External Chrome private path must not be a link or an unexpected file type')
    }
    try {
      if (await this.checkAccess(target, directory, true, prepareDirectory)) return
    } catch {
      // Do not surface command output or ACL/account details through setup IPC.
    }
    throw new Error('External Chrome could not establish private Windows permissions. Check folder ownership and Windows security policy, then retry Chrome setup.')
  }

  private async checkAccess(target: string, directory: boolean, apply: boolean, prepareDirectory = false): Promise<boolean> {
    // A private atomic write checks both directory and new inode in one process.
    // No cached ACL verdicts and no extra verifier subprocess on the refresh path.
    const targets = prepareDirectory ? [{ target: path.dirname(target), directory: true }, { target, directory }] : [{ target, directory }]
    const script = [
      "$ErrorActionPreference='Stop'",
      ...targets.flatMap(({ target, directory }) => this.accessScript(target, directory, apply)),
      "'secure'",
    ].join(';')
    const output = await this.runner.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    return output.trim() === 'secure'
  }

  private accessScript(target: string, directory: boolean, apply: boolean): string[] {
    const escaped = target.replaceAll("'", "''")
    const inheritance = directory ? 'ContainerInherit, ObjectInherit' : 'None'
    return [
      `$target='${escaped}'`,
      '$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      // Windows may assign Administrators as owner for an elevated creator.
      // These are the same privileged principals already trusted for read ACLs.
      "$allowed=@($me.Value,'S-1-5-18','S-1-5-32-544')",
      '$item=Get-Item -LiteralPath $target -Force',
      `if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $${directory}) { exit 3 }`,
      '$acl=Get-Acl -LiteralPath $target',
      'if ($allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 3 }',
      ...(apply ? [
        // Replace the DACL, not just the named user's ACE. /grant:r preserves
        // explicit logon/default-token grants and repeatedly fails verification.
        `$private=New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}`,
        '$private.SetAccessRuleProtection($true,$false)',
        `$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','${inheritance}','None','Allow')`,
        '$private.AddAccessRule($rule)',
        // Set-Acl persists all descriptor sections and can demand SeSecurityPrivilege
        // for the SACL. Persist only the modified DACL; ownership/auditing stay untouched.
        '$item.SetAccessControl($private)',
        '$acl=Get-Acl -LiteralPath $target',
      ] : []),
      '$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))',
      '$bad=@($rules | Where-Object { $_.AccessControlType -ne \'Allow\' -or $allowed -notcontains $_.IdentityReference.Value })',
      "$full=[System.Security.AccessControl.FileSystemRights]::FullControl",
      `$inherit=[System.Security.AccessControl.InheritanceFlags]'${inheritance}'`,
      '$mine=@($rules | Where-Object { $_.AccessControlType -eq \'Allow\' -and $_.IdentityReference.Value -eq $me.Value -and ($_.FileSystemRights -band $full) -eq $full -and $_.PropagationFlags -eq \'None\' -and ($_.InheritanceFlags -band $inherit) -eq $inherit })',
      "if (-not $acl.AreAccessRulesProtected -or $bad.Count -ne 0 -or $mine.Count -eq 0 -or $allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 3 }",
    ]
  }
}

export function createCurrentUserAccessController(platform: NodeJS.Platform): CurrentUserAccessController {
  return platform === 'win32'
    ? new WindowsCurrentUserAccessController()
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
    const key = randomBytes(AUTH_KEY_BYTES)
    try {
      await atomicPrivateWrite(this.paths.authKey, `${key.toString('base64')}\n`, this.access)
      return { key, keyId: authKeyId(key), created: true }
    } catch (error) {
      key.fill(0)
      throw error
    }
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
  private readonly dataDirHash: string

  constructor(
    dataRoot: string,
    platform: NodeJS.Platform,
    private readonly instanceId: string,
    private readonly pid: number,
    private readonly access: CurrentUserAccessController,
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
    private readonly now: () => number = Date.now,
    authorityPath?: string,
  ) {
    const paths = resolveExternalChromeDataPaths(dataRoot, platform)
    this.authorityPath = authorityPath ?? path.join(paths.run, 'authority.json')
    this.rendezvousPath = paths.rendezvous
    this.dataDirHash = dataDirectoryHash(dataRoot)
  }

  async inspect(): Promise<AuthorityClaim | { state: 'none' }> {
    const owner = await readJson<AuthorityDocument>(this.authorityPath)
    if (!owner) return { state: 'none' }
    if (owner.desktopInstanceId === this.instanceId && owner.desktopPid === this.pid) return { state: 'owned', owner }
    const live = isValidAuthority(owner) && Date.parse(owner.expiresAt) > this.now() && this.isProcessAlive(owner.desktopPid)
    return { state: live ? 'other-live' : 'stale', owner }
  }

  async claim(expiresAt: string): Promise<AuthorityClaim> {
    const document: AuthorityDocument = {
      schemaVersion: 1,
      desktopInstanceId: this.instanceId,
      desktopPid: this.pid,
      dataDirHash: this.dataDirHash,
      expiresAt,
    }
    let tookOver = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Publish a complete, verified inode without replacing another claimant.
        // ACL subprocesses run only against our unique temporary file. Failure
        // cleanup must never unlink the canonical path owned by a competitor.
        await atomicPrivateWrite(this.authorityPath, `${JSON.stringify(document)}\n`, this.access, false)
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
    await atomicPrivateWrite(this.authorityPath, `${JSON.stringify({
      schemaVersion: 1,
      desktopInstanceId: this.instanceId,
      desktopPid: this.pid,
      dataDirHash: this.dataDirHash,
      expiresAt,
    } satisfies AuthorityDocument)}\n`, this.access)
  }

  async publish(document: ExternalChromeRendezvousDocument): Promise<void> {
    if ((await this.inspect()).state !== 'owned') throw new Error('Cannot publish External Chrome rendezvous without authority')
    await atomicPrivateWrite(this.rendezvousPath, `${JSON.stringify(document)}\n`, this.access)
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

async function atomicPrivateWrite(file: string, value: string, access: CurrentUserAccessController, replace = true): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: POSIX_PRIVATE_DIRECTORY_MODE })
  const temporary = `${file}.new-${randomUUID()}`
  const handle = await fs.open(temporary, 'wx', POSIX_PRIVATE_FILE_MODE)
  try {
    try {
      // Establish and verify the new inode's ACL before writing any credential
      // bytes or publishing it. Rename does not preserve the old file's DACL.
      await access.securePrivateFile(temporary, true)
      await handle.writeFile(value)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (replace) await fs.rename(temporary, file)
    else await fs.link(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
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
    && /^[a-f0-9]{16}$/u.test(value.dataDirHash)
    && Number.isFinite(Date.parse(value.expiresAt))
}

export function dataDirectoryHash(dataRoot: string): string {
  return createHash('sha256').update(path.resolve(dataRoot)).digest('hex').slice(0, 16)
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
