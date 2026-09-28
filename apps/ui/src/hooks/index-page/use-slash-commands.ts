import { useEffect, useRef, useState } from 'react'
import { fetchSlashCommands, type SlashCommand } from '@/components/settings/slash-commands-api'

interface UseSlashCommandsOptions {
  wsUrl: string
  activeView: string
}

export function useSlashCommands({ wsUrl, activeView }: UseSlashCommandsOptions) {
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([])
  const slashCommandsFetchKeyRef = useRef(0)

  useEffect(() => {
    const fetchKey = ++slashCommandsFetchKeyRef.current
    void (async () => {
      try {
        const cmds = await fetchSlashCommands(wsUrl)
        if (fetchKey === slashCommandsFetchKeyRef.current) {
          setSlashCommands(cmds)
        }
      } catch (error) {
        console.error('Failed to fetch slash commands:', error)
        if (fetchKey === slashCommandsFetchKeyRef.current) {
          setSlashCommands([])
        }
      }
    })()
  }, [activeView, wsUrl])

  return { slashCommands }
}

/** Built-in `/side` menu entry; selecting it inserts the command for an optional question. */
export const SIDE_SLASH_COMMAND: SlashCommand = {
  id: 'builtin:side',
  name: 'side',
  prompt: '/side ',
  description: 'Ask a side question in a temporary fork of this session',
  createdAt: '',
  updatedAt: '',
}

export function parseCompactSlashCommand(
  text: string,
): { customInstructions?: string } | null {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i)
  if (!match) {
    return null
  }

  const customInstructions = match[1]?.trim()
  if (!customInstructions) {
    return {}
  }

  return { customInstructions }
}

export function parseSideSlashCommand(
  text: string,
): { initialMessage?: string } | null {
  const match = text.trim().match(/^\/side(?:\s+([\s\S]+))?$/i)
  if (!match) {
    return null
  }

  const initialMessage = match[1]?.trim()
  return initialMessage ? { initialMessage } : {}
}
