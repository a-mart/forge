import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  onAddReference: () => Promise<void>
  referenceEditingAvailable: boolean
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
}: ProjectAgentReferenceDocsEditorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground">Reference Documents</label>
          <p className="text-[11px] text-muted-foreground">
            Injected into this project agent's prompt inside <code>&lt;agent_reference_docs&gt;</code>.
          </p>
        </div>
        {!isPromoting ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onAddReference()}
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

      {!isPromoting && !referenceEditingAvailable ? (
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
                    {isDirty ? (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                        Unsaved
                      </span>
                    ) : null}
                  </button>
                  {isSavingReference ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
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
                          className="resize-y font-mono text-xs"
                        />
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] text-muted-foreground">
                            Markdown content injected into this project agent's runtime prompt.
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void onSaveReference(fileName)}
                            disabled={!isDirty || isSavingReference || saving}
                          >
                            Save
                          </Button>
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
  )
}
