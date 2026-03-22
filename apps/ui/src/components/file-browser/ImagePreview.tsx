import { useEffect, useMemo, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'

interface ImagePreviewProps {
  wsUrl: string
  filePath: string
  agentId: string
}

export function ImagePreview({ wsUrl, filePath, agentId }: ImagePreviewProps) {
  const [loadError, setLoadError] = useState(false)

  const imageUrl = useMemo(() => {
    const params = new URLSearchParams({ path: filePath, agentId })
    return resolveApiEndpoint(wsUrl, `/api/read-file?${params.toString()}`)
  }, [wsUrl, filePath, agentId])

  // Reset error state when the image source changes
  useEffect(() => {
    setLoadError(false)
  }, [imageUrl])

  const fileName = filePath.split('/').pop() ?? 'Image'

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <ImageOff className="size-10 opacity-40" />
        <p className="text-sm">Failed to load image</p>
        <p className="font-mono text-xs opacity-60">{fileName}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto p-8">
      <img
        src={imageUrl}
        alt={fileName}
        className="max-h-[calc(100%-3rem)] max-w-full rounded-lg border border-border/50 bg-muted/20 object-contain"
        loading="lazy"
        onError={() => setLoadError(true)}
      />
      <p className="shrink-0 font-mono text-xs text-muted-foreground/70">
        {fileName}
      </p>
    </div>
  )
}


