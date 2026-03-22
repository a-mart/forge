import { useEffect, useState } from 'react'

/* ------------------------------------------------------------------ */
/*  Theme configuration for react-diff-viewer-continued               */
/*  Colors harmonize with Forge's CSS custom properties               */
/* ------------------------------------------------------------------ */

export const forgeDiffDarkStyles = {
  variables: {
    dark: {
      diffViewerBackground: '#1a1a1a',
      addedBackground: 'hsl(140 30% 12%)',
      removedBackground: 'hsl(0 30% 14%)',
      wordAddedBackground: 'hsl(140 40% 18%)',
      wordRemovedBackground: 'hsl(0 40% 20%)',
      addedGutterBackground: 'hsl(140 25% 10%)',
      removedGutterBackground: 'hsl(0 25% 12%)',
      gutterBackground: '#242424',
      gutterColor: 'hsl(0 0% 40%)',
      codeFoldBackground: 'hsl(220 20% 14%)',
      codeFoldGutterBackground: 'hsl(220 15% 12%)',
      codeFoldContentColor: 'hsl(220 20% 55%)',
      addedColor: 'hsl(140 60% 75%)',
      removedColor: 'hsl(0 60% 75%)',
      emptyLineBackground: '#242424',
    },
  },
  codeFold: {
    fontSize: '12px',
  },
  line: {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, "Geist Mono", ui-monospace, monospace)',
  },
  gutter: {
    fontSize: '12px',
    minWidth: '40px',
    padding: '0 8px',
  },
  contentText: {
    fontFamily: 'var(--font-mono, "Geist Mono", ui-monospace, monospace)',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  content: {
    width: 'auto',
  },
  diffContainer: {
    borderRadius: '0',
  },
}

export const forgeDiffLightStyles = {
  variables: {
    light: {
      diffViewerBackground: '#f8f5f0',
      addedBackground: 'hsl(140 40% 92%)',
      removedBackground: 'hsl(0 40% 94%)',
      wordAddedBackground: 'hsl(140 50% 85%)',
      wordRemovedBackground: 'hsl(0 50% 88%)',
      addedGutterBackground: 'hsl(140 35% 88%)',
      removedGutterBackground: 'hsl(0 35% 90%)',
      gutterBackground: '#f0e9e0',
      gutterColor: 'hsl(0 0% 55%)',
      codeFoldBackground: 'hsl(220 20% 94%)',
      codeFoldGutterBackground: 'hsl(220 15% 92%)',
      codeFoldContentColor: 'hsl(220 20% 45%)',
      addedColor: 'hsl(140 60% 25%)',
      removedColor: 'hsl(0 60% 30%)',
      emptyLineBackground: '#f0e9e0',
    },
  },
  codeFold: {
    fontSize: '12px',
  },
  line: {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, "Geist Mono", ui-monospace, monospace)',
  },
  gutter: {
    fontSize: '12px',
    minWidth: '40px',
    padding: '0 8px',
  },
  contentText: {
    fontFamily: 'var(--font-mono, "Geist Mono", ui-monospace, monospace)',
    fontSize: '13px',
    lineHeight: '1.5',
  },
  content: {
    width: 'auto',
  },
  diffContainer: {
    borderRadius: '0',
  },
}

/**
 * Hook that returns the correct diff theme based on Forge's current light/dark mode.
 * Listens for class changes on <html> so it reacts to runtime theme switches.
 */
export function useDiffTheme() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return true
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    const el = document.documentElement
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains('dark'))
    })
    observer.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return {
    styles: isDark ? forgeDiffDarkStyles : forgeDiffLightStyles,
    useDarkTheme: isDark,
  }
}
