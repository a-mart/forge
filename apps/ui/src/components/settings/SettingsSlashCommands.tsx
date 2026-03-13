import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSection } from './settings-row'
import {
  fetchSlashCommands,
  createSlashCommand,
  updateSlashCommand,
  deleteSlashCommand,
  type SlashCommand,
} from './slash-commands-api'
import type { AgentDescriptor, ManagerProfile } from '@middleman/protocol'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function resolveManagerId(managers: AgentDescriptor[], profiles: ManagerProfile[]): string | null {
  // Prefer the profile's defaultSessionAgentId if available
  if (profiles.length > 0) {
    const profile = profiles[0]
    if (profile?.defaultSessionAgentId) return profile.defaultSessionAgentId
  }
  // Fallback to first manager agentId
  const manager = managers.find((m) => m.role === 'manager')
  return manager?.agentId ?? null
}

/* ------------------------------------------------------------------ */
/*  Command row                                                       */
/* ------------------------------------------------------------------ */

function CommandRow({
  command,
  onEdit,
  onDelete,
  isDeleting,
}: {
  command: SlashCommand
  onEdit: () => void
  onDelete: () => void
  isDeleting: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="text-[13px] font-semibold text-foreground">/{command.name}</code>
          </div>
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {command.prompt}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onEdit}
            disabled={isDeleting}
            aria-label={`Edit /${command.name}`}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label={`Delete /${command.name}`}
          >
            {isDeleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline form                                                       */
/* ------------------------------------------------------------------ */

function CommandForm({
  initialName,
  initialPrompt,
  onSave,
  onCancel,
  isSaving,
  isEditing,
}: {
  initialName: string
  initialPrompt: string
  onSave: (name: string, prompt: string) => void
  onCancel: () => void
  isSaving: boolean
  isEditing: boolean
}) {
  const [name, setName] = useState(initialName)
  const [prompt, setPrompt] = useState(initialPrompt)

  const canSave = name.trim().length > 0 && prompt.trim().length > 0

  return (
    <div className="rounded-lg border border-primary/30 bg-card/50 p-4">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="slash-cmd-name" className="text-xs font-medium text-muted-foreground">
            Command name
          </Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              /
            </span>
            <Input
              id="slash-cmd-name"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s/g, '-').toLowerCase())}
              placeholder="command-name"
              className="pl-7 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
              disabled={isSaving}
              autoFocus
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="slash-cmd-prompt" className="text-xs font-medium text-muted-foreground">
            Prompt text
          </Label>
          <Textarea
            id="slash-cmd-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter the prompt text that will be inserted when this command is selected..."
            className="min-h-[80px] text-xs"
            disabled={isSaving}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isSaving}
            className="gap-1.5"
          >
            <X className="size-3.5" />
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onSave(name.trim(), prompt.trim())}
            disabled={!canSave || isSaving}
            className="gap-1.5"
          >
            {isSaving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {isSaving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

interface SettingsSlashCommandsProps {
  wsUrl: string
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
}

export function SettingsSlashCommands({ wsUrl, managers, profiles }: SettingsSlashCommandsProps) {
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingCommand, setEditingCommand] = useState<SlashCommand | null>(null)

  const managerId = resolveManagerId(managers, profiles)

  const loadCommands = useCallback(async () => {
    if (!managerId) return
    setIsLoading(true)
    setError(null)
    try {
      const result = await fetchSlashCommands(wsUrl, managerId)
      setCommands(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load slash commands')
    } finally {
      setIsLoading(false)
    }
  }, [wsUrl, managerId])

  useEffect(() => {
    void loadCommands()
  }, [loadCommands])

  const handleCreate = async (name: string, prompt: string) => {
    if (!managerId) return
    setError(null)
    setSuccess(null)
    setIsSaving(true)
    try {
      await createSlashCommand(wsUrl, managerId, { name, prompt })
      setSuccess(`/${name} created.`)
      setShowForm(false)
      await loadCommands()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create command')
    } finally {
      setIsSaving(false)
    }
  }

  const handleUpdate = async (name: string, prompt: string) => {
    if (!managerId || !editingCommand) return
    setError(null)
    setSuccess(null)
    setIsSaving(true)
    try {
      await updateSlashCommand(wsUrl, managerId, editingCommand.id, { name, prompt })
      setSuccess(`/${name} updated.`)
      setEditingCommand(null)
      await loadCommands()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update command')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (command: SlashCommand) => {
    if (!managerId) return
    setError(null)
    setSuccess(null)
    setDeletingId(command.id)
    try {
      await deleteSlashCommand(wsUrl, managerId, command.id)
      setSuccess(`/${command.name} deleted.`)
      await loadCommands()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete command')
    } finally {
      setDeletingId(null)
    }
  }

  const handleStartEdit = (command: SlashCommand) => {
    setShowForm(false)
    setEditingCommand(command)
    setError(null)
    setSuccess(null)
  }

  const handleStartCreate = () => {
    setEditingCommand(null)
    setShowForm(true)
    setError(null)
    setSuccess(null)
  }

  const handleCancelForm = () => {
    setShowForm(false)
    setEditingCommand(null)
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Slash Commands"
        description={
          !isLoading && commands.length > 0
            ? `${commands.length} command${commands.length === 1 ? '' : 's'} configured`
            : 'Saved prompts accessible with / in the chat input'
        }
        cta={
          !showForm && !editingCommand ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleStartCreate}
              disabled={!managerId}
              className="gap-1.5"
            >
              <Plus className="size-3.5" />
              Add Command
            </Button>
          ) : undefined
        }
      >
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        ) : null}

        {success ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
          </div>
        ) : null}

        {!managerId ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <Terminal className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No manager available</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Create a manager to configure slash commands.
            </p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3">
            {showForm ? (
              <CommandForm
                initialName=""
                initialPrompt=""
                onSave={handleCreate}
                onCancel={handleCancelForm}
                isSaving={isSaving}
                isEditing={false}
              />
            ) : null}

            {commands.length === 0 && !showForm ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
                <Terminal className="mb-2 size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No slash commands yet</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Add a command to create a saved prompt accessible with / in the chat input.
                </p>
              </div>
            ) : (
              commands.map((command) =>
                editingCommand?.id === command.id ? (
                  <CommandForm
                    key={command.id}
                    initialName={command.name}
                    initialPrompt={command.prompt}
                    onSave={handleUpdate}
                    onCancel={handleCancelForm}
                    isSaving={isSaving}
                    isEditing
                  />
                ) : (
                  <CommandRow
                    key={command.id}
                    command={command}
                    onEdit={() => handleStartEdit(command)}
                    onDelete={() => void handleDelete(command)}
                    isDeleting={deletingId === command.id}
                  />
                ),
              )
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
