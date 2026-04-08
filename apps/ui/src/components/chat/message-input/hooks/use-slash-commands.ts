import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

interface UseSlashCommandsOptions {
  slashCommands?: SlashCommand[]
  setInputWithDraft: (value: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

interface UseSlashCommandsReturn {
  isSlashMenuOpen: boolean
  setIsSlashMenuOpen: (open: boolean) => void
  slashFilter: string
  slashSelectedIndex: number
  setSlashSelectedIndex: (index: number) => void
  filteredSlashCommands: SlashCommand[]
  slashMenuRef: React.RefObject<HTMLDivElement | null>
  selectSlashCommand: (command: SlashCommand) => void
  /** Check if the given value should open the slash menu. Returns true if handled. */
  checkSlashTrigger: (value: string) => boolean
}

export function useSlashCommands({
  slashCommands,
  setInputWithDraft,
  textareaRef,
}: UseSlashCommandsOptions): UseSlashCommandsReturn {
  const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const slashMenuRef = useRef<HTMLDivElement | null>(null)

  const filteredSlashCommands = useMemo(() => {
    if (!slashCommands || slashCommands.length === 0) return []
    if (!slashFilter) return slashCommands
    const lower = slashFilter.toLowerCase()
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(lower))
  }, [slashCommands, slashFilter])

  // Close slash menu on outside click
  useEffect(() => {
    if (!isSlashMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setIsSlashMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isSlashMenuOpen])

  const selectSlashCommand = useCallback(
    (command: SlashCommand) => {
      setInputWithDraft(command.prompt)
      setIsSlashMenuOpen(false)
      setSlashFilter('')
      setSlashSelectedIndex(0)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [setInputWithDraft, textareaRef],
  )

  const checkSlashTrigger = useCallback(
    (value: string): boolean => {
      if (value.startsWith('/') && slashCommands && slashCommands.length > 0) {
        const afterSlash = value.slice(1)
        if (!afterSlash.includes(' ') && !afterSlash.includes('\n')) {
          setSlashFilter(afterSlash)
          setIsSlashMenuOpen(true)
          setSlashSelectedIndex(0)
          return true
        }
      }
      setIsSlashMenuOpen(false)
      return false
    },
    [slashCommands],
  )

  return {
    isSlashMenuOpen,
    setIsSlashMenuOpen,
    slashFilter,
    slashSelectedIndex,
    setSlashSelectedIndex,
    filteredSlashCommands,
    slashMenuRef,
    selectSlashCommand,
    checkSlashTrigger,
  }
}
