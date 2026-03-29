import type { CortexDocumentEntry, CortexDocumentGroup } from '@forge/protocol'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface CortexDocumentSelectorProps {
  documents: CortexDocumentEntry[]
  value: string
  onValueChange: (value: string) => void
}

const GROUP_ORDER: CortexDocumentGroup[] = [
  'commonKnowledge',
  'profileMemory',
  'referenceDocs',
  'promptOverrides',
]

const GROUP_LABELS: Record<CortexDocumentGroup, string> = {
  commonKnowledge: 'Common Knowledge',
  profileMemory: 'Profile Memory',
  referenceDocs: 'Reference Docs',
  promptOverrides: 'Prompt Overrides',
  notes: 'Notes',
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes <= 0) {
    return 'empty'
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }

  return `${(sizeBytes / 1024).toFixed(1)} KB`
}

export function CortexDocumentSelector({ documents, value, onValueChange }: CortexDocumentSelectorProps) {
  const groupedDocuments = GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    documents: documents
      .filter((document) => document.group === group)
      .sort((left, right) => left.label.localeCompare(right.label)),
  })).filter((entry) => entry.documents.length > 0)

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-7 text-[11px]" aria-label="Cortex document selector">
        <SelectValue placeholder="Select document" />
      </SelectTrigger>
      <SelectContent>
        {groupedDocuments.map((entry, index) => (
          <div key={entry.group}>
            {index > 0 ? <SelectSeparator /> : null}
            <SelectGroup>
              <SelectLabel>{entry.label}</SelectLabel>
              {entry.documents.map((document) => (
                <SelectItem key={document.id} value={document.id}>
                  <div className="flex items-center gap-1.5">
                    <span>{document.label}</span>
                    <span className="text-[9px] text-muted-foreground">({formatSize(document.sizeBytes)})</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </div>
        ))}
      </SelectContent>
    </Select>
  )
}
