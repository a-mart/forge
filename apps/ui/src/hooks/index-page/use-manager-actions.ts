import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { seedProjectResources } from '@/components/file-browser/use-file-browser-queries'
import { fetchRepositorySettings } from '@/components/settings/repository-settings-api'
import type { CreateProjectSourceMode } from '@/components/chat/CreateManagerDialog'
import { deriveRepositoryFolderFromUrl } from '@/lib/repository-project-helpers'
import { ManagerWsClient } from '@/lib/ws-client'
import type { ManagerWsState } from '@/lib/ws-state'
import type {
  AgentDescriptor,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  RepositoryProjectCreationStage,
} from '@forge/protocol'
import type { AppRouteState } from './use-route-state'
import { DEFAULT_MANAGER_AGENT_ID } from './use-route-state'

interface UseManagerActionsOptions {
  wsUrl: string
  clientRef: MutableRefObject<ManagerWsClient | null>
  agents: AgentDescriptor[]
  activeAgent: AgentDescriptor | null
  activeAgentId: string | null
  isActiveManager: boolean
  navigateToRoute: (nextRouteState: AppRouteState, replace?: boolean) => void
  setState: Dispatch<SetStateAction<ManagerWsState>>
  clearPendingResponseForAgent: (agentId: string) => void
}

export function useManagerActions({
  wsUrl,
  clientRef,
  agents,
  activeAgent,
  activeAgentId,
  isActiveManager,
  navigateToRoute,
  setState,
  clearPendingResponseForAgent,
}: UseManagerActionsOptions): {
  isCreateManagerDialogOpen: boolean
  newManagerName: string
  newManagerCwd: string
  newManagerModelSelection: ManagerExactModelSelection | undefined
  newManagerReasoningLevel: ManagerReasoningLevel | undefined
  createManagerError: string | null
  browseError: string | null
  isCreatingManager: boolean
  isValidatingDirectory: boolean
  isPickingDirectory: boolean
  scaffoldForgeResources: boolean
  handleNewManagerNameChange: (value: string) => void
  handleNewManagerCwdChange: (value: string) => void
  handleNewManagerModelSelectionChange: (value: ManagerExactModelSelection) => void
  handleNewManagerReasoningLevelChange: (value: ManagerReasoningLevel) => void
  handleScaffoldForgeResourcesChange: (checked: boolean) => void
  handleOpenCreateManagerDialog: () => void
  handleCreateManagerDialogOpenChange: (open: boolean) => void
  handleBrowseDirectory: () => Promise<void>
  handleCreateManager: (event: FormEvent<HTMLFormElement>) => Promise<void>
  createProjectSourceMode: CreateProjectSourceMode
  repositoryUrl: string
  repositoryFolder: string
  repositoryBasePath: string
  cloneStage: RepositoryProjectCreationStage | null
  clonePercent: number | null
  cloneCancellable: boolean
  isCancellingClone: boolean
  handleCreateProjectSourceModeChange: (mode: CreateProjectSourceMode) => void
  handleRepositoryUrlChange: (value: string) => void
  handleRepositoryFolderChange: (value: string) => void
  handleRepositoryBasePathChange: (value: string) => void
  handleBrowseRepositoryBasePath: () => Promise<void>
  handleCancelClone: () => Promise<void>
  managerToDelete: AgentDescriptor | null
  deleteManagerError: string | null
  isDeletingManager: boolean
  handleRequestDeleteManager: (managerId: string) => void
  handleConfirmDeleteManager: () => Promise<void>
  handleCloseDeleteManagerDialog: () => void
  isCompactingManager: boolean
  handleCompactManager: (customInstructions?: string) => Promise<void>
  isSmartCompactingManager: boolean
  handleSmartCompactManager: () => Promise<void>
  isStoppingAllAgents: boolean
  handleStopAllAgents: () => Promise<void>
} {
  const [isCreateManagerDialogOpen, setIsCreateManagerDialogOpen] = useState(false)
  const [newManagerName, setNewManagerName] = useState('')
  const [newManagerCwd, setNewManagerCwd] = useState('')
  const [newManagerModelSelection, setNewManagerModelSelection] = useState<ManagerExactModelSelection | undefined>(undefined)
  const [newManagerReasoningLevel, setNewManagerReasoningLevel] = useState<ManagerReasoningLevel | undefined>(undefined)
  const [createManagerError, setCreateManagerError] = useState<string | null>(null)
  const [scaffoldForgeResources, setScaffoldForgeResources] = useState(true)
  const [isCreatingManager, setIsCreatingManager] = useState(false)
  const [isValidatingDirectory, setIsValidatingDirectory] = useState(false)

  const [browseError, setBrowseError] = useState<string | null>(null)
  const [isPickingDirectory, setIsPickingDirectory] = useState(false)

  const [createProjectSourceMode, setCreateProjectSourceMode] = useState<CreateProjectSourceMode>('local_folder')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [repositoryFolder, setRepositoryFolder] = useState('')
  const [repositoryBasePath, setRepositoryBasePath] = useState('')
  const [folderTouched, setFolderTouched] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [cloneStage, setCloneStage] = useState<RepositoryProjectCreationStage | null>(null)
  const [clonePercent, setClonePercent] = useState<number | null>(null)
  const [cloneCancellable, setCloneCancellable] = useState(false)
  const [isCancellingClone, setIsCancellingClone] = useState(false)
  const basePathTouchedRef = useRef(false)
  const settingsLoadGenerationRef = useRef(0)
  const activeCloneRequestIdRef = useRef<string | null>(null)
  const activeCloneCancelRef = useRef<(() => Promise<{ accepted: boolean; tooLate: boolean }>) | null>(null)

  const [managerToDelete, setManagerToDelete] = useState<AgentDescriptor | null>(null)
  const [deleteManagerError, setDeleteManagerError] = useState<string | null>(null)
  const [isDeletingManager, setIsDeletingManager] = useState(false)

  const [compactingAgentId, setCompactingAgentId] = useState<string | null>(null)
  const [smartCompactingAgentId, setSmartCompactingAgentId] = useState<string | null>(null)
  const [isStoppingAllAgents, setIsStoppingAllAgents] = useState(false)

  // Only report compaction in-progress when viewing the session that triggered it
  const isCompactingManager = compactingAgentId !== null && compactingAgentId === activeAgentId
  const isSmartCompactingManager = smartCompactingAgentId !== null && smartCompactingAgentId === activeAgentId

  const handleNewManagerNameChange = useCallback((value: string) => {
    setNameTouched(true)
    setNewManagerName(value)
  }, [])

  const handleNewManagerCwdChange = useCallback((value: string) => {
    setNewManagerCwd(value)
    setCreateManagerError(null)
  }, [])

  const handleCreateProjectSourceModeChange = useCallback((mode: CreateProjectSourceMode) => {
    setCreateProjectSourceMode(mode)
    setCreateManagerError(null)
    setBrowseError(null)
  }, [])

  const handleRepositoryUrlChange = useCallback((value: string) => {
    setRepositoryUrl(value)
    setCreateManagerError(null)
    const derived = deriveRepositoryFolderFromUrl(value)
    if (derived && !folderTouched) {
      setRepositoryFolder(derived)
    }
    if (derived && !nameTouched) {
      setNewManagerName(derived)
    }
  }, [folderTouched, nameTouched])

  const handleRepositoryFolderChange = useCallback((value: string) => {
    setFolderTouched(true)
    setRepositoryFolder(value)
    setCreateManagerError(null)
  }, [])

  const handleRepositoryBasePathChange = useCallback((value: string) => {
    basePathTouchedRef.current = true
    setRepositoryBasePath(value)
    setCreateManagerError(null)
  }, [])

  const resetCloneFields = useCallback(() => {
    setCreateProjectSourceMode('local_folder')
    setRepositoryUrl('')
    setRepositoryFolder('')
    setRepositoryBasePath('')
    setFolderTouched(false)
    setNameTouched(false)
    basePathTouchedRef.current = false
    setCloneStage(null)
    setClonePercent(null)
    setCloneCancellable(false)
    setIsCancellingClone(false)
    activeCloneRequestIdRef.current = null
    activeCloneCancelRef.current = null
    settingsLoadGenerationRef.current += 1
  }, [])

  const handleNewManagerModelSelectionChange = useCallback((value: ManagerExactModelSelection) => {
    setNewManagerModelSelection(value)
    setCreateManagerError(null)
  }, [])

  const handleNewManagerReasoningLevelChange = useCallback((value: ManagerReasoningLevel) => {
    setNewManagerReasoningLevel(value)
    setCreateManagerError(null)
  }, [])

  const handleScaffoldForgeResourcesChange = useCallback((checked: boolean) => {
    setScaffoldForgeResources(checked)
  }, [])

  const handleCompactManager = useCallback(async (customInstructions?: string) => {
    if (!isActiveManager || !activeAgentId) {
      return
    }

    setCompactingAgentId(activeAgentId)

    try {
      await requestManagerCompaction(wsUrl, activeAgentId, customInstructions)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to compact manager context: ${toErrorMessage(error)}`,
      }))
    } finally {
      setCompactingAgentId(null)
    }
  }, [activeAgentId, isActiveManager, setState, wsUrl])

  const handleSmartCompactManager = useCallback(async () => {
    if (!isActiveManager || !activeAgentId) {
      return
    }

    setSmartCompactingAgentId(activeAgentId)

    try {
      await requestManagerSmartCompaction(wsUrl, activeAgentId)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to smart compact manager context: ${toErrorMessage(error)}`,
      }))
    } finally {
      setSmartCompactingAgentId(null)
    }
  }, [activeAgentId, isActiveManager, setState, wsUrl])

  const handleStopAllAgents = useCallback(async () => {
    const client = clientRef.current
    if (!client || activeAgent?.role !== 'manager') {
      return
    }

    setIsStoppingAllAgents(true)

    try {
      await client.stopAllAgents(activeAgent.agentId)
      clearPendingResponseForAgent(activeAgent.agentId)
      setState((previous) => ({
        ...previous,
        lastError: null,
      }))
    } catch (error) {
      setState((previous) => ({
        ...previous,
        lastError: `Failed to stop manager and workers: ${toErrorMessage(error)}`,
      }))
    } finally {
      setIsStoppingAllAgents(false)
    }
  }, [activeAgent, clearPendingResponseForAgent, clientRef, setState])

  const handleOpenCreateManagerDialog = useCallback(() => {
    const defaultCwd =
      activeAgent?.cwd ??
      agents.find((agent) => agent.role === 'manager')?.cwd ??
      ''

    setNewManagerName('')
    setNewManagerCwd(defaultCwd)
    setNewManagerModelSelection(undefined)
    setNewManagerReasoningLevel(undefined)
    setScaffoldForgeResources(true)
    setBrowseError(null)
    setCreateManagerError(null)
    resetCloneFields()
    setIsCreateManagerDialogOpen(true)

    const generation = ++settingsLoadGenerationRef.current
    void fetchRepositorySettings(wsUrl)
      .then((settings) => {
        if (settingsLoadGenerationRef.current !== generation) return
        if (basePathTouchedRef.current) return
        setRepositoryBasePath(settings.effectiveBasePath)
      })
      .catch(() => {
        // Non-blocking: user can still type a base path.
      })
  }, [activeAgent, agents, resetCloneFields, wsUrl])

  const handleCreateManagerDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // Never silently background an active clone / cancel / local create.
      if (isCreatingManager || isCancellingClone) {
        return
      }
    }

    setIsCreateManagerDialogOpen(open)
  }, [isCancellingClone, isCreatingManager])

  const handleBrowseDirectory = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await client.pickDirectory(newManagerCwd)
      if (!pickedPath) {
        return
      }

      setNewManagerCwd(pickedPath)
      setCreateManagerError(null)
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsPickingDirectory(false)
    }
  }, [clientRef, newManagerCwd])

  const handleBrowseRepositoryBasePath = useCallback(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }

    setBrowseError(null)
    setIsPickingDirectory(true)

    try {
      const pickedPath = await client.pickDirectory(repositoryBasePath)
      if (!pickedPath) {
        return
      }

      basePathTouchedRef.current = true
      setRepositoryBasePath(pickedPath)
      setCreateManagerError(null)
    } catch (error) {
      setBrowseError(toErrorMessage(error))
    } finally {
      setIsPickingDirectory(false)
    }
  }, [clientRef, repositoryBasePath])

  const handleCancelClone = useCallback(async () => {
    const cancel = activeCloneCancelRef.current
    if (!cancel || isCancellingClone) {
      return
    }
    setIsCancellingClone(true)
    setCloneCancellable(false)
    setCreateManagerError(null)
    try {
      const result = await cancel()
      if (!result.accepted) {
        // Clear cancelling immediately on ack error / accepted:false / tooLate.
        setIsCancellingClone(false)
        if (result.tooLate) {
          setCreateManagerError(
            'Cancellation was too late — the repository was already published. This dialog stays open while Forge finishes creating the project.',
          )
        }
      }
      // accepted:true — keep Cancelling until the create operation settles.
    } catch (error) {
      setIsCancellingClone(false)
      setCreateManagerError(toErrorMessage(error))
    }
  }, [isCancellingClone])

  const handleCreateManager = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const client = clientRef.current
    if (!client) {
      return
    }

    const name = newManagerName.trim()

    if (!name) {
      setCreateManagerError('Manager name is required.')
      return
    }

    if (!newManagerModelSelection) {
      setCreateManagerError('A model must be selected.')
      return
    }

    if (createProjectSourceMode === 'clone_repository') {
      const url = repositoryUrl.trim()
      const folder = repositoryFolder.trim()
      const basePath = repositoryBasePath.trim()

      if (!url) {
        setCreateManagerError('Repository URL is required.')
        return
      }
      if (!folder) {
        setCreateManagerError('Repository folder is required.')
        return
      }
      if (!basePath) {
        setCreateManagerError('Destination base path is required.')
        return
      }

      setCreateManagerError(null)
      setIsCreatingManager(true)
      setCloneStage('validating')
      setClonePercent(null)
      setCloneCancellable(true)

      try {
        const operation = client.createRepositoryProject(
          {
            name,
            repositoryUrl: url,
            repositoryBasePath: basePath,
            repositoryFolder: folder,
            modelSelection: newManagerModelSelection,
            reasoningLevel: newManagerReasoningLevel,
          },
          {
            onProgress: (progress) => {
              setCloneStage(progress.stage)
              setClonePercent(progress.percent ?? null)
              setCloneCancellable(progress.stage === 'validating' || progress.stage === 'cloning')
            },
          },
        )

        activeCloneRequestIdRef.current = operation.requestId
        activeCloneCancelRef.current = operation.cancel

        const result = await operation.promise
        const manager = result.manager

        navigateToRoute({ view: 'chat', agentId: manager.agentId, surface: 'builder' })
        client.subscribeToAgent(manager.agentId, { reason: 'create' })

        if (scaffoldForgeResources) {
          const profileId = manager.profileId ?? manager.agentId
          seedProjectResources(wsUrl, { profileId, sessionAgentId: manager.agentId }).catch((err) => {
            console.warn('Failed to seed .forge project resources:', err)
          })
        }

        setIsCreateManagerDialogOpen(false)
        setNewManagerName('')
        setNewManagerCwd('')
        setNewManagerModelSelection(undefined)
        setNewManagerReasoningLevel(undefined)
        setScaffoldForgeResources(true)
        setBrowseError(null)
        setCreateManagerError(null)
        resetCloneFields()
      } catch (error) {
        const message = toErrorMessage(error)
        if (/clone_cancelled/i.test(message) || /cancelled/i.test(message)) {
          setCreateManagerError(null)
        } else {
          setCreateManagerError(message.replace(/^[A-Z0-9_]+:\s*/i, ''))
        }
      } finally {
        setIsCreatingManager(false)
        setIsCancellingClone(false)
        setCloneStage(null)
        setClonePercent(null)
        setCloneCancellable(false)
        activeCloneRequestIdRef.current = null
        activeCloneCancelRef.current = null
      }
      return
    }

    const cwd = newManagerCwd.trim()

    if (!cwd) {
      setCreateManagerError('Manager working directory is required.')
      return
    }

    setCreateManagerError(null)
    setIsCreatingManager(true)

    try {
      setIsValidatingDirectory(true)
      const validation = await client.validateDirectory(cwd)
      setIsValidatingDirectory(false)

      if (!validation.valid) {
        setCreateManagerError(validation.message ?? 'Directory is not valid.')
        return
      }

      const manager = await client.createManager({
        name,
        cwd: validation.path || cwd,
        modelSelection: newManagerModelSelection,
        reasoningLevel: newManagerReasoningLevel,
      })

      navigateToRoute({ view: 'chat', agentId: manager.agentId, surface: 'builder' })
      client.subscribeToAgent(manager.agentId, { reason: 'create' })

      // Seed .forge project resources if the user opted in (non-blocking)
      if (scaffoldForgeResources) {
        const profileId = manager.profileId ?? manager.agentId
        seedProjectResources(wsUrl, { profileId, sessionAgentId: manager.agentId }).catch((err) => {
          console.warn('Failed to seed .forge project resources:', err)
        })
      }

      setIsCreateManagerDialogOpen(false)
      setNewManagerName('')
      setNewManagerCwd('')
      setNewManagerModelSelection(undefined)
      setNewManagerReasoningLevel(undefined)
      setScaffoldForgeResources(true)
      setBrowseError(null)
      setCreateManagerError(null)
      resetCloneFields()
    } catch (error) {
      setCreateManagerError(toErrorMessage(error))
    } finally {
      setIsValidatingDirectory(false)
      setIsCreatingManager(false)
    }
  }, [
    clientRef,
    createProjectSourceMode,
    navigateToRoute,
    newManagerCwd,
    newManagerModelSelection,
    newManagerReasoningLevel,
    newManagerName,
    repositoryBasePath,
    repositoryFolder,
    repositoryUrl,
    resetCloneFields,
    scaffoldForgeResources,
    wsUrl,
  ])

  const handleRequestDeleteManager = useCallback((managerId: string) => {
    const manager = agents.find(
      (agent) => agent.agentId === managerId && agent.role === 'manager',
    )
    if (!manager) {
      return
    }

    setDeleteManagerError(null)
    setManagerToDelete(manager)
  }, [agents])

  const handleConfirmDeleteManager = useCallback(async () => {
    const manager = managerToDelete
    const client = clientRef.current
    if (!manager || !client) {
      return
    }

    setDeleteManagerError(null)
    setIsDeletingManager(true)

    try {
      await client.deleteManager(manager.agentId)

      if (activeAgentId === manager.agentId) {
        const nextTargetAgentId = client.getState().targetAgentId
        if (nextTargetAgentId) {
          navigateToRoute({
            view: 'chat',
            agentId: nextTargetAgentId,
            surface: 'builder',
          })
        } else {
          navigateToRoute({
            view: 'chat',
            agentId: DEFAULT_MANAGER_AGENT_ID,
            surface: 'builder',
          })
        }
      }

      setManagerToDelete(null)
      setDeleteManagerError(null)
    } catch (error) {
      setDeleteManagerError(toErrorMessage(error))
    } finally {
      setIsDeletingManager(false)
    }
  }, [activeAgentId, clientRef, managerToDelete, navigateToRoute])

  const handleCloseDeleteManagerDialog = useCallback(() => {
    if (isDeletingManager) {
      return
    }

    setManagerToDelete(null)
    setDeleteManagerError(null)
  }, [isDeletingManager])

  return {
    isCreateManagerDialogOpen,
    newManagerName,
    newManagerCwd,
    newManagerModelSelection,
    newManagerReasoningLevel,
    scaffoldForgeResources,
    createManagerError,
    browseError,
    isCreatingManager,
    isValidatingDirectory,
    isPickingDirectory,
    handleNewManagerNameChange,
    handleNewManagerCwdChange,
    handleNewManagerModelSelectionChange,
    handleNewManagerReasoningLevelChange,
    handleScaffoldForgeResourcesChange,
    handleOpenCreateManagerDialog,
    handleCreateManagerDialogOpenChange,
    handleBrowseDirectory,
    handleCreateManager,
    createProjectSourceMode,
    repositoryUrl,
    repositoryFolder,
    repositoryBasePath,
    cloneStage,
    clonePercent,
    cloneCancellable,
    isCancellingClone,
    handleCreateProjectSourceModeChange,
    handleRepositoryUrlChange,
    handleRepositoryFolderChange,
    handleRepositoryBasePathChange,
    handleBrowseRepositoryBasePath,
    handleCancelClone,
    managerToDelete,
    deleteManagerError,
    isDeletingManager,
    handleRequestDeleteManager,
    handleConfirmDeleteManager,
    handleCloseDeleteManagerDialog,
    isCompactingManager,
    handleCompactManager,
    isSmartCompactingManager,
    handleSmartCompactManager,
    isStoppingAllAgents,
    handleStopAllAgents,
  }
}

async function requestManagerCompaction(
  wsUrl: string,
  agentId: string,
  customInstructions?: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/agents/${encodeURIComponent(agentId)}/compact`,
  )

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      customInstructions && customInstructions.trim().length > 0
        ? { customInstructions: customInstructions.trim() }
        : {},
    ),
  })

  if (response.ok) {
    return
  }

  let errorMessage: string | undefined
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      errorMessage = payload.error.trim()
    }
  } catch {
    // Ignore JSON parsing errors and fall back to status-based error text.
  }

  throw new Error(errorMessage ?? `Compaction request failed with status ${response.status}`)
}

async function requestManagerSmartCompaction(
  wsUrl: string,
  agentId: string,
): Promise<void> {
  const endpoint = resolveApiEndpoint(
    wsUrl,
    `/api/agents/${encodeURIComponent(agentId)}/smart-compact`,
  )

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (response.ok) {
    return
  }

  let errorMessage: string | undefined
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      errorMessage = payload.error.trim()
    }
  } catch {
    // Ignore JSON parsing errors and fall back to status-based error text.
  }

  throw new Error(errorMessage ?? `Smart compaction request failed with status ${response.status}`)
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'An unexpected error occurred.'
}
