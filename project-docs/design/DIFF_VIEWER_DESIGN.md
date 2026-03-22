# Diff Viewer — Design Document

> **Status:** DRAFT — Pending review
> **Date:** 2026-03-22
> **Research inputs:** `.internal/diff-viewer-ux-research.md`, `.internal/diff-viewer-codebase-survey.md`
> **Scope:** Read-only git diff viewer (v1) — working directory changes and commit history browsing

---

## 1. Overview

### What This Is

A built-in git diff viewer for Forge, triggered from the chat header. It provides two views:

1. **Changes** — Working directory vs HEAD (unstaged/staged changes)
2. **History** — Commit log browsing with per-commit file diffs

### User-Facing Value

Forge users (developers working with AI coding agents) frequently need to inspect what agents have changed without leaving the UI. Today this requires switching to a terminal, VS Code, or GitHub Desktop. The diff viewer eliminates that context switch — pop open a near-full-screen overlay, review changes, close it, and continue chatting.

### Design Constraints

- **Read-only for v1.** No staging, unstaging, committing, or reverting.
- **Scoped to CWD** of the active manager session's profile.
- **Near-full-screen Radix Dialog** (~95vw × 92vh), not a route or sidebar.
- **Primary library:** `react-diff-viewer-continued` for diff rendering.
- **Backend:** New HTTP endpoints using the existing `GitCli` class from `apps/backend/src/versioning/git-cli.ts`.

---

## 2. Architecture

### Data Flow

```
┌──────────────┐     HTTP GET      ┌──────────────────┐     GitCli      ┌─────────┐
│   React UI   │ ───────────────→  │  git-diff-routes  │ ─────────────→  │   git   │
│  (Dialog)    │ ←───────────────  │  (backend)        │ ←─────────────  │  (CLI)  │
└──────────────┘     JSON          └──────────────────┘     stdout       └─────────┘
```

- **Frontend** opens the diff viewer dialog, issues HTTP requests via TanStack Query.
- **Backend** exposes new `/api/git/*` HTTP routes that invoke git commands via the existing `GitCli` wrapper.
- **No WebSocket commands needed.** Diff data is request/response — HTTP GET is the right transport. This matches the pattern used by `/api/read-file` and `/api/prompts`.
- **No protocol changes.** All types are route-local; nothing needs to go into `packages/protocol/`.

### Component Tree (High-Level)

```
ChatHeader
└── DiffViewerButton (new)  ──triggers──→  DiffViewerDialog

DiffViewerDialog (Radix Dialog, ~95vw × 92vh)
├── DiffDialogHeader
│   ├── TabSwitcher (Changes | History)
│   ├── RepoInfo (repo name, current branch)
│   ├── ViewModeToggle (unified | split)
│   ├── RefreshButton
│   └── CloseButton
├── ChangesView (tab content)
│   ├── ChangesFileList (left panel, ~250px)
│   │   ├── FilterInput
│   │   ├── FileListItems (virtualized if >50 files)
│   │   └── ChangeSummary
│   └── DiffPane (remaining width)
│       ├── FilePathHeader (sticky)
│       └── DiffRenderer (react-diff-viewer-continued)
├── HistoryView (tab content)
│   ├── CommitList (left panel, ~220px, virtualized)
│   ├── CommitFileList (center panel, ~200px)
│   └── DiffPane (remaining width)
│       ├── FilePathHeader (sticky)
│       └── DiffRenderer
└── DiffStatusBar
    └── SummaryStats
```

---

## 3. Backend Design

### 3.1 New Route File

**New file:** `apps/backend/src/ws/routes/git-diff-routes.ts`

Following the existing pattern (`createHealthRoutes`, `createFileRoutes`, etc.), this exports a `createGitDiffRoutes` factory that returns `HttpRoute[]`.

**Registration in `server.ts`:**

```ts
import { createGitDiffRoutes } from "./routes/git-diff-routes.js";

// In constructor, add to httpRoutes array:
...createGitDiffRoutes({ swarmManager: this.swarmManager }),
```

### 3.2 Git Service Layer

Rather than adding a new `simple-git` dependency, reuse the existing `GitCli` class from `apps/backend/src/versioning/git-cli.ts`. It already handles:

- Configurable `cwd`
- Retry logic for transient git failures (lock contention, permission errors)
- 10MB max buffer (sufficient for diffs)
- Error normalization

Create a thin service module that wraps `GitCli` with diff-specific methods:

**New file:** `apps/backend/src/ws/routes/git-diff-service.ts`

```ts
import { GitCli } from "../../versioning/git-cli.js";

export interface GitFileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";
  oldPath?: string;          // for renames
  additions?: number;
  deletions?: number;
}

export interface GitStatusResult {
  files: GitFileStatus[];
  branch: string;
  summary: { filesChanged: number; insertions: number; deletions: number };
}

export interface GitDiffResult {
  oldContent: string;
  newContent: string;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;               // ISO timestamp
  filesChanged: number;
}

export interface GitLogResult {
  commits: GitLogEntry[];
  hasMore: boolean;
}

export interface GitCommitDetail {
  sha: string;
  message: string;
  author: string;
  date: string;
  files: GitFileStatus[];
}

export class GitDiffService {
  async getStatus(cwd: string): Promise<GitStatusResult> { ... }
  async getFileDiff(cwd: string, file: string): Promise<GitDiffResult> { ... }
  async getUntrackedFileContent(cwd: string, file: string): Promise<string> { ... }
  async getLog(cwd: string, limit: number, offset: number): Promise<GitLogResult> { ... }
  async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetail> { ... }
  async getCommitFileDiff(cwd: string, sha: string, file: string): Promise<GitDiffResult> { ... }
  async getBranch(cwd: string): Promise<string> { ... }
  async getRepoName(cwd: string): Promise<string> { ... }
}
```

**Implementation notes:**

- `getStatus` runs `git status --porcelain=v1` and `git diff --stat` to get file list with change counts. Also runs `git rev-parse --abbrev-ref HEAD` for the current branch.
- `getFileDiff` runs `git show HEAD:<file>` for old content and reads the working-copy file for new content. For staged-only changes, `git diff --cached` output could be used, but for v1 we show working tree vs HEAD.
- For untracked files (status `?`), old content is empty string and new content is the file contents.
- For deleted files, new content is empty string and old content is `git show HEAD:<file>`.
- `getLog` runs `git log --format=<custom> --skip=<offset> -n <limit+1>` (request one extra to determine `hasMore`).
- `getCommitFileDiff` runs `git show <sha>:<file>` for new content and `git show <sha>~1:<file>` for old content.
- SHA parameters must be validated against `/^[a-f0-9]{4,40}$/i` to prevent command injection.

### 3.3 Endpoint Schemas

All endpoints accept `cwd` as a query parameter. The backend resolves the CWD from the active manager's profile — the frontend passes `agentId`, and the backend looks up `descriptor.cwd`.

| Endpoint | Method | Parameters | Response |
|----------|--------|------------|----------|
| `/api/git/status` | GET | `agentId` | `GitStatusResult` |
| `/api/git/diff` | GET | `agentId`, `file` | `GitDiffResult` |
| `/api/git/log` | GET | `agentId`, `limit?` (default 50), `offset?` (default 0) | `GitLogResult` |
| `/api/git/commit` | GET | `agentId`, `sha` | `GitCommitDetail` |
| `/api/git/commit-diff` | GET | `agentId`, `sha`, `file` | `GitDiffResult` |

**CWD resolution and security:**

```ts
function resolveCwdFromAgent(swarmManager: SwarmManager, agentId: string): string {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) throw new Error(`Unknown agent: ${agentId}`);

  // Walk up to the profile root manager if this is a session agent
  const effectiveDescriptor = descriptor.profileId
    ? swarmManager.getAgent(descriptor.profileId) ?? descriptor
    : descriptor;

  if (!effectiveDescriptor.cwd) throw new Error("No CWD configured for this agent");
  return effectiveDescriptor.cwd;
}
```

The CWD is always derived from the agent descriptor — the client never passes an arbitrary path. This prevents path traversal attacks. Git commands are always executed with `cwd` set to the resolved directory.

**Error responses** follow existing patterns: `{ error: string }` with appropriate HTTP status codes (400 for bad params, 404 for unknown agent/file, 500 for git errors).

### 3.4 Caching Strategy

Caching is handled entirely on the frontend via TanStack Query (§4.4). The backend is stateless per request — each call invokes `git` fresh. This is appropriate because:

- Git operations against a local repo are fast (~5–50ms for status/diff)
- Working directory state changes unpredictably (agents editing files)
- Committed history is immutable, so frontend caching with `staleTime: Infinity` is correct
- No backend memory overhead from caching diff content

### 3.5 Large Diff Safety

The backend enforces limits to prevent OOM or excessive response sizes:

- **File content cap:** If either side of a diff exceeds 1MB, return `{ truncated: true, reason: "file_too_large" }` instead of content.
- **Status cap:** If `git status` reports >500 files, return the first 500 with `{ truncated: true, totalFiles: N }`.
- **Log cap:** Maximum `limit` parameter is 200 per request.
- **Diff stat cap:** `git diff --stat` output is limited to summary only for >100 files.

---

## 4. Frontend Design

### 4.1 Dialog Integration

**Trigger button** goes in `ChatHeader.tsx`, positioned between the three-dot menu and the artifacts panel toggle. Following the existing pattern:

```tsx
// In ChatHeader, new prop:
interface ChatHeaderProps {
  // ... existing props ...
  onOpenDiffViewer?: () => void;
  diffViewerDisabled?: boolean;   // true when no CWD configured
}
```

**Icon:** Lucide `GitCompareArrows` or `FileDiff`. Tooltip: `"View Changes (⌘⇧D)"`.

**State ownership:** The dialog open/close state lives in `routes/index.tsx`, matching how `isArtifactsPanelOpen` is managed. The `DiffViewerDialog` component is rendered at the route level, not inside `ChatHeader`.

```tsx
// In routes/index.tsx:
const [isDiffViewerOpen, setIsDiffViewerOpen] = useState(false);

// Keyboard shortcut registration:
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      setIsDiffViewerOpen(prev => !prev);
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

### 4.2 Dialog Container

Use the existing Radix Dialog primitive from `apps/ui/src/components/ui/dialog.tsx`, but with custom sizing similar to `ContentZoomDialog.tsx` (which already uses `w-[min(95vw,1600px)]` and `h-[min(92vh,1400px)]`):

```tsx
<Dialog open={isDiffViewerOpen} onOpenChange={setIsDiffViewerOpen}>
  <DialogContent
    className="flex h-[92vh] w-[95vw] max-w-none flex-col gap-0 p-0"
    aria-label="Diff viewer"
  >
    {/* Full dialog content */}
  </DialogContent>
</Dialog>
```

**Key property:** `modal={true}` (the default) — unlike the artifact panel which uses `modal={false}`. The diff viewer is a focused inspection tool; blocking chat interaction while open is acceptable and simplifies focus management.

### 4.3 Component Hierarchy

All new components go in `apps/ui/src/components/diff-viewer/`:

```
apps/ui/src/components/diff-viewer/
├── DiffViewerDialog.tsx          # Top-level dialog wrapper
├── DiffDialogHeader.tsx          # Tab switcher, repo info, controls
├── DiffStatusBar.tsx             # Bottom summary bar
├── ChangesView.tsx               # Changes tab layout (file list + diff pane)
├── HistoryView.tsx               # History tab layout (commits + files + diff pane)
├── FileList.tsx                  # Reusable file list with status badges
├── CommitList.tsx                # Commit list for history tab
├── DiffPane.tsx                  # Wrapper around react-diff-viewer-continued
├── FileStatusBadge.tsx           # Colored M/A/D/R badges
├── diff-viewer-theme.ts          # Theme configuration for react-diff-viewer-continued
└── use-diff-queries.ts           # TanStack Query hooks for all git endpoints
```

### 4.4 State Management

**TanStack Query** for all data fetching. Custom hooks in `use-diff-queries.ts`:

```ts
// Working directory status — relatively short stale time since files change
export function useGitStatus(agentId: string | null) {
  return useQuery({
    queryKey: ['git', 'status', agentId],
    queryFn: () => fetchGitStatus(agentId!),
    enabled: !!agentId,
    staleTime: 10_000,           // 10s — working dir changes frequently
    refetchOnWindowFocus: true,  // Re-check when user returns to Forge
  });
}

// File diff for changes view — moderate stale time
export function useGitFileDiff(agentId: string | null, file: string | null) {
  return useQuery({
    queryKey: ['git', 'diff', agentId, file],
    queryFn: () => fetchGitFileDiff(agentId!, file!),
    enabled: !!agentId && !!file,
    staleTime: 10_000,
  });
}

// Commit log — long stale time (history rarely changes while viewing)
export function useGitLog(agentId: string | null, limit: number, offset: number) {
  return useQuery({
    queryKey: ['git', 'log', agentId, limit, offset],
    queryFn: () => fetchGitLog(agentId!, limit, offset),
    enabled: !!agentId,
    staleTime: 60_000,           // 1 min
  });
}

// Commit detail and diff — immutable, cache forever
export function useGitCommitDetail(agentId: string | null, sha: string | null) {
  return useQuery({
    queryKey: ['git', 'commit', agentId, sha],
    queryFn: () => fetchGitCommitDetail(agentId!, sha!),
    enabled: !!agentId && !!sha,
    staleTime: Infinity,         // committed data never changes
  });
}

export function useGitCommitFileDiff(agentId: string | null, sha: string | null, file: string | null) {
  return useQuery({
    queryKey: ['git', 'commit-diff', agentId, sha, file],
    queryFn: () => fetchGitCommitFileDiff(agentId!, sha!, file!),
    enabled: !!agentId && !!sha && !!file,
    staleTime: Infinity,
  });
}
```

**Local component state** for:
- Active tab (Changes | History)
- Selected file in file list
- Selected commit in commit list
- View mode (unified | split)
- File filter text
- Scroll positions (per-file, preserved on file switch)

### 4.5 Theming

The diff viewer must respect Forge's dark/light theme. The existing theme system uses a `dark` class on `<html>` with CSS custom properties (see `apps/ui/src/styles.css` and `apps/ui/src/lib/theme.ts`).

`react-diff-viewer-continued` supports custom styles via a `styles` prop and a `useDarkTheme` boolean. Create a theme configuration file:

**`diff-viewer-theme.ts`:**

```ts
// Dark theme colors aligned with Forge's design tokens
export const forgeDiffDarkStyles = {
  variables: {
    dark: {
      diffViewerBackground: 'hsl(0 0% 7%)',       // matches --background
      addedBackground: 'hsl(140 30% 12%)',
      removedBackground: 'hsl(0 30% 14%)',
      wordAddedBackground: 'hsl(140 40% 18%)',
      wordRemovedBackground: 'hsl(0 40% 20%)',
      addedGutterBackground: 'hsl(140 25% 10%)',
      removedGutterBackground: 'hsl(0 25% 12%)',
      gutterBackground: 'hsl(0 0% 10%)',
      gutterColor: 'hsl(0 0% 40%)',
      codeFoldBackground: 'hsl(220 20% 14%)',
      codeFoldGutterBackground: 'hsl(220 15% 12%)',
      codeFoldContentColor: 'hsl(220 20% 55%)',
      addedColor: 'hsl(140 60% 75%)',
      removedColor: 'hsl(0 60% 75%)',
    },
  },
  codeFold: {
    fontSize: '12px',
  },
  line: {
    fontSize: '13px',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
};

// Light theme equivalent
export const forgeDiffLightStyles = { ... };

// Hook to select correct styles based on current theme
export function useDiffTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    styles: isDark ? forgeDiffDarkStyles : forgeDiffLightStyles,
    useDarkTheme: isDark,
  };
}
```

Colors are from the UX research document (§5.1), adjusted to harmonize with Forge's existing CSS custom property palette.

---

## 5. Layout Specifications

### 5.1 Changes Tab

```
┌───────────────────────────────────────────────────────────────────┐
│ [Changes] [History]  ·  forge  ·  ⎇ main  · [⇄] [↻] [unified▾] [×]  │
├──────────────┬────────────────────────────────────────────────────┤
│              │ ┌────────────────────────────────────────────────┐ │
│  🔍 Filter   │ │  src/components/chat/ChatHeader.tsx            │ │
│              │ ├────────────────────────────────────────────────┤ │
│  M Chat.tsx  │ │  @@ -45,7 +45,9 @@ function ChatMessage()     │ │
│  A New.tsx   │ │  45│ 45│  const [msg, setMsg] = ...         │ │
│  D Old.tsx   │ │  46│   │- const old = getValue()            │ │
│  R Prev→Cur  │ │    │ 46│+ const val = getNewValue()          │ │
│              │ │  47│ 47│  return <div>{val}</div>           │ │
│              │ │                                                │ │
│              │ │  ─── Expand 12 lines ───                      │ │
│              │ │                                                │ │
│  3 changed   │ │  @@ -120,3 +122,5 @@ export default Chat      │ │
│  +24 / -8    │ │  ...                                           │ │
├──────────────┴────────────────────────────────────────────────────┤
│  3 files changed, 24 insertions(+), 8 deletions(-)               │
└───────────────────────────────────────────────────────────────────┘
```

- **Left panel:** Fixed 250px width. Contains filter input, scrollable file list, and change summary.
- **Right panel:** Remaining width. Sticky file path header + diff content.
- **File list items:** File name (truncated with tooltip for long paths), status badge, +/- counts.
- **No checkboxes** in v1 (see §10.5).

### 5.2 History Tab

```
┌───────────────────────────────────────────────────────────────────┐
│ [Changes] [History]  ·  forge  ·  ⎇ main  · [↻] [unified▾] [×]      │
├──────────────┬──────────────┬─────────────────────────────────────┤
│ Commit List  │ Files in     │ Diff of selected file               │
│              │ commit       │                                     │
│ • fix: typo  │ M Chat.tsx   │ @@ -10,3 +10,5 @@                  │
│   2 min ago  │ A Helper.tsx │ ...                                 │
│              │ D Legacy.tsx │                                     │
│ • feat: new  │              │                                     │
│   1 hour ago │              │                                     │
│              │              │                                     │
│ ──────────── │              │                                     │
│ Load more... │              │                                     │
├──────────────┴──────────────┴─────────────────────────────────────┤
│  abc1234 · Adam · 2 min ago · 3 files, +12 / -4                   │
└───────────────────────────────────────────────────────────────────┘
```

- **Left panel:** 220px. Commit list with message (first line, truncated), author, relative time.
- **Center panel:** 200px. File list for selected commit.
- **Right panel:** Remaining width. Diff content.
- **Commit list:** Shows `limit` entries with a "Load more" button at bottom (cursor-based pagination).

### 5.3 Responsive Behavior

| Viewport Width | Behavior |
|---|---|
| ≥1200px | Full three-panel History layout |
| 1000–1199px | History collapses to two panels — commit list + diff, with files shown as a dropdown/popover in the diff pane header |
| <1000px | Dialog expands to 100vw × 100vh; panels stack vertically with collapsible sections |

The Changes tab is always two-panel (file list + diff), which works down to ~800px.

---

## 6. Library Integration

### 6.1 react-diff-viewer-continued Setup

**Install in `apps/ui`:**

```bash
cd apps/ui && pnpm add react-diff-viewer-continued
```

**Usage in `DiffPane.tsx`:**

```tsx
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useDiffTheme } from './diff-viewer-theme';

interface DiffPaneProps {
  oldContent: string;
  newContent: string;
  fileName: string;
  splitView: boolean;
}

export function DiffPane({ oldContent, newContent, fileName, splitView }: DiffPaneProps) {
  const { styles, useDarkTheme } = useDiffTheme();

  return (
    <div className="flex-1 overflow-auto">
      <div className="sticky top-0 z-10 border-b border-border/60 bg-card px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
      </div>
      <ReactDiffViewer
        oldValue={oldContent}
        newValue={newContent}
        splitView={splitView}
        useDarkTheme={useDarkTheme}
        styles={styles}
        compareMethod={DiffMethod.WORDS}
        extraLinesSurroundingDiff={3}
        showDiffOnly={true}
        codeFoldMessageRenderer={(totalLines) =>
          `Expand ${totalLines} unchanged lines`
        }
      />
    </div>
  );
}
```

### 6.2 Input Format

`react-diff-viewer-continued` accepts `oldValue` and `newValue` strings (not unified diff patches). The backend provides these directly:

- **Changes view:** `oldContent` = file at HEAD (`git show HEAD:<file>`), `newContent` = working tree file contents.
- **History view:** `oldContent` = file at `sha~1`, `newContent` = file at `sha`.
- **Added files:** `oldContent = ""`, `newContent = <file contents>`.
- **Deleted files:** `oldContent = <file contents>`, `newContent = ""`.

This is a deliberate choice. While `react-diff-view` accepts raw unified diff natively, `react-diff-viewer-continued` provides superior React integration, built-in dark theme, word-level highlighting, and code folding with less configuration overhead.

### 6.3 Syntax Highlighting

Defer syntax highlighting to Phase 2. When added, use `react-diff-viewer-continued`'s `renderContent` prop with `Prism.js`:

```tsx
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
// ... additional languages as needed

renderContent={(source) => {
  const language = detectLanguage(fileName);
  const highlighted = Prism.highlight(source, Prism.languages[language] || Prism.languages.plain, language);
  return <pre dangerouslySetInnerHTML={{ __html: highlighted }} />;
}}
```

Language detection is by file extension. Start with TypeScript/JavaScript/JSON/CSS/HTML/Markdown — the most common in Forge repos.

---

## 7. Performance

### 7.1 Large Diff Handling

| Threshold | Behavior |
|---|---|
| File >5,000 lines changed | Show collapsed message: "Large diff — X lines changed. Click to expand." User opt-in only. |
| File >1MB (either side) | Backend returns `truncated: true`. UI shows: "File too large to display." |
| >100 changed files (Changes tab) | Virtualize file list with `@tanstack/react-virtual` |
| >200 commits requested | Backend caps at 200; frontend uses "Load more" pagination |
| >500 changed files (Status) | Backend truncates; UI shows: "Showing 500 of N files" |

### 7.2 Progressive Loading

- **File list loads first.** The status/commit-files endpoint is lightweight; diff content is fetched only when a file is selected.
- **One diff at a time.** Only the selected file's diff is in memory. Switching files triggers a new query (TanStack Query caches the result for quick re-selection).
- **Commit list paginates.** Load 50 commits initially, "Load more" button fetches the next page.

### 7.3 Perceived Performance

- **Skeleton loaders** for file list and diff pane while data loads.
- **Optimistic file selection:** Immediately highlight the selected file in the list; show loading state in diff pane.
- **Background prefetch:** When hovering over a file in the list for >200ms, prefetch its diff content.

### 7.4 Web Worker Diff Computation — Deferred

`react-diff-viewer-continued` computes diffs internally using `diff`. For very large files, this can block the main thread. Web Worker offloading is deferred to a future phase; the 5,000-line threshold (§7.1) mitigates the worst cases in v1.

---

## 8. Accessibility

### 8.1 Focus Management

- **On open:** Focus moves to the tab switcher (Changes/History tabs).
- **On close (Escape or button):** Focus returns to the diff viewer trigger button in `ChatHeader`.
- **On file selection:** Focus description updates (`aria-live`), but focus stays in the file list for keyboard browsing.
- **Focus trapping:** Handled automatically by Radix Dialog.

### 8.2 Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Anywhere in dialog | Close diff viewer |
| `Tab` / `Shift+Tab` | Dialog | Cycle between file list, diff pane, controls |
| `↑` / `↓` | File list or commit list | Navigate items |
| `Enter` | File/commit list | Select item, load diff |
| `[` / `]` | Diff pane focused | Previous / next file |
| `Ctrl+Shift+D` / `⌘⇧D` | Global | Toggle diff viewer open/close |

Hunk navigation (`n`/`N`) and in-diff search (`Ctrl+F`) are deferred to Phase 2.

### 8.3 ARIA Annotations

- **Dialog:** `role="dialog"`, `aria-label="Diff viewer"` — provided by Radix Dialog.
- **Tab switcher:** Radix Tabs handles `role="tablist"` / `role="tab"` / `role="tabpanel"`.
- **File list:** `role="listbox"` with `role="option"` per item. Each option includes `aria-label` with file name, status, and change counts (e.g., "ChatHeader.tsx, modified, 24 additions, 8 deletions").
- **Diff pane:** `role="region"` with `aria-label="Diff view for {filename}"`.
- **Status bar:** `aria-live="polite"` for summary updates on file/commit selection.
- **Commit list:** `role="listbox"` with commit message, author, and time in `aria-label`.

---

## 9. Implementation Phases

### Phase 1 — Backend Endpoints + Dialog Shell

**New files:**
- `apps/backend/src/ws/routes/git-diff-routes.ts` — HTTP route handlers
- `apps/backend/src/ws/routes/git-diff-service.ts` — Git operations service

**Modified files:**
- `apps/backend/src/ws/server.ts` — Register `createGitDiffRoutes` in `httpRoutes` array

**Deliverable:** All five endpoints (`/api/git/status`, `/api/git/diff`, `/api/git/log`, `/api/git/commit`, `/api/git/commit-diff`) functional and testable via curl.

**Test checkpoint:**
- `curl /api/git/status?agentId=<id>` returns file list with statuses
- `curl /api/git/diff?agentId=<id>&file=<path>` returns oldContent/newContent
- `curl /api/git/log?agentId=<id>&limit=10` returns commit list
- SHA validation rejects non-hex strings
- Non-existent agent returns 404
- Agent with no CWD returns 400
- Large file returns truncated response

**Risk:** Low. Additive-only — new routes, no modification to existing code beyond registration.

**Depends on:** Nothing.

---

### Phase 2 — Changes Tab (Frontend MVP)

**New files:**
- `apps/ui/src/components/diff-viewer/DiffViewerDialog.tsx`
- `apps/ui/src/components/diff-viewer/DiffDialogHeader.tsx`
- `apps/ui/src/components/diff-viewer/DiffStatusBar.tsx`
- `apps/ui/src/components/diff-viewer/ChangesView.tsx`
- `apps/ui/src/components/diff-viewer/FileList.tsx`
- `apps/ui/src/components/diff-viewer/DiffPane.tsx`
- `apps/ui/src/components/diff-viewer/FileStatusBadge.tsx`
- `apps/ui/src/components/diff-viewer/diff-viewer-theme.ts`
- `apps/ui/src/components/diff-viewer/use-diff-queries.ts`

**Modified files:**
- `apps/ui/src/components/chat/ChatHeader.tsx` — Add diff viewer button + prop
- `apps/ui/src/routes/index.tsx` — Add dialog state, keyboard shortcut, render `DiffViewerDialog`

**New dependency:**
- `react-diff-viewer-continued` (install in `apps/ui`)

**Deliverable:** Working Changes tab — file list, file selection, diff rendering, dark/light theme, filter input, status bar.

**Test checkpoint:**
- Button appears in ChatHeader with correct icon/tooltip
- `⌘⇧D` opens/closes the dialog
- File list populates from working directory changes
- Clicking a file shows its diff
- Unified view renders correctly with word-level highlighting
- Empty state shown when no changes exist
- Theme follows dark/light system preference
- Escape closes dialog, focus returns to trigger button

**Risk:** Medium. New UI dependency (`react-diff-viewer-continued`) — verify React 19 compatibility before committing. The library's GitHub issues should be checked for known React 19 regressions.

**Depends on:** Phase 1 (backend endpoints must exist).

---

### Phase 3 — History Tab

**New files:**
- `apps/ui/src/components/diff-viewer/HistoryView.tsx`
- `apps/ui/src/components/diff-viewer/CommitList.tsx`

**Modified files:**
- `apps/ui/src/components/diff-viewer/DiffViewerDialog.tsx` — Wire History tab
- `apps/ui/src/components/diff-viewer/use-diff-queries.ts` — Add log/commit queries

**Deliverable:** Working History tab — commit list, file list per commit, diff rendering, "Load more" pagination.

**Test checkpoint:**
- Tab switching between Changes and History works
- Commit list shows messages, authors, relative times
- Clicking commit loads its file list
- Clicking file in commit loads diff
- "Load more" fetches next page of commits
- Committed diffs are cached (no refetch on re-selection)

**Risk:** Low. Reuses `DiffPane` and `FileList` from Phase 2. Data flow is the same pattern.

**Depends on:** Phase 2.

---

### Phase 4 — Split View + Polish

**Modified files:**
- `apps/ui/src/components/diff-viewer/DiffDialogHeader.tsx` — Add view mode toggle
- `apps/ui/src/components/diff-viewer/DiffPane.tsx` — Pass `splitView` prop
- `apps/ui/src/components/diff-viewer/ChangesView.tsx` — Responsive behavior
- `apps/ui/src/components/diff-viewer/HistoryView.tsx` — Responsive three→two panel collapse

**Deliverable:** Split view toggle, responsive panel collapsing, syntax highlighting, keyboard file navigation (`[`/`]`).

**Test checkpoint:**
- Toggle between unified and split view
- Split view renders side-by-side with synchronized scrolling
- Responsive collapse works at 1000–1200px breakpoint
- `[` / `]` keys navigate between files

**Risk:** Low. `react-diff-viewer-continued` supports `splitView` as a boolean prop — trivial to wire up. Responsive behavior is CSS-only.

**Depends on:** Phase 3.

---

### Phase 5 — Performance Hardening (As Needed)

**Changes:**
- File list virtualization with `@tanstack/react-virtual` (if repos with >50 changed files are encountered)
- Large diff collapse UI (the 5,000-line threshold message)
- Hover-to-prefetch for file list items
- Commit list virtualization for long histories

**Depends on:** Phase 3. Triggered by real-world performance observations rather than speculative optimization.

---

### Parallelization Guidance

- **Phase 1 and Phase 2** can be worked in parallel by separate workers — backend routes have no UI dependency, and UI scaffolding can be built against mocked data initially.
- **Phase 3** depends on Phase 2 (reuses components).
- **Phase 4** depends on Phase 3 (both tabs must exist for the toggle to be meaningful).
- **Phase 5** is optional and triggered by need.

---

## 10. Open Questions — Resolved

### 10.1 Split View (Side-by-Side)

**Recommendation: Include as a toggle in v1, target Phase 4.**

Rationale: `react-diff-viewer-continued` supports split view via a single boolean prop (`splitView`). The implementation cost is a toggle button in the header and passing the prop through — trivially low. Side-by-side is the preferred view for many developers (GitHub Desktop's #1 feature request since 2016, desktop/desktop#172). Deferring it to v2 when it's essentially free to include would leave value on the table.

Default to **unified view** (matches GitHub Desktop's default and works better at narrower widths). Persist the user's preference in `localStorage`.

### 10.2 Commit Depth and Pagination

**Recommendation: Load 50 commits initially, "Load more" button pagination.**

Rationale: 50 commits covers the typical recent-work window. Infinite scroll adds scroll-position complexity and makes it hard to distinguish "loading" from "end of list." A simple "Load more" button is explicit and predictable.

The backend returns `hasMore: boolean` by requesting `limit + 1` entries and checking if the extra exists. Offset-based pagination (`skip` parameter) is simpler than cursor-based for git log since commit ordering is stable within a session.

### 10.3 Branch Selection

**Recommendation: Current branch only for v1.**

Rationale: Branch switching introduces significant complexity:
- Need a branch list endpoint
- Need to handle detached HEAD state
- Branch context affects both Changes and History views
- Risk of confusion if the viewer shows a different branch than the one agents are working on

The header displays the current branch name (informational). Users who need cross-branch comparison can use their existing git tools. Branch switching is a natural v2 enhancement.

### 10.4 Binary Files

**Recommendation: Placeholder text, no image preview for v1.**

Rationale: Image preview requires:
- Content-type detection
- Base64 encoding/transport
- A separate rendering component (not a diff view)
- Potentially large payloads for high-res images

For v1, binary files show: `"Binary file — cannot display diff"` with the file size. The file status badge still shows the change type (M/A/D). Image preview (with before/after comparison) is a strong v2 candidate.

Detection: The backend checks for null bytes in the first 8KB of file content to identify binary files, matching git's own heuristic.

### 10.5 Checkboxes in Changes Tab

**Recommendation: Hide checkboxes for v1.**

Rationale: Non-functional checkboxes violate the principle of least surprise — users will click them expecting staging behavior and be confused when nothing happens. The UX research notes that GitHub Desktop uses checkboxes for staging, which is a core write operation we're explicitly excluding from v1.

The file list item component should be designed to accept an optional checkbox slot so Phase 2 staging support can add them without restructuring the layout. But they should not render in v1.

### 10.6 Refresh Strategy

**Recommendation: Manual refresh button + auto-refresh on window focus.**

Rationale: Real-time auto-refresh (polling or WebSocket push) adds complexity disproportionate to value for v1:
- Polling creates unnecessary backend load
- WebSocket file-watch events would require a new file watcher subsystem
- Users working with agents already have a mental model of "check when ready"

Implementation:
- **Refresh button** (↻ icon) in the header — invalidates TanStack Query cache for the active view's data.
- **Refetch on window focus** — TanStack Query's `refetchOnWindowFocus: true` handles this automatically for the status query.
- Changes view data has `staleTime: 10s` — switching tabs or re-opening the dialog within 10s uses cached data, beyond that triggers a background refetch.

---

## 11. Risks and Mitigations

### 11.1 react-diff-viewer-continued React 19 Compatibility

**Risk:** The library may have undiscovered incompatibilities with React 19 (Forge's current React version).

**Mitigation:** Before committing to Phase 2 implementation, run a quick smoke test: install the library, render a simple diff with both unified and split views, and verify no runtime errors or hydration mismatches. If incompatible, fall back to `diff2html` with a `dangerouslySetInnerHTML` wrapper (documented as the backup in the UX research).

**Severity:** Medium. Would delay Phase 2 by the time needed to implement the diff2html fallback integration.

### 11.2 Large Repository Performance

**Risk:** Repos with thousands of changed files or very large diffs could cause slow responses or UI freezes.

**Mitigation:** Backend enforces hard limits (§3.5). Frontend uses progressive loading (§7.2) and large-diff collapse (§7.1). The 1MB file content cap and 500-file status cap prevent pathological cases.

**Severity:** Low with mitigations in place.

### 11.3 Git Not Installed or Not a Repo

**Risk:** The CWD may not be a git repository, or git may not be in PATH.

**Mitigation:** The `/api/git/status` endpoint should handle `git` errors gracefully:
- Not a git repo → `{ error: "not_a_git_repo", message: "..." }` → UI shows: "This directory is not a git repository."
- Git not found → `{ error: "git_not_found", message: "..." }` → UI shows: "Git is not installed or not in PATH."

The diff viewer button in the header could be disabled/hidden entirely if the initial status check fails with one of these errors.

**Severity:** Low. Error states are straightforward.

### 11.4 Agent CWD Changes While Dialog Is Open

**Risk:** If the user switches to a different agent/session while the diff viewer is open, the CWD context changes but the dialog may still show stale data from the previous agent's repo.

**Mitigation:** The dialog receives `agentId` as a prop. When `agentId` changes (agent switch), TanStack Query keys include `agentId`, so all queries automatically invalidate and refetch. The repo name and branch in the header update accordingly.

**Severity:** Low. TanStack Query's key-based caching handles this naturally.

### 11.5 Concurrent Agent File Modifications

**Risk:** Agents may be actively modifying files while the user is viewing diffs, causing the displayed diff to be stale.

**Mitigation:** This is acceptable for v1 — the diff viewer is a snapshot tool, not a live monitor. The refresh button and window-focus refetch provide manual recourse. The `staleTime: 10s` on Changes queries means re-selecting a file naturally picks up recent changes.

**Severity:** Low. Users understand that file state is a point-in-time snapshot.

### 11.6 Dialog Blocking Chat Interaction

**Risk:** The modal dialog blocks chat input, which contradicts the project decision that "Artifact/file sidebar must not block chat interaction."

**Mitigation:** The diff viewer is a distinct tool from the artifact panel. The artifact panel is a persistent sidebar opened alongside chat (hence `modal={false}`). The diff viewer is an inspection overlay — a focused, temporary context switch akin to a settings dialog. The user explicitly opens it, inspects changes, and closes it. If user feedback indicates that non-modal behavior is desired, the dialog can be converted to `modal={false}` with custom focus management (following the `ArtifactPanel.tsx` pattern), but this adds complexity and should be driven by actual user need.

**Severity:** Low. Modal behavior is the natural fit for a focused inspection tool.

---

## Appendix A: File-by-File Change Checklist

### Backend (Phase 1)
- [ ] `apps/backend/src/ws/routes/git-diff-service.ts` — **New file:** Git operations service
- [ ] `apps/backend/src/ws/routes/git-diff-routes.ts` — **New file:** HTTP route handlers
- [ ] `apps/backend/src/ws/server.ts` — Import and register `createGitDiffRoutes`

### Frontend (Phase 2–4)
- [ ] `apps/ui/package.json` — Add `react-diff-viewer-continued` dependency
- [ ] `apps/ui/src/components/diff-viewer/DiffViewerDialog.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/DiffDialogHeader.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/DiffStatusBar.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/ChangesView.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/HistoryView.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/FileList.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/CommitList.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/DiffPane.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/FileStatusBadge.tsx` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/diff-viewer-theme.ts` — **New file**
- [ ] `apps/ui/src/components/diff-viewer/use-diff-queries.ts` — **New file**
- [ ] `apps/ui/src/components/chat/ChatHeader.tsx` — Add diff viewer button + props
- [ ] `apps/ui/src/routes/index.tsx` — Dialog state, keyboard shortcut, render dialog

### Unchanged (verified)
- `packages/protocol/` — No changes needed (no new wire types)
- `apps/backend/src/versioning/git-cli.ts` — Reused as-is, not modified
- `apps/backend/src/swarm/` — No changes
- `apps/ui/src/lib/ws-client.ts` — No changes (HTTP-only, no WS commands)
- `apps/ui/src/lib/ws-state.ts` — No changes

---

## Appendix B: Dependency Assessment

| Package | Purpose | Bundle Impact | Risk |
|---------|---------|--------------|------|
| `react-diff-viewer-continued` | Diff rendering | ~45KB gzipped (includes `diff` lib) | Medium — verify React 19 compat |
| `@tanstack/react-virtual` (Phase 5) | List virtualization | ~5KB gzipped | Low — widely used, already in TanStack ecosystem |
| `prismjs` (Phase 4) | Syntax highlighting | ~15KB core + ~2KB per language | Low — mature, minimal |

No new backend dependencies. The existing `GitCli` class replaces the need for `simple-git`.

---

## Appendix C: Future Enhancements (Post-v1)

These are explicitly out of scope for v1 but documented for planning:

1. **Staging/unstaging** — Checkboxes in file list, `git add`/`git reset` endpoints
2. **Commit from UI** — Commit message input, `git commit` endpoint
3. **Branch comparison** — Branch selector dropdown, `git diff <branch1>..<branch2>`
4. **Image diff preview** — Before/after image rendering with swipe/onion-skin comparison
5. **Inline comments** — Anchor comments to diff lines, tie into chat/agent context
6. **File-watching auto-refresh** — Backend file watcher pushes change events via WebSocket
7. **Hunk revert** — "Revert this change" button per hunk (GitKraken-style)
8. **Search in diff** — Ctrl+F with custom search UI highlighting matches in diff content
9. **Minimap** — VS Code-style miniature file overview with change indicators
