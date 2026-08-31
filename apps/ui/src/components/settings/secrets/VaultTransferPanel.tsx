import { useRef, useState } from 'react'
import { Check, Copy, Download, Loader2, Upload } from 'lucide-react'
import {
  SECURE_VAULT_TRANSFER_FORMAT,
  SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES,
  type SecureVaultTransferBundle,
} from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SettingsApiClient } from '../settings-api-client'
import {
  SecureSecretsError,
  exportSecureVaultTransfer,
  importSecureVaultTransfer,
} from '@/lib/secure-secrets-api'

interface VaultTransferPanelProps {
  apiClient: SettingsApiClient
  available: boolean
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

const MAX_TRANSFER_FILE_BYTES = Math.ceil(
  SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES / 3,
) * 4 + 4_096

export function VaultTransferPanel({
  apiClient,
  available,
  onChanged,
  onError,
}: VaultTransferPanelProps) {
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [exportedCode, setExportedCode] = useState<string | null>(null)
  const [exportedItemCount, setExportedItemCount] = useState(0)
  const [copied, setCopied] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importCode, setImportCode] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const exportTransfer = async () => {
    const confirmed = typeof window === 'undefined' || window.confirm(
      'Create an encrypted transfer file for another machine? Anyone with both the file and transfer code can import these credentials.',
    )
    if (!confirmed) return

    setBusy('export')
    setCopied(false)
    setExportedCode(null)
    try {
      const result = await exportSecureVaultTransfer(apiClient)
      downloadBundle(result.bundle)
      setExportedCode(result.transferCode)
      setExportedItemCount(
        result.localSecretCount + result.providerCredentialCount,
      )
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  const copyTransferCode = async () => {
    if (!exportedCode) return
    try {
      await navigator.clipboard.writeText(exportedCode)
      setCopied(true)
    } catch (error) {
      onError(error)
    }
  }

  const importTransfer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fileForSubmission = importFile
    const codeForSubmission = importCode.trim()
    setImportCode('')
    setImportFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!fileForSubmission || !codeForSubmission) {
      onError(new SecureSecretsError('SECURE_VAULT_TRANSFER_INVALID'))
      return
    }
    const confirmed = typeof window === 'undefined' || window.confirm(
      'Import this transfer into the copied Forge data on this machine? Existing machine-bound ciphertext will be replaced only when every record matches.',
    )
    if (!confirmed) return

    setBusy('import')
    try {
      if (fileForSubmission.size > MAX_TRANSFER_FILE_BYTES) {
        throw new SecureSecretsError('SECURE_VAULT_TRANSFER_INVALID')
      }
      const bundle = parseBundleFile(await readFileAsText(fileForSubmission))
      const result = await importSecureVaultTransfer(apiClient, {
        bundle,
        transferCode: codeForSubmission,
      })
      await onChanged(
        `${result.importedItemCount} vault ${
          result.importedItemCount === 1 ? 'item was' : 'items were'
        } transferred to this machine. Test the affected sources, then delete the transfer file and code.`,
      )
    } catch (error) {
      onError(error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="rounded-md border border-border/70 bg-card/40">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Move vault to another machine
      </summary>
      <div className="space-y-4 border-t border-border/70 p-4">
        <p className="text-xs text-muted-foreground">
          Export here, then quit Forge and copy the normal Forge data directory without
          changing the vault. This encrypted file re-seals saved local values and connected
          source credentials for the destination machine.
        </p>

        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!available || busy !== null}
            onClick={() => void exportTransfer()}
          >
            {busy === 'export'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Download className="size-3.5" />}
            Export transfer file
          </Button>
          {exportedCode ? (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-muted-foreground">
                The file contains {exportedItemCount} encrypted vault
                {' '}
                {exportedItemCount === 1 ? 'item' : 'items'}. Keep this code separate from
                the file and paste it during import. It is not stored by Forge.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label="Exported vault transfer code"
                  value={exportedCode}
                  readOnly
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => void copyTransferCode()}
                >
                  {copied
                    ? <Check className="size-3.5" />
                    : <Copy className="size-3.5" />}
                  {copied ? 'Copied' : 'Copy code'}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setExportedCode(null)
                    setExportedItemCount(0)
                    setCopied(false)
                  }}
                >
                  Hide code
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <form className="space-y-3 border-t border-border/70 pt-4" onSubmit={importTransfer}>
          <div className="space-y-1.5">
            <label htmlFor="vault-transfer-file" className="text-xs font-medium">
              Transfer file
            </label>
            <Input
              ref={fileInputRef}
              id="vault-transfer-file"
              type="file"
              accept=".forge-vault-transfer,application/json"
              disabled={!available || busy !== null}
              onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="vault-transfer-code" className="text-xs font-medium">
              Transfer code
            </label>
            <Input
              id="vault-transfer-code"
              type="password"
              autoComplete="off"
              value={importCode}
              disabled={!available || busy !== null}
              onChange={(event) => setImportCode(event.target.value)}
              placeholder="Paste the code from the old machine"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={
              !available
              || busy !== null
              || !importFile
              || !importCode.trim()
            }
          >
            {busy === 'import'
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Upload className="size-3.5" />}
            Import transfer file
          </Button>
        </form>
      </div>
    </details>
  )
}

function parseBundleFile(contents: string): SecureVaultTransferBundle {
  try {
    const parsed = JSON.parse(contents) as { format?: unknown }
    if (parsed?.format !== SECURE_VAULT_TRANSFER_FORMAT) {
      throw new Error('invalid format')
    }
    return parsed as SecureVaultTransferBundle
  } catch {
    throw new SecureSecretsError('SECURE_VAULT_TRANSFER_INVALID')
  }
}

async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  })
}

function downloadBundle(bundle: SecureVaultTransferBundle): void {
  const blob = new Blob([`${JSON.stringify(bundle)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const date = bundle.createdAt.slice(0, 10)
  anchor.href = url
  anchor.download = `forge-vault-transfer-${date}.forge-vault-transfer`
  anchor.click()
  URL.revokeObjectURL(url)
}
