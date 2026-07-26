import type {
  ForgeActionKind,
  ForgeActionSettings,
  StreamDeckSessionSummary,
  StreamDeckSnapshot,
} from './types.js'

const COLORS = {
  void: '#050711',
  panel: '#0b1020',
  cyan: '#39e7ff',
  violet: '#9b6cff',
  ember: '#ff6b35',
  gold: '#ffd166',
  green: '#55f59a',
  red: '#ff4668',
  muted: '#8491ad',
  white: '#f5fbff',
}

export function renderKey(
  kind: ForgeActionKind,
  snapshot: StreamDeckSnapshot | null,
  settings: ForgeActionSettings,
  frame: number,
  connected: boolean,
): string {
  if (!connected || !snapshot) return offlineKey(kind, 0)
  const session = resolveSession(snapshot, settings)
  const animatedFrame = shouldAnimateKey(kind, snapshot, settings) ? frame : 0
  switch (kind) {
    case 'pulse':
      return pulseKey(snapshot, animatedFrame)
    case 'session':
      return sessionKey(session, animatedFrame)
    case 'attention':
      return attentionKey(snapshot, session, animatedFrame)
    case 'workers':
      return workersKey(snapshot, session, animatedFrame)
    case 'context':
      return contextKey(session, animatedFrame)
    case 'stats':
      return statsKey(snapshot, settings, animatedFrame)
    case 'view':
      return viewKey(settings.view ?? 'git', session, animatedFrame)
    case 'mission':
      return missionKey(settings, session, animatedFrame)
    case 'control':
      return controlKey(settings, session, animatedFrame)
    case 'new-session':
      return newSessionKey(snapshot, settings, animatedFrame)
  }
}

export function shouldAnimateKey(
  kind: ForgeActionKind,
  snapshot: StreamDeckSnapshot,
  settings: ForgeActionSettings,
): boolean {
  if (snapshot.summary.pendingChoiceCount <= 0) return false
  if (kind === 'pulse' || kind === 'attention') return true
  return kind === 'session' && (resolveSession(snapshot, settings)?.pendingChoiceCount ?? 0) > 0
}

export function renderPairingKey(kind: ForgeActionKind, code: string | null): string {
  const frame = 0
  const display = code ? `${code.slice(0, 3)} ${code.slice(3)}` : 'OPEN FORGE'
  return shell(`
    <circle cx="72" cy="57" r="33" fill="${COLORS.violet}" fill-opacity=".14" stroke="${COLORS.violet}" stroke-width="4" stroke-dasharray="${8 + frame % 8} 7" filter="url(#g)"/>
    <path d="M56 58h32M72 42v32" stroke="${COLORS.white}" stroke-width="5" stroke-linecap="round"/>
    <text x="72" y="111" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="12" font-weight="900">PAIR FORGE</text>
    <text x="72" y="130" text-anchor="middle" fill="${COLORS.gold}" font-family="ui-monospace,monospace" font-size="13" font-weight="900">${display}</text>
    <text x="18" y="24" fill="${COLORS.muted}" font-family="system-ui" font-size="7">${kind.toUpperCase()}</text>
  `, COLORS.violet, frame, true)
}

export function resolveSession(
  snapshot: StreamDeckSnapshot,
  settings: ForgeActionSettings,
): StreamDeckSessionSummary | null {
  if (settings.targetMode === 'fixed' && settings.targetAgentId) {
    return snapshot.sessions.find((session) => session.agentId === settings.targetAgentId) ?? null
  }
  if (settings.targetMode === 'slot') {
    return snapshot.sessions[Math.max(0, Number(settings.slot) || 0)] ?? null
  }
  return snapshot.sessions.find((session) => session.agentId === snapshot.focusSessionAgentId)
    ?? snapshot.sessions[0]
    ?? null
}

function shell(body: string, accent: string, frame: number, urgent = false): string {
  const glow = urgent && frame % 2 === 0 ? COLORS.gold : accent
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${COLORS.panel}"/><stop offset="1" stop-color="${COLORS.void}"/></linearGradient>
    <radialGradient id="halo"><stop stop-color="${glow}" stop-opacity=".28"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
    <filter id="g"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="144" height="144" rx="22" fill="url(#bg)"/>
  <circle cx="${22 + (frame * 13) % 100}" cy="${18 + (frame * 7) % 92}" r="58" fill="url(#halo)"/>
  <path d="M12 30V18a6 6 0 0 1 6-6h12M114 12h12a6 6 0 0 1 6 6v12M132 114v12a6 6 0 0 1-6 6h-12M30 132H18a6 6 0 0 1-6-6v-12" fill="none" stroke="${glow}" stroke-width="${urgent ? 4 : 2}" opacity="${urgent ? 1 : .72}" filter="url(#g)"/>
  ${body}
  </svg>`
}

function pulseKey(snapshot: StreamDeckSnapshot, frame: number): string {
  const urgent = snapshot.summary.pendingChoiceCount > 0
  const active = snapshot.summary.runningSessionCount + snapshot.summary.activeWorkerCount
  const dots = Array.from({ length: Math.min(6, Math.max(1, active)) }, (_, index) => {
    const angle = ((frame * 22 + index * 60) * Math.PI) / 180
    return `<circle cx="${72 + Math.cos(angle) * 35}" cy="${67 + Math.sin(angle) * 35}" r="3.5" fill="${index % 2 ? COLORS.violet : COLORS.cyan}"/>`
  }).join('')
  return shell(`
    <circle cx="72" cy="67" r="30" fill="none" stroke="${urgent ? COLORS.gold : COLORS.cyan}" stroke-width="5" stroke-dasharray="${22 + frame * 2} 10" filter="url(#g)"/>
    <path d="M42 67h16l7-15 12 31 8-16h17" fill="none" stroke="${COLORS.white}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <text x="72" y="121" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="13" font-weight="800">FORGE PULSE</text>
    ${badge(snapshot.summary.pendingChoiceCount || snapshot.summary.unreadCount, urgent ? COLORS.gold : COLORS.cyan)}
  `, urgent ? COLORS.gold : COLORS.cyan, frame, urgent)
}

function sessionKey(session: StreamDeckSessionSummary | null, frame: number): string {
  if (!session) return emptyKey('SESSION', frame)
  const urgent = session.pendingChoiceCount > 0
  const accent = statusColor(session.status, urgent)
  const running = session.status === 'streaming' || session.activeWorkerCount > 0
  const name = truncate(session.label, 15)
  return shell(`
    <circle cx="72" cy="58" r="30" fill="none" stroke="${COLORS.muted}" stroke-width="4" opacity=".25"/>
    <circle cx="72" cy="58" r="30" fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${Math.max(7, session.contextPercent * 1.88)} 188" transform="rotate(-90 72 58)" filter="url(#g)"/>
    <text x="72" y="65" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="19" font-weight="900">${running ? '▶' : statusGlyph(session.status)}</text>
    <text x="72" y="104" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="12" font-weight="800">${escape(name)}</text>
    <text x="72" y="120" text-anchor="middle" fill="${accent}" font-family="system-ui" font-size="10" font-weight="700">${session.activeWorkerCount} ACTIVE · ${session.contextPercent}%</text>
    ${running ? sparks(frame, accent) : ''}
    ${badge(session.pendingChoiceCount || session.unreadCount, urgent ? COLORS.gold : COLORS.cyan)}
  `, accent, frame, urgent)
}

function attentionKey(
  snapshot: StreamDeckSnapshot,
  session: StreamDeckSessionSummary | null,
  frame: number,
): string {
  const questions = snapshot.summary.pendingChoiceCount
  const unread = snapshot.summary.unreadCount
  const urgent = questions > 0
  const label = urgent ? 'QUESTION' : unread > 0 ? 'UNREAD' : 'ALL CLEAR'
  const value = questions || unread
  const accent = urgent ? COLORS.gold : unread > 0 ? COLORS.cyan : COLORS.green
  return shell(`
    <path d="M52 63c0-15 9-25 21-25 13 0 22 9 22 21 0 18-17 18-17 29" fill="none" stroke="${accent}" stroke-width="8" stroke-linecap="round" filter="url(#g)"/>
    <circle cx="78" cy="101" r="5" fill="${accent}"/>
    <text x="72" y="120" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="12" font-weight="900">${label}</text>
    ${session ? `<text x="72" y="134" text-anchor="middle" fill="${COLORS.muted}" font-family="system-ui" font-size="8">${escape(truncate(session.label, 18))}</text>` : ''}
    ${badge(value, accent)}
  `, accent, frame, urgent)
}

function workersKey(
  snapshot: StreamDeckSnapshot,
  session: StreamDeckSessionSummary | null,
  frame: number,
): string {
  const active = session?.activeWorkerCount ?? snapshot.summary.activeWorkerCount
  const total = session?.workerCount ?? snapshot.stats?.totalWorkersRun ?? 0
  const nodes = Array.from({ length: Math.min(7, Math.max(1, total)) }, (_, index) => {
    const angle = ((index * 360 / Math.min(7, Math.max(1, total))) + frame * 8) * Math.PI / 180
    const color = index < active ? COLORS.green : COLORS.violet
    return `<line x1="72" y1="61" x2="${72 + Math.cos(angle) * 35}" y2="${61 + Math.sin(angle) * 35}" stroke="${color}" opacity=".45"/><circle cx="${72 + Math.cos(angle) * 35}" cy="${61 + Math.sin(angle) * 35}" r="${index < active ? 6 : 4}" fill="${color}" filter="url(#g)"/>`
  }).join('')
  return shell(`
    ${nodes}<circle cx="72" cy="61" r="14" fill="${COLORS.cyan}" filter="url(#g)"/>
    <text x="72" y="66" text-anchor="middle" fill="${COLORS.void}" font-family="system-ui" font-size="14" font-weight="900">${active}</text>
    <text x="72" y="112" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="13" font-weight="900">WORKER RADAR</text>
    <text x="72" y="128" text-anchor="middle" fill="${COLORS.green}" font-family="system-ui" font-size="10">${active} ACTIVE · ${total} TOTAL</text>
  `, active > 0 ? COLORS.green : COLORS.violet, frame)
}

function contextKey(session: StreamDeckSessionSummary | null, frame: number): string {
  const percent = session?.contextPercent ?? 0
  const accent = percent >= 85 ? COLORS.red : percent >= 70 ? COLORS.gold : COLORS.violet
  const circumference = 251
  return shell(`
    <circle cx="72" cy="62" r="40" fill="none" stroke="${COLORS.muted}" stroke-opacity=".18" stroke-width="9"/>
    <circle cx="72" cy="62" r="40" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${percent * 2.51} ${circumference}" transform="rotate(-90 72 62)" filter="url(#g)"/>
    <text x="72" y="70" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="25" font-weight="900">${percent}%</text>
    <text x="72" y="117" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="12" font-weight="900">CONTEXT CORE</text>
    <text x="72" y="132" text-anchor="middle" fill="${accent}" font-family="system-ui" font-size="9">HOLD 0.7s TO COMPACT</text>
  `, accent, frame, percent >= 85)
}

function statsKey(snapshot: StreamDeckSnapshot, settings: ForgeActionSettings, frame: number): string {
  const metric = settings.label ?? 'tokens'
  const stats = snapshot.stats
  const value = metric === 'cache'
    ? `${Math.round(stats?.cacheHitRate ?? 0)}%`
    : metric === 'commits'
      ? String(stats?.commits ?? 0)
      : metric === 'lines'
        ? compactNumber(stats?.linesAdded ?? 0)
        : compactNumber(stats?.tokensToday ?? 0)
  const caption = metric === 'cache' ? 'CACHE HIT' : metric === 'commits' ? 'COMMITS' : metric === 'lines' ? 'LINES ADDED' : 'TOKENS TODAY'
  return shell(`
    <path d="M34 88V71h15v17M58 88V50h15v38M82 88V60h15v28M106 88V34h8v54" fill="none" stroke="${COLORS.cyan}" stroke-width="8" stroke-linecap="round" filter="url(#g)"/>
    <text x="72" y="113" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="22" font-weight="900">${value}</text>
    <text x="72" y="130" text-anchor="middle" fill="${COLORS.cyan}" font-family="system-ui" font-size="9" font-weight="800">${caption}</text>
  `, COLORS.cyan, frame)
}

function viewKey(
  view: NonNullable<ForgeActionSettings['view']>,
  session: StreamDeckSessionSummary | null,
  frame: number,
): string {
  const icons: Record<string, string> = {
    chat: '◆',
    git: '⑂',
    browser: '◎',
    terminal: '>_',
    stats: '▥',
    tokens: '◫',
  }
  const accent = view === 'git' ? COLORS.ember : view === 'browser' ? COLORS.cyan : view === 'terminal' ? COLORS.green : COLORS.violet
  return shell(`
    <rect x="31" y="29" width="82" height="65" rx="13" fill="${accent}" fill-opacity=".12" stroke="${accent}" stroke-width="3"/>
    <text x="72" y="72" text-anchor="middle" fill="${COLORS.white}" font-family="ui-monospace,monospace" font-size="30" font-weight="900">${icons[view] ?? '◆'}</text>
    <text x="72" y="116" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="13" font-weight="900">${view.toUpperCase()}</text>
    <text x="72" y="131" text-anchor="middle" fill="${accent}" font-family="system-ui" font-size="8">${escape(truncate(session?.label ?? 'FORGE', 18))}</text>
  `, accent, frame)
}

function missionKey(settings: ForgeActionSettings, session: StreamDeckSessionSummary | null, frame: number): string {
  const label = truncate(settings.label || 'QUICK MISSION', 16)
  return shell(`
    <path d="M72 25l12 25 28 4-20 20 5 28-25-13-25 13 5-28-20-20 28-4z" fill="${COLORS.ember}" fill-opacity=".18" stroke="${COLORS.ember}" stroke-width="4" filter="url(#g)"/>
    <path d="M55 66h34M72 49v34" stroke="${COLORS.white}" stroke-width="5" stroke-linecap="round"/>
    <text x="72" y="119" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="11" font-weight="900">${escape(label)}</text>
    <text x="72" y="133" text-anchor="middle" fill="${COLORS.ember}" font-family="system-ui" font-size="8">${escape(truncate(session?.label ?? 'ATTENTION', 18))}</text>
  `, COLORS.ember, frame)
}

function controlKey(settings: ForgeActionSettings, session: StreamDeckSessionSummary | null, frame: number): string {
  const control = settings.control ?? 'toggle'
  const stopped = session?.status === 'stopped' || session?.status === 'terminated'
  const label = control === 'compact' ? 'SMART COMPACT' : control === 'mark_read' ? 'MARK READ' : stopped ? 'RESUME' : 'STOP'
  const glyph = control === 'compact' ? '◇' : control === 'mark_read' ? '✓' : stopped ? '▶' : '■'
  const accent = control === 'compact' ? COLORS.violet : control === 'mark_read' ? COLORS.cyan : stopped ? COLORS.green : COLORS.red
  return shell(`
    <circle cx="72" cy="61" r="36" fill="${accent}" fill-opacity=".13" stroke="${accent}" stroke-width="4" filter="url(#g)"/>
    <text x="72" y="73" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="34" font-weight="900">${glyph}</text>
    <text x="72" y="119" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="11" font-weight="900">${label}</text>
    <text x="72" y="133" text-anchor="middle" fill="${accent}" font-family="system-ui" font-size="8">HOLD 0.7s TO EXECUTE</text>
  `, accent, frame)
}

function newSessionKey(snapshot: StreamDeckSnapshot, settings: ForgeActionSettings, frame: number): string {
  const profile = snapshot.profiles.find((entry) => entry.profileId === settings.targetProfileId) ?? snapshot.profiles[0]
  return shell(`
    <circle cx="72" cy="61" r="35" fill="${COLORS.green}" fill-opacity=".11" stroke="${COLORS.green}" stroke-width="4"/>
    <path d="M72 42v38M53 61h38" stroke="${COLORS.white}" stroke-width="7" stroke-linecap="round" filter="url(#g)"/>
    <text x="72" y="117" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="11" font-weight="900">NEW SESSION</text>
    <text x="72" y="133" text-anchor="middle" fill="${COLORS.green}" font-family="system-ui" font-size="7">HOLD 0.7s · ${escape(truncate(profile?.displayName ?? 'PROFILE', 10))}</text>
  `, COLORS.green, frame)
}

function offlineKey(kind: ForgeActionKind, frame: number): string {
  return shell(`
    <path d="M42 49l60 48M102 49L42 97" stroke="${COLORS.red}" stroke-width="7" stroke-linecap="round" opacity=".8"/>
    <text x="72" y="119" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="11" font-weight="900">${kind.toUpperCase()}</text>
    <text x="72" y="133" text-anchor="middle" fill="${COLORS.red}" font-family="system-ui" font-size="8">FORGE OFFLINE</text>
  `, COLORS.red, frame)
}

function emptyKey(label: string, frame: number): string {
  return shell(`
    <circle cx="72" cy="61" r="34" fill="none" stroke="${COLORS.muted}" stroke-width="3" stroke-dasharray="5 7"/>
    <text x="72" y="68" text-anchor="middle" fill="${COLORS.muted}" font-family="system-ui" font-size="25">+</text>
    <text x="72" y="119" text-anchor="middle" fill="${COLORS.white}" font-family="system-ui" font-size="11" font-weight="900">${label}</text>
    <text x="72" y="133" text-anchor="middle" fill="${COLORS.muted}" font-family="system-ui" font-size="8">NO MATCH</text>
  `, COLORS.muted, frame)
}

function sparks(frame: number, color: string): string {
  return Array.from({ length: 3 }, (_, index) => {
    const angle = ((frame * 28 + index * 120) * Math.PI) / 180
    return `<circle cx="${72 + Math.cos(angle) * 43}" cy="${58 + Math.sin(angle) * 43}" r="2.5" fill="${color}" filter="url(#g)"/>`
  }).join('')
}

function badge(value: number, color: string): string {
  if (value <= 0) return ''
  return `<circle cx="116" cy="28" r="17" fill="${color}" filter="url(#g)"/><text x="116" y="34" text-anchor="middle" fill="${COLORS.void}" font-family="system-ui" font-size="16" font-weight="900">${value > 99 ? '99+' : value}</text>`
}

function statusColor(status: StreamDeckSessionSummary['status'], urgent: boolean): string {
  if (urgent) return COLORS.gold
  if (status === 'streaming') return COLORS.green
  if (status === 'error') return COLORS.red
  if (status === 'stopped' || status === 'terminated') return COLORS.muted
  return COLORS.cyan
}

function statusGlyph(status: StreamDeckSessionSummary['status']): string {
  if (status === 'error') return '!'
  if (status === 'stopped' || status === 'terminated') return '■'
  return '●'
}

function compactNumber(value: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(1, length - 1))}…`
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character)
}
