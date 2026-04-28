/**
 * Settings > AI Roles panel.
 *
 * Manages collaboration AI role configurations. Builtin roles are read-only
 * with a "Clone" action; custom (cloned) roles are fully editable.
 *
 * Visible only under the Collab settings target — not shown for Builder.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Bot, Copy, Eye, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SettingsSection } from './settings-row'
import {
  AI_ROLE_OPTIONS,
  aiRoleLabel,
  type AiRoleConfig,
  type CollaborationAiRoleId,
} from '@/lib/collaboration-ai-roles'
import {
  cloneAiRole,
  createAiRole,
  deleteAiRole,
  fetchAiRolePromptPreview,
  fetchAiRoles,
  isAiRolesAuthError,
  updateAiRole,
  updateWorkspaceDefaultAiRole,
} from '@/lib/collaboration-ai-roles-api'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type LoadState = 'loading' | 'loaded' | 'error' | 'auth-error'
type DialogMode = 'clone' | 'create' | 'edit' | 'delete' | 'preview' | null

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function RoleCard({
  role,
  onClone,
  onEdit,
  onDelete,
  onPreview,
}: {
  role: AiRoleConfig
  onClone?: (role: AiRoleConfig) => void
  onEdit?: (role: AiRoleConfig) => void
  onDelete?: (role: AiRoleConfig) => void
  onPreview?: (role: AiRoleConfig) => void
}) {
  return (
    <div
      data-testid={`role-card-${role.roleId}`}
      className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card/50 px-4 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <Bot className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{role.name}</span>
          {role.builtin && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              Built-in
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{role.description}</p>
        {role.usage.inUse && (
          <span className="mt-0.5 text-[10px] text-muted-foreground/70">
            {role.usage.workspaceDefault ? 'Workspace default' : ''}
            {role.usage.workspaceDefault && role.usage.channelCount > 0 ? ' · ' : ''}
            {role.usage.channelCount > 0 ? `${role.usage.channelCount} channel${role.usage.channelCount > 1 ? 's' : ''}` : ''}
            {(role.usage.workspaceDefault || role.usage.channelCount > 0) && role.usage.categoryCount > 0 ? ' · ' : ''}
            {role.usage.categoryCount > 0 ? `${role.usage.categoryCount} categor${role.usage.categoryCount > 1 ? 'ies' : 'y'}` : ''}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPreview?.(role)}
          aria-label={`Preview ${role.name}`}
        >
          <Eye className="size-3" />
        </Button>
        {role.builtin ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => onClone?.(role)}
            aria-label={`Clone ${role.name}`}
          >
            <Copy className="size-3" />
            Clone
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onEdit?.(role)}
              aria-label={`Edit ${role.name}`}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete?.(role)}
              aria-label={`Delete ${role.name}`}
            >
              <Trash2 className="size-3" />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function RoleFormDialog({
  mode,
  sourceRole,
  roles,
  onSubmit,
  onCancel,
}: {
  mode: 'clone' | 'create' | 'edit'
  sourceRole: AiRoleConfig | null
  roles: AiRoleConfig[]
  onSubmit: (result: AiRoleConfig) => void
  onCancel: () => void
}) {
  const isEdit = mode === 'edit'
  const [roleId, setRoleId] = useState(isEdit ? sourceRole?.roleId ?? '' : '')
  const [name, setName] = useState(
    mode === 'clone'
      ? `${sourceRole?.name ?? ''} Copy`
      : sourceRole?.name ?? '',
  )
  const [description, setDescription] = useState(sourceRole?.description ?? '')
  const [prompt, setPrompt] = useState(sourceRole?.prompt ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmedRoleId = roleId.trim().replace(/\s+/g, '_').toLowerCase()
  const trimmedName = name.trim()
  const canSubmit = !isSaving && trimmedName.length > 0 && (isEdit || trimmedRoleId.length > 0) && prompt.trim().length > 0

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return

    setIsSaving(true)
    setError(null)
    try {
      let result: AiRoleConfig
      if (mode === 'clone' && sourceRole) {
        result = await cloneAiRole(sourceRole.roleId, {
          roleId: trimmedRoleId,
          name: trimmedName,
          description: description.trim() || null,
          prompt: prompt.trim(),
        })
      } else if (isEdit && sourceRole) {
        result = await updateAiRole(sourceRole.roleId, {
          name: trimmedName,
          description: description.trim() || null,
          prompt: prompt.trim(),
        })
      } else {
        result = await createAiRole({
          roleId: trimmedRoleId,
          name: trimmedName,
          description: description.trim() || null,
          prompt: prompt.trim(),
        })
      }
      onSubmit(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed')
    } finally {
      setIsSaving(false)
    }
  }

  // Check for duplicate roleIds for non-edit mode
  const isDuplicate = !isEdit && trimmedRoleId.length > 0 && roles.some((r) => r.roleId === trimmedRoleId)

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="role-form-dialog">
      <h3 className="mb-3 text-sm font-semibold">
        {mode === 'clone' ? 'Clone role' : isEdit ? 'Edit role' : 'Create role'}
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        {!isEdit && (
          <div className="space-y-1">
            <Label htmlFor="role-form-id">Role ID</Label>
            <Input
              id="role-form-id"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              placeholder="my_custom_role"
              disabled={isSaving}
              autoFocus
            />
            {isDuplicate && (
              <p className="text-xs text-destructive">A role with this ID already exists.</p>
            )}
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="role-form-name">Name</Label>
          <Input
            id="role-form-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Custom Role"
            disabled={isSaving}
            autoFocus={isEdit}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="role-form-description">Description</Label>
          <Input
            id="role-form-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this role does"
            disabled={isSaving}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="role-form-prompt">Prompt</Label>
          <Textarea
            id="role-form-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="System prompt instructions for this role..."
            className="min-h-32 resize-y"
            disabled={isSaving}
          />
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit || isDuplicate}>
            {isSaving ? 'Saving...' : isEdit ? 'Save changes' : mode === 'clone' ? 'Clone' : 'Create'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function DeleteConfirmation({
  role,
  roles,
  onConfirm,
  onCancel,
}: {
  role: AiRoleConfig
  roles: AiRoleConfig[]
  onConfirm: () => void
  onCancel: () => void
}) {
  const [replacementRoleId, setReplacementRoleId] = useState<CollaborationAiRoleId>('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const replacementOptions = roles.filter((r) => r.roleId !== role.roleId)
  const needsReplacement = role.usage.inUse

  const canDelete = !isDeleting && (!needsReplacement || replacementRoleId.length > 0)

  const handleConfirm = async () => {
    if (!canDelete) return
    setIsDeleting(true)
    setError(null)
    try {
      await deleteAiRole(role.roleId, replacementRoleId || undefined)
      onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete role')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4" data-testid="role-delete-confirm">
      <h3 className="mb-2 text-sm font-semibold">Delete &ldquo;{role.name}&rdquo;?</h3>
      {needsReplacement ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            This role is still in use ({role.usage.totalAssignments} assignment{role.usage.totalAssignments > 1 ? 's' : ''}).
            Choose a replacement role for existing assignments.
          </p>
          <div className="space-y-1">
            <Label htmlFor="delete-replacement-role">Replacement role</Label>
            <Select value={replacementRoleId} onValueChange={setReplacementRoleId}>
              <SelectTrigger id="delete-replacement-role" className="w-full">
                <SelectValue placeholder="Select replacement" />
              </SelectTrigger>
              <SelectContent>
                {replacementOptions.map((r) => (
                  <SelectItem key={r.roleId} value={r.roleId}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          This role is not assigned to any channels or categories and can be safely deleted.
        </p>
      )}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isDeleting}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={handleConfirm} disabled={!canDelete}>
          {isDeleting ? 'Deleting...' : 'Delete'}
        </Button>
      </div>
    </div>
  )
}

function PromptPreview({
  role,
  onClose,
}: {
  role: AiRoleConfig
  onClose: () => void
}) {
  const [promptBlock, setPromptBlock] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)
    void fetchAiRolePromptPreview(role.roleId)
      .then((data) => {
        if (!cancelled) {
          setPromptBlock(data.promptBlock)
          setIsLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load preview')
          setIsLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [role.roleId])

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="role-prompt-preview">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Prompt preview: {role.name}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} className="h-7 px-2 text-xs">
          Close
        </Button>
      </div>
      {isLoading && (
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading preview...</span>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {promptBlock != null && !isLoading && (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap">
          {promptBlock}
        </pre>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function SettingsAiRoles() {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [roles, setRoles] = useState<AiRoleConfig[]>([])
  const [workspaceDefaultRoleId, setWorkspaceDefaultRoleId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Dialog state
  const [dialogMode, setDialogMode] = useState<DialogMode>(null)
  const [dialogRole, setDialogRole] = useState<AiRoleConfig | null>(null)

  // Workspace default saving
  const [isSavingDefault, setIsSavingDefault] = useState(false)

  const loadRoles = useCallback(async () => {
    setLoadState('loading')
    setError(null)
    try {
      const data = await fetchAiRoles()
      setRoles(data.roles)
      setWorkspaceDefaultRoleId(data.workspaceDefaultAiRoleId)
      setLoadState('loaded')
    } catch (err) {
      if (isAiRolesAuthError(err)) {
        setLoadState('auth-error')
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load AI roles')
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    void loadRoles()
  }, [loadRoles])

  const builtinRoles = roles.filter((r) => r.builtin)
  const customRoles = roles.filter((r) => !r.builtin)

  const handleClone = useCallback((role: AiRoleConfig) => {
    setDialogMode('clone')
    setDialogRole(role)
  }, [])

  const handleEdit = useCallback((role: AiRoleConfig) => {
    setDialogMode('edit')
    setDialogRole(role)
  }, [])

  const handleDelete = useCallback((role: AiRoleConfig) => {
    setDialogMode('delete')
    setDialogRole(role)
  }, [])

  const handlePreview = useCallback((role: AiRoleConfig) => {
    setDialogMode('preview')
    setDialogRole(role)
  }, [])

  const handleCreate = useCallback(() => {
    setDialogMode('create')
    setDialogRole(null)
  }, [])

  const handleDialogClose = useCallback(() => {
    setDialogMode(null)
    setDialogRole(null)
  }, [])

  const handleFormSubmit = useCallback((_result: AiRoleConfig) => {
    handleDialogClose()
    void loadRoles()
  }, [handleDialogClose, loadRoles])

  const handleDeleteConfirm = useCallback(() => {
    handleDialogClose()
    void loadRoles()
  }, [handleDialogClose, loadRoles])

  const handleWorkspaceDefaultChange = useCallback(async (newRoleId: string) => {
    setIsSavingDefault(true)
    try {
      const result = await updateWorkspaceDefaultAiRole(newRoleId)
      setWorkspaceDefaultRoleId(result.workspaceDefaultAiRoleId)
      // Refresh to get updated usage summaries
      void loadRoles()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update workspace default')
    } finally {
      setIsSavingDefault(false)
    }
  }, [loadRoles])

  /** All roles as selectable options for workspace default / replacement selectors. */
  const allRoleOptions = roles.map((r) => ({ value: r.roleId, label: r.name }))

  return (
    <div className="flex flex-col gap-8">
      {/* Workspace default */}
      <SettingsSection
        label="Workspace Default"
        description="The default AI role for new channels when no category default is set."
      >
        {loadState === 'loaded' && (
          <div className="space-y-2">
            <Select
              value={workspaceDefaultRoleId}
              onValueChange={(value) => void handleWorkspaceDefaultChange(value)}
              disabled={isSavingDefault}
            >
              <SelectTrigger className="w-full max-w-sm" data-testid="workspace-default-role-selector">
                <SelectValue placeholder="Select default role">{aiRoleLabel(workspaceDefaultRoleId)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {allRoleOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground/70">
              Category defaults take precedence for channels within a category.
            </p>
          </div>
        )}

        {loadState !== 'loaded' && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Load AI roles to configure the workspace default.
          </p>
        )}
      </SettingsSection>

      {/* Built-in roles */}
      <SettingsSection
        label="Built-in Roles"
        description="Shipped AI role presets. These cannot be modified directly — clone to create a customised variant."
      >
        {loadState === 'loading' && (
          <div className="flex items-center gap-2 px-2 py-6" data-testid="ai-roles-loading">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading AI roles...</span>
          </div>
        )}

        {loadState === 'auth-error' && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="ai-roles-auth-error"
          >
            Authentication required. Sign in to the collaboration server to manage AI roles.
          </div>
        )}

        {loadState === 'error' && (
          <div className="flex items-center gap-2 px-2 py-3" data-testid="ai-roles-error">
            <span className="text-sm text-destructive">{error}</span>
            <button
              type="button"
              onClick={() => void loadRoles()}
              className="text-xs text-primary underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {loadState === 'loaded' && builtinRoles.length === 0 && (
          /* Fallback: render static cards from AI_ROLE_OPTIONS when the API
             returns no builtins (e.g. endpoint not yet implemented). */
          <div className="flex flex-col gap-2">
            {AI_ROLE_OPTIONS.map((opt) => (
              <RoleCard
                key={opt.value}
                role={{
                  roleId: opt.value,
                  name: opt.label,
                  description: opt.description,
                  prompt: '',
                  builtin: true,
                  usage: { workspaceDefault: false, categoryCount: 0, channelCount: 0, totalAssignments: 0, inUse: false },
                }}
                onClone={handleClone}
                onPreview={handlePreview}
              />
            ))}
          </div>
        )}

        {loadState === 'loaded' && builtinRoles.length > 0 && (
          <div className="flex flex-col gap-2">
            {builtinRoles.map((role) => (
              <RoleCard key={role.roleId} role={role} onClone={handleClone} onPreview={handlePreview} />
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Custom roles */}
      <SettingsSection
        label="Custom Roles"
        description="User-created roles cloned from builtins or created from scratch. Fully editable."
      >
        {loadState === 'loaded' && customRoles.length === 0 && (
          <p className="px-2 py-3 text-sm text-muted-foreground" data-testid="no-custom-roles">
            No custom roles yet. Clone a built-in role or create one from scratch.
          </p>
        )}

        {loadState === 'loaded' && customRoles.length > 0 && (
          <div className="flex flex-col gap-2">
            {customRoles.map((role) => (
              <RoleCard
                key={role.roleId}
                role={role}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onPreview={handlePreview}
              />
            ))}
          </div>
        )}

        {loadState === 'loaded' && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 gap-1.5"
            onClick={handleCreate}
            data-testid="create-role-button"
          >
            <Plus className="size-3" />
            Create role
          </Button>
        )}

        {loadState !== 'loaded' && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Custom roles will appear here once AI role data is loaded.
          </p>
        )}
      </SettingsSection>

      {/* Inline form / confirmation dialogs */}
      {(dialogMode === 'clone' || dialogMode === 'create' || dialogMode === 'edit') && (
        <RoleFormDialog
          mode={dialogMode}
          sourceRole={dialogRole}
          roles={roles}
          onSubmit={handleFormSubmit}
          onCancel={handleDialogClose}
        />
      )}

      {dialogMode === 'delete' && dialogRole && (
        <DeleteConfirmation
          role={dialogRole}
          roles={roles}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDialogClose}
        />
      )}

      {dialogMode === 'preview' && dialogRole && (
        <PromptPreview
          role={dialogRole}
          onClose={handleDialogClose}
        />
      )}
    </div>
  )
}
