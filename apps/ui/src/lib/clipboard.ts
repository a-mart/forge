/**
 * Copy plain text in both secure (HTTPS / localhost) and ordinary HTTP web
 * contexts. `navigator.clipboard` is missing or blocked outside a secure
 * context, which is the common Forge-in-the-browser path over LAN IPs.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false
  }

  const writeText = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : undefined

  if (typeof writeText === 'function') {
    try {
      await writeText.call(navigator.clipboard, text)
      return true
    } catch {
      // Fall through to the synchronous execCommand path.
    }
  }

  return copyTextWithExecCommand(text)
}

function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) {
    return false
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.padding = '0'
  textarea.style.border = 'none'
  textarea.style.outline = 'none'
  textarea.style.opacity = '0'

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
  }

  return copied
}
