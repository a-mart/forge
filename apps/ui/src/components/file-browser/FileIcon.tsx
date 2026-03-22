import { useEffect, useMemo, useState } from 'react'
import {
  File,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileIconName } from './file-browser-icons'

interface FileIconProps {
  fileName: string
  isDirectory: boolean
  isExpanded?: boolean
  className?: string
}

const materialIconUrlByPath = import.meta.glob(
  '/node_modules/material-icon-theme/icons/*.svg',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>

function resolveMaterialIconSrc(iconName: string): string | null {
  // Approach B (Vite-friendly): use import.meta.glob to pre-resolve icon URLs.
  const globPath = `/node_modules/material-icon-theme/icons/${iconName}.svg`
  if (materialIconUrlByPath[globPath]) {
    return materialIconUrlByPath[globPath]
  }

  // Approach A fallback attempt: direct node_modules URL.
  return `/node_modules/material-icon-theme/icons/${iconName}.svg`
}

function getLucideFallback(fileName: string, isDirectory: boolean, isExpanded: boolean) {
  if (isDirectory) {
    const Icon = isExpanded ? FolderOpen : Folder
    return <Icon className="size-4 shrink-0 text-sky-400" aria-hidden="true" />
  }

  const lower = fileName.toLowerCase()
  const ext = lower.split('.').pop() ?? ''

  if (['ts', 'tsx', 'cts', 'mts'].includes(ext)) {
    return <FileCode2 className="size-4 shrink-0 text-blue-400" aria-hidden="true" />
  }

  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return <FileCode2 className="size-4 shrink-0 text-yellow-400" aria-hidden="true" />
  }

  if (['json', 'yml', 'yaml', 'toml'].includes(ext)) {
    return <FileJson className="size-4 shrink-0 text-green-400" aria-hidden="true" />
  }

  if (['md', 'mdx', 'txt'].includes(ext)) {
    return <FileText className="size-4 shrink-0 text-purple-400" aria-hidden="true" />
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return <FileImage className="size-4 shrink-0 text-pink-400" aria-hidden="true" />
  }

  return <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
}

export function FileIcon({
  fileName,
  isDirectory,
  isExpanded = false,
  className,
}: FileIconProps) {
  const [loadFailed, setLoadFailed] = useState(false)

  const iconName = useMemo(
    () => getFileIconName(fileName, isDirectory, isExpanded),
    [fileName, isDirectory, isExpanded],
  )

  const iconSrc = useMemo(() => resolveMaterialIconSrc(iconName), [iconName])

  useEffect(() => {
    setLoadFailed(false)
  }, [iconName])

  if (!iconSrc || loadFailed) {
    return getLucideFallback(fileName, isDirectory, isExpanded)
  }

  return (
    <img
      src={iconSrc}
      alt=""
      className={cn('size-4 shrink-0', className)}
      loading="lazy"
      aria-hidden="true"
      onError={() => setLoadFailed(true)}
    />
  )
}
