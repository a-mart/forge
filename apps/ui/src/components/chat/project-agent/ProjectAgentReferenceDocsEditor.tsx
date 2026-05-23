import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface ProjectAgentReferenceDocsEditorProps {
  isPromoting: boolean
  referenceDocs: string[]
  expandedReferenceFile: string | null
  referenceContents: Record<string, string>
  loadingReferenceFiles: Set<string>
  savingReferenceFiles: Set<string>
  dirtyReferenceFiles: Set<string>
  referenceError: string | null
  saving: boolean
  configLoading: boolean
  onToggleReference: (fileName: string) => void
  onReferenceContentChange: (fileName: string, content: string) => void
  onSaveReference: (fileName: string) => Promise<void>
  onDeleteReference: (fileName: string) => Promise<void>
  onAddReference: (fileName: string, content: string) => Promise<void>
  referenceEditingAvailable: boolean
  readOnly?: boolean
  readOnlyReason?: string
}

export function ProjectAgentReferenceDocsEditor({
  isPromoting,
  referenceDocs,
  expandedReferenceFile,
  referenceContents,
  loadingReferenceFiles,
  savingReferenceFiles,
  dirtyReferenceFiles,
  referenceError,
  saving,
  configLoading,
  onToggleReference,
  onReferenceContentChange,
  onSaveReference,
  onDeleteReference,
  onAddReference,
  referenceEditingAvailable,
  readOnly = false,
  readOnlyReason,
}: ProjectAgentReferenceDocsEditorProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newReferenceFileName, setNewReferenceFileName] = useState('notes.md')
  const [newReferenceContent, setNewReferenceContent] = useState('')
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [addingReference, setAddingReference] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const resetAddDialog = () => {
    setNewReferenceFileName('notes.md')
    setNewReferenceContent('')
    setSelectedFileName(null)
    setAddError(null)
    setDragOver(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleOpenAddDialog = () => {
    resetAddDialog()
    setAddDialogOpen(true)
  }

  const importFile = useCallback(async (file: File) => {
    setAddError(null)
    try {
      setSelectedFileName(file.name)
      setNewReferenceFileName(file.name)
      setNewReferenceContent(await file.text())
    } catch {
      setAddError(`Failed to read ${file.name}.`)
    }
  }, [])

  const handleSelectedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) await importFile(file)
  }

  const handleDrop = useCallback(async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files[0]
    if (file) await importFile(file)
  }, [importFile])

  const handleDragOver = useCallback((event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleCreateReference = async () => {
    const fileName = newReferenceFileName.trim()
    if (!fileName) {
      setAddError('Enter a filename for the reference document.')
      return
    }

    setAddingReference(true)
    setAddError(null)
    try {
      await onAddReference(fileName, newReferenceContent)
      setAddDialogOpen(false)
      resetAddDialog()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : `Failed to create ${fileName}.`)
    } finally {
      setAddingReference(false)
    }
  }

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">Reference Documents</label>
            <p className="text-[11px] text-muted-foreground">
              Injected into this project agent's prompt inside <code>&lt;agent_reference_docs&gt;</code>.
            </p>
          </div>
          {!isPromoting && !readOnly ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenAddDialog}
              disabled={!referenceEditingAvailable || configLoading || saving}
              className="gap-1.5"
            >
              <Plus className="size-3.5" />
              Add Reference Document
            </Button>
          ) : null}
        </div>

      {isPromoting ? (
        <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Promote this session first, then add reference documents.
        </p>
      ) : null}

      {!isPromoting && readOnly ? (
        <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {readOnlyReason ?? 'Reference documents are read-only.'}
        </p>
      ) : null}

      {!isPromoting && !readOnly && !referenceEditingAvailable ? (
        <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Reference document editing is unavailable right now.
        </p>
      ) : null}

      {!isPromoting && referenceDocs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground">
          No reference documents yet.
        </p>
      ) : null}

      {!isPromoting && referenceDocs.length > 0 ? (
        <div className="space-y-2">
          {referenceDocs.map((fileName) => {
            const isExpanded = expandedReferenceFile === fileName
            const isLoading = loadingReferenceFiles.has(fileName)
            const isSavingReference = savingReferenceFiles.has(fileName)
            const isDirty = dirtyReferenceFiles.has(fileName)
            const content = referenceContents[fileName] ?? ''

            return (
              <div key={fileName} className="overflow-hidden rounded-md border border-border/60">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onToggleReference(fileName)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isExpanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 truncate font-mono text-sm">{fileName}</span>
                    {isDirty && !readOnly ? (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Unsaved
                      </span>
                    ) : null}
                  </button>
                  {isSavingReference ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                  {!readOnly ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void onDeleteReference(fileName)}
                      disabled={isSavingReference || saving}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete {fileName}</span>
                    </Button>
                  ) : null}
                </div>
                {isExpanded ? (
                  <div className="space-y-2 border-t border-border/60 px-3 py-3">
                    {isLoading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        <span>Loading document…</span>
                      </div>
                    ) : (
                      <>
                        <Textarea
                          value={content}
                          onChange={(event) => onReferenceContentChange(fileName, event.target.value)}
                          rows={10}
                          className="max-h-80 resize-y overflow-y-auto font-mono text-xs"
                          style={{ fieldSizing: 'fixed' }}
                          readOnly={readOnly}
                          disabled={readOnly}
                        />
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] text-muted-foreground">
                            Markdown content injected into this project agent's runtime prompt.
                          </p>
                          {!readOnly ? (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void onSaveReference(fileName)}
                              disabled={!isDirty || isSavingReference || saving}
                            >
                              Save
                            </Button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

        {referenceError ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            {referenceError}
          </p>
        ) : null}
      </div>

      <Dialog open={addDialogOpen} onOpenChange={(open) => { if (!addingReference) setAddDialogOpen(open) }}>
        {/* Inline style for max-height: arbitrary Tailwind classes like max-h-[85vh] silently fail in Tailwind v4 */}
        <DialogContent className="flex flex-col overflow-hidden sm:max-w-xl" style={{ maxHeight: '85vh' }}>
          <DialogHeader className="shrink-0">
            <DialogTitle>Add reference document</DialogTitle>
            <DialogDescription>
              Create a Markdown reference document or import a local text file for this project agent.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
            {/* Dropzone-style import control */}
            <div className="space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(event) => { void handleSelectedFile(event) }}
                disabled={addingReference}
                className="sr-only"
                aria-label="Choose reference document file"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                onDrop={(event) => { void handleDrop(event) }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                disabled={addingReference}
                className={`flex w-full items-center gap-3 rounded-lg border-2 border-dashed px-4 py-5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  dragOver
                    ? 'border-primary bg-primary/5'
                    : selectedFileName
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border hover:border-primary/50 hover:bg-muted/30'
                }`}
              >
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-colors ${
                  selectedFileName ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {selectedFileName ? <FileText className="size-5" /> : <Upload className="size-5" />}
                </span>
                {selectedFileName ? (
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block truncate font-mono text-sm font-medium text-foreground">
                      {selectedFileName}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {newReferenceContent.length.toLocaleString()} characters — click to choose a different file
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block text-sm font-medium text-foreground">
                      Click to choose a file or drag and drop
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Markdown (.md) or plain text (.txt)
                    </span>
                  </span>
                )}
              </button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-agent-reference-name">Filename</Label>
              <Input
                id="project-agent-reference-name"
                value={newReferenceFileName}
                onChange={(event) => setNewReferenceFileName(event.target.value)}
                placeholder="notes.md"
                className="font-mono text-sm"
                disabled={addingReference}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="project-agent-reference-content">Initial content</Label>
              {/* Inline style overrides shadcn Textarea's field-sizing-content to prevent auto-expansion */}
              <Textarea
                id="project-agent-reference-content"
                value={newReferenceContent}
                onChange={(event) => setNewReferenceContent(event.target.value)}
                rows={6}
                className="max-h-48 resize-y overflow-y-auto font-mono text-xs"
                style={{ fieldSizing: 'fixed' }}
                placeholder="# Notes"
                disabled={addingReference}
              />
            </div>

            {addError ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
                {addError}
              </p>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => setAddDialogOpen(false)} disabled={addingReference}>
              Cancel
            </Button>
            <Button type="button" onClick={() => { void handleCreateReference() }} disabled={addingReference}>
              {addingReference ? 'Adding…' : 'Add document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
