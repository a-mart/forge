# File Browser — Design Document

> **Status:** DRAFT — Revised after design review
> **Date:** 2026-03-22
> **Research inputs:** `.internal/file-viewer-research.md`
> **Reference:** `project-docs/design/DIFF_VIEWER_DESIGN.md` (sister feature, same dialog pattern)
> **Scope:** Read-only file browser (v1) — tree navigation, syntax-highlighted viewing, image/markdown preview

---

## 1. Overview

### What This Is

A built-in file browser for Forge, triggered from the chat header. It provides:

1. **Tree navigation** — Lazy-loading, virtualized file tree with VS Code-quality file icons
2. **Syntax-highlighted viewer** — Line-numbered code viewing with highlight.js
3. **Markdown preview** — Rendered markdown with a raw source toggle
4. **Image preview** — Inline rendering for common image formats
5. **Breadcrumb navigation** — Click path segments to navigate the tree
6. **Open in editor** — One-click deep-link to VS Code/Cursor using existing editor preference

### User-Facing Value

Forge users frequently need to browse project files to understand context, verify agent outputs, or reference existing code — without leaving the UI. Today this requires switching to a terminal or editor. The file browser eliminates that context switch: open a full-screen overlay, navigate the tree, inspect files, and close it to continue chatting.

### Design Constraints

- **Read-only for v1.** No file editing, creating, or deleting.
- **Scoped to CWD** of the active manager session's profile.
- **Near-full-screen Radix Dialog** (~95vw × 92vh), matching the diff viewer pattern.
- **Git-aware listing** — respects `.gitignore`, falls back to hardcoded exclusions for non-git directories.
- **Lazy directory loading** — one level at a time on expand, never scans the full tree upfront.

---

## 2. Architecture

### Data Flow

```
┌──────────────┐     HTTP GET      ┌────────────────────────┐     fs / git     ┌─────────┐
│   React UI   │ ───────────────→  │  file-browser-routes   │ ──────────────→  │  disk   │
│  (Dialog)    │ ←───────────────  │  (backend)             │ ←──────────────  │         │
└──────────────┘     JSON          └────────────────────────┘                  └─────────┘
                                            │
                                   reuse /api/read-file
                                   for content loading
```

- **Frontend** opens the file browser dialog, issues HTTP requests via custom query hooks (same pattern as diff viewer).
- **Backend** exposes 3 new `/api/files/*` HTTP routes. File content loading reuses the existing `/api/read-file` endpoint.
- **No WebSocket commands needed.** File listing and content are request/response — HTTP GET is the right transport.
- **No protocol changes.** All types are route-local; nothing goes into `packages/protocol/`.

### Component Tree (High-Level)

```
ChatHeader
└── FileBrowserButton (new)  ──triggers──→  FileBrowserDialog

FileBrowserDialog (Radix Dialog, ~95vw × 92vh)
├── FileBrowserHeader
│   ├── RepoInfo (repo name + branch from root /api/files/list response)
│   ├── RefreshButton
│   └── CloseButton
├── Content area (horizontal split)
│   ├── FileTree (left panel, resizable ~260px)
│   │   ├── SearchInput
│   │   ├── TreeView (headless-tree + react-virtual)
│   │   │   └── FileTreeNode × N (icon + name, virtualized)
│   │   └── FileCountFooter ("2,881 files")
│   └── ContentPane (remaining width)
│       ├── FileContentHeader (breadcrumb path + copy + word-wrap + open-in-editor)
│       ├── FileContentViewer (syntax-highlighted code with line numbers)
│       │   OR MarkdownViewer (rendered markdown with raw toggle)
│       │   OR ImageViewer (inline image preview)
│       │   OR BinaryPlaceholder ("Binary file — cannot display")
│       │   OR EmptyState ("Select a file to view")
│       └── [no separate viewer for each — single component with mode switching]
└── FileStatusBar
    └── encoding · language · line count · file size
```

---

## 3. Backend Design

### 3.1 New Route + Service Files

**New files:**
- `apps/backend/src/ws/routes/file-browser-routes.ts` — HTTP route handlers (parameter parsing, response formatting)
- `apps/backend/src/ws/routes/file-browser-service.ts` — Core logic (filesystem listing, git metadata, ignore filtering)

Following the diff viewer's pattern (`git-diff-routes.ts` + `git-diff-service.ts`), the route layer handles HTTP concerns while the service encapsulates all fs/git logic. This makes the service independently testable and keeps route code focused on parameter handling.

```ts
// file-browser-service.ts
export class FileBrowserService {
  async listDirectory(cwd: string, relativePath: string): Promise<DirectoryListResult> { ... }
  async getFileCount(cwd: string): Promise<FileCountResult> { ... }
  async searchFiles(cwd: string, query: string, limit: number): Promise<FileSearchResult> { ... }
  async getRepoMeta(cwd: string): Promise<RepoMeta> { ... }
}
```

**Registration in `server.ts`:**

```ts
import { createFileBrowserRoutes } from "./routes/file-browser-routes.js";

// In constructor, add to httpRoutes array:
...createFileBrowserRoutes({ swarmManager: this.swarmManager }),
```

### 3.2 CWD Resolution

Extract the existing `resolveCwdFromAgent` from `git-diff-routes.ts` into a shared utility (e.g., `apps/backend/src/ws/routes/route-utils.ts`) so both the diff viewer routes and file browser routes import the same function. This avoids creating a third copy:

```ts
function resolveCwdFromAgent(swarmManager: SwarmManager, agentId: string): string {
  const descriptor = swarmManager.getAgent(agentId);
  if (!descriptor) throw new Error(`Unknown agent: ${agentId}`);

  const effectiveDescriptor = descriptor.profileId
    ? swarmManager.getAgent(descriptor.profileId) ?? descriptor
    : descriptor;

  if (!effectiveDescriptor.cwd || effectiveDescriptor.cwd.trim().length === 0) {
    throw new Error("No CWD configured for this agent");
  }

  return effectiveDescriptor.cwd;
}
```

The CWD is always derived from the agent descriptor — the client never passes an arbitrary root path. The `path` parameter in `/api/files/list` is resolved relative to the CWD using `path.resolve(cwd, requestedPath)` (never string concatenation), and the backend validates it stays within the CWD subtree using the same `isPathWithinRoots` check from `cwd-policy.ts` that `file-routes.ts` uses. The frontend always sends **repo-relative paths** (e.g., `src/components`); absolute path construction happens only on the server.

### 3.3 Endpoint Schemas

#### `GET /api/files/list`

Lists immediate children of a directory, sorted directories-first then alphabetical.

The root listing (path `""`) additionally includes repo metadata for the header.

```
Query params:
  agentId  (required) — resolves CWD
  path     (optional) — relative directory path from CWD, defaults to "" (root)

Response (200) — root listing (path="" or omitted):
{
  "cwd": "/Users/adam/repos/middleman",
  "path": "",
  "isGitRepo": true,
  "repoName": "middleman",
  "branch": "main",
  "entries": [
    { "name": "apps",        "type": "directory" },
    { "name": "packages",    "type": "directory" },
    { "name": "package.json","type": "file", "size": 1234 }
  ]
}

Response (200) — subdirectory listing:
{
  "cwd": "/Users/adam/repos/middleman",
  "path": "src/components",
  "entries": [
    { "name": "chat",     "type": "directory" },
    { "name": "ui",       "type": "directory" },
    { "name": "App.tsx",  "type": "file", "size": 1234 }
  ]
}
```

**Root path semantics:** The root is always represented as `""` (empty string) in API requests, responses, query cache keys, and tree item IDs. The server treats `""` and `"."` equivalently for `path.resolve()`, but the canonical wire format is `""`.

**Implementation — filesystem as source of truth, git as ignore filter:**

1. Resolve absolute directory path: `path.resolve(cwd, requestedPath)`.
2. Validate the resolved path is within CWD using `isPathWithinRoots`.
3. **Always use `readdir` with `withFileTypes: true`** as the source of truth for directory contents.
4. Determine git status: run `git rev-parse --show-toplevel` with the resolved dir as cwd. Cache the result for the request lifetime.
5. **If inside a git repo:**
   - For each entry from `readdir`, check if it should be excluded by running `git check-ignore -q <path>` (or batch with `git check-ignore --stdin`) against the entry paths. Exclude entries that git says are ignored.
   - Always exclude `.git` directory itself.
6. **If not a git repo:**
   - Filter out hardcoded exclusions: `node_modules`, `.git`, `.DS_Store`, `__pycache__`, `.next`, `.turbo`, `dist`, `.cache`, `coverage`, `.nyc_output`, `Thumbs.db`.
7. **Symlink handling:**
   - Symlinked files: include if the link target exists (skip broken symlinks).
   - Symlinked directories: include only if `realpath()` resolves to a path still within the CWD root. This prevents symlinks from escaping the project boundary. If `realpath()` is outside CWD, omit the entry silently.
8. **Permission errors:** If `readdir` or `stat` fails with `EACCES`/`EPERM` for a specific entry, omit that entry from results (don't fail the whole listing). If the requested directory itself is unreadable, return a structured error.
9. For each surviving entry: return `{ name, type: "file" | "directory", size? }`. Size is included for files only (via `stat`, optional — skip if stat fails).
10. Sort: directories first, then alphabetical (case-insensitive) within each group.
11. **For root listings only** (path is `""` or omitted): include `isGitRepo`, `repoName` (basename of git toplevel, or basename of CWD if not a git repo), and `branch` (from `git rev-parse --abbrev-ref HEAD`, or `null` for unborn HEAD / non-git).

**Empty/unborn repos:** This approach naturally handles repos with no commits yet (fresh `git init`) — `readdir` still works, and `git check-ignore` functions even without a HEAD. Branch may be `null` in this case.

**Error responses:**
- `400` — missing/invalid `agentId`
- `403` — path outside CWD (matches existing `file-routes.ts` convention for path security violations)
- `404` — unknown agent, directory not found
- `500` — filesystem error

#### `GET /api/files/count`

Returns total file count for the repo (used for the "N files" footer in the tree).

```
Query params:
  agentId  (required)

Response (200) — git repo:
{
  "count": 2881,
  "method": "git"
}

Response (200) — non-git:
{
  "count": 0,
  "method": "none"
}
```

**`count` is always a number** (0 for non-git, never `null`). The UI conditionally hides the footer when `method === "none"`.

**Implementation:**

- In git repos: run `git ls-files --cached --others --exclude-standard` via `execFile` (using `GitCli`, not a shell pipeline). Split the stdout by newlines and count in JavaScript. This includes both tracked and visible untracked files, matching what the tree actually displays.
- Non-git: return `{ count: 0, method: "none" }` — don't attempt a recursive scan.
- This endpoint is lightweight and cacheable on the frontend with a long stale time.

#### `GET /api/files/search`

Searches file paths by substring match (for the deep search feature).

```
Query params:
  agentId  (required)
  query    (required) — filename/path substring
  limit    (optional, default 50, max 200)

Response (200):
{
  "results": [
    { "path": "src/components/chat/ChatHeader.tsx", "type": "file" },
    { "path": "src/components/chat/ChatInput.tsx",  "type": "file" }
  ],
  "totalMatches": 12
}

Response (200) — non-git:
{
  "results": [],
  "totalMatches": 0,
  "unavailable": true
}
```

**Implementation:**

- In git repos: run `git ls-files --cached --others --exclude-standard` via `execFile` (not a shell pipeline). Split output by newlines in JS, then apply a case-insensitive substring filter on the `query`.
- Return matching file paths up to `limit`, plus `totalMatches` for the UI to show "showing N of M".
- Non-git: return `{ results: [], totalMatches: 0, unavailable: true }`. UI shows "Search requires a git repository."

**Security note:** The `query` parameter is used for in-process string matching against `git ls-files` output — it is **never** interpolated into a shell command. Git commands use the fixed form `git ls-files --cached --others --exclude-standard` with `cwd` set to the resolved directory.

### 3.4 Reusing `/api/read-file`

File content loading reuses the existing `/api/read-file` endpoint from `file-routes.ts`. The frontend sends **repo-relative paths** with the `agentId`, and the backend resolves them to absolute paths server-side using the agent's CWD.

Key characteristics already handled by the existing endpoint:
- **2 MB file size cap** (`MAX_READ_FILE_CONTENT_BYTES`) — covers virtually all source files
- **Path security** — `resolveFileAccessContext` validates paths against allowed roots
- **Agent-scoped CWD resolution** — uses `agentId` to resolve relative paths

For the file browser, the frontend sends the repo-relative path from the tree (e.g., `src/components/ChatHeader.tsx`) to `/api/read-file` via GET (for raw binary response, used for images) or POST (for JSON response with string content, used for text files). The backend resolves this relative to the agent's CWD. The frontend **never constructs absolute paths** — this keeps the client scoped to repo-relative navigation and avoids cross-platform path issues.

### 3.5 Binary and Image File Detection

**Binary detection happens server-side.** The existing `/api/read-file` POST endpoint reads the file as UTF-8, which corrupts binary data and makes client-side null-byte sniffing unreliable.

For the file browser content flow, add a `binary` check to the `/api/read-file` POST response:

1. Read the raw buffer first (before UTF-8 decode).
2. Sniff the first 8 KB for null bytes (`\0`).
3. If binary, return `{ path, content: null, binary: true, size: <bytes> }` — no UTF-8 decode attempted.
4. If text, decode as UTF-8 and return `{ path, content, binary: false }`.

This can be gated behind a query param (e.g., `?detectBinary=true`) so existing callers are unaffected, or applied unconditionally since `content: null` is a clear signal.

**Image detection** happens client-side by file extension before loading:
- Supported image extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg` — these are the types the existing `resolveReadFileContentType()` in `http-utils.ts` maps to real content types. (`ico` and `bmp` are not supported by the content-type resolver and are excluded.)
- For image files, the frontend uses `/api/read-file` via GET (which returns raw bytes with the correct `Content-Type`) and renders as `<img src={url}>`. The URL uses the repo-relative path + `agentId` as query params.

### 3.6 Route Helper Utilities

Follow the `handleGet` / `requireNonEmptyQuery` / `parseNumberParam` / `resolveHttpStatusCode` patterns from `git-diff-routes.ts`. These utilities can be duplicated (they're small and self-contained) or extracted into a shared `route-utils.ts` module if both route files benefit.

---

## 4. Frontend Design

### 4.1 Dialog Integration

**Trigger button** goes in `ChatHeader.tsx`, positioned adjacent to the existing diff viewer button in the inline actions group:

```tsx
// New icon: FolderTree from lucide-react (or FolderOpen)
// Position: before the diff viewer button in the inline actions div
{onOpenFileBrowser && fileBrowserAvailable ? (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          onClick={onOpenFileBrowser}
          aria-label="Browse Files (⌘⇧E)"
        >
          <FolderOpen className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        Browse Files (⌘⇧E)
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
) : null}
```

**New ChatHeader props:**

```ts
onOpenFileBrowser?: () => void
fileBrowserAvailable?: boolean  // false when no CWD configured
```

### 4.2 Keyboard Shortcut

**`⌘⇧E` / `Ctrl+Shift+E`** — "Explorer", matching VS Code's sidebar toggle.

Existing shortcuts in `routes/index.tsx`:
- `⌘⇧D` — Diff viewer toggle

The `E` shortcut is free. Registration in `routes/index.tsx`:

```ts
// Keyboard shortcut: ⌘⇧E / Ctrl+Shift+E to toggle file browser
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Don't fire when user is typing in an input, textarea, or contenteditable
    const target = e.target as HTMLElement | null
    if (
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'SELECT' ||
      target?.isContentEditable
    ) {
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
      e.preventDefault()
      setIsFileBrowserOpen((prev) => !prev)
    }
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}, [])
```

### 4.3 State Ownership

Dialog state lives in `routes/index.tsx`, matching the diff viewer pattern:

```ts
const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false)
```

The `FileBrowserDialog` component is rendered at the route level, alongside `DiffViewerDialog`:

```tsx
<FileBrowserDialog
  open={isFileBrowserOpen}
  onOpenChange={setIsFileBrowserOpen}
  wsUrl={wsUrl}
  agentId={activeAgentId}
/>
```

### 4.4 Component Hierarchy

All new components go in `apps/ui/src/components/file-browser/`:

```
apps/ui/src/components/file-browser/
├── FileBrowserDialog.tsx          # Full-screen dialog shell (same pattern as DiffViewerDialog)
├── FileBrowserHeader.tsx          # Header bar: repo name, branch, refresh, close
├── FileTree.tsx                   # Tree sidebar: search + headless-tree + virtualized rows
├── FileTreeNode.tsx               # Individual tree node: icon + name + expand chevron
├── FileContentViewer.tsx          # Content area: syntax code, markdown, image, binary, empty state
├── FileContentHeader.tsx          # Breadcrumb path + copy path + word-wrap toggle + open-in-editor
├── FileStatusBar.tsx              # Bottom bar: encoding, language, line count, file size
├── FileIcon.tsx                   # File/folder icon component (material-icon-theme)
├── MarkdownPreview.tsx            # Rendered markdown with raw source toggle
├── ImagePreview.tsx               # Inline image preview
├── use-file-browser-queries.ts    # Custom query hooks (list, count, search, content)
├── file-browser-icons.ts          # material-icon-theme manifest wrapper + icon resolution
└── file-browser.css               # Scoped styles (scrollbars, line numbers, tree theming)
```

### 4.5 State Management

**Custom query hooks** in `use-file-browser-queries.ts`, following the same `useSimpleQuery` pattern from `use-diff-queries.ts`.

**All queries are gated on dialog-open state** using the `open ? agentId : null` pattern (same as the diff viewer in `DiffViewerDialog.tsx`). This prevents background fetches when the dialog is closed.

```ts
// Directory listing — moderate stale time (directory contents change as agents work)
// The `agentId` param should be `open ? actualAgentId : null` to gate on dialog visibility.
export function useFileList(wsUrl: string, agentId: string | null, dirPath: string) {
  return useSimpleQuery<FileListResult>(
    `files:list:${agentId}:${dirPath}`,
    () => fetchFileBrowserApi<FileListResult>(wsUrl, '/api/files/list', { agentId: agentId!, path: dirPath }),
    { enabled: !!agentId, staleTime: 30_000 },
  )
}

// File count — long stale time (changes slowly)
export function useFileCount(wsUrl: string, agentId: string | null) {
  return useSimpleQuery<FileCountResult>(
    `files:count:${agentId}`,
    () => fetchFileBrowserApi<FileCountResult>(wsUrl, '/api/files/count', { agentId: agentId! }),
    { enabled: !!agentId, staleTime: 120_000 },
  )
}

// File search — no caching (query changes constantly)
export function useFileSearch(wsUrl: string, agentId: string | null, query: string) {
  return useSimpleQuery<FileSearchResult>(
    `files:search:${agentId}:${query}`,
    () => fetchFileBrowserApi<FileSearchResult>(wsUrl, '/api/files/search', { agentId: agentId!, query }),
    { enabled: !!agentId && query.length >= 2, staleTime: 10_000 },
  )
}

// File content — uses /api/read-file via POST (sends repo-relative path, not absolute)
export function useFileContent(wsUrl: string, agentId: string | null, filePath: string | null) {
  return useSimpleQuery<FileContentResult>(
    `files:content:${agentId}:${filePath}`,
    () => fetchFileContent(wsUrl, agentId!, filePath!),
    { enabled: !!agentId && !!filePath, staleTime: 15_000 },
  )
}
```

In `FileBrowserDialog.tsx`, the gating pattern looks like:

```ts
const gatedAgentId = open ? agentId : null
const rootList = useFileList(wsUrl, gatedAgentId, '')
const fileCount = useFileCount(wsUrl, gatedAgentId)
// ... all other queries use gatedAgentId
```

**Local component state** for:
- Selected file path (null = empty state)
- Expanded directory set (for tree state)
- Search/filter input text
- Search mode (`'filter'` for local tree filter, `'search'` for deep backend search)
- Word-wrap toggle (persisted in localStorage)
- Markdown raw/rendered toggle
- Scroll positions (per-file, managed by the content viewer)

### 4.6 Dialog Container

Same Radix Dialog primitive pattern as `DiffViewerDialog.tsx`:

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogPortal>
    <DialogOverlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-[2px] ..." />
    <DialogPrimitive.Content
      className={cn(
        'file-browser',
        'fixed left-1/2 top-1/2 z-[101] flex h-[92vh] w-[95vw] max-w-[1800px]',
        '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border',
        'bg-background shadow-[0_16px_80px_rgba(0,0,0,0.5)] outline-none',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
      )}
      aria-label="File browser"
      onEscapeKeyDown={(e) => { e.preventDefault(); onOpenChange(false); }}
    >
      <DialogTitle className="sr-only">File Browser</DialogTitle>
      {/* Header + Content + Status Bar */}
    </DialogPrimitive.Content>
  </DialogPortal>
</Dialog>
```

**Modal behavior:** `modal={true}` (default) — same rationale as the diff viewer. The file browser is a focused inspection tool; blocking chat interaction while open is acceptable.

---

## 5. Layout Specifications

### 5.1 Main Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  📁 File Browser    middleman  ⎇ main                    [↻]  [×]  │  ← Header (repoName + branch from root list)
├───────────────┬─────────────────────────────────────────────────────┤
│ 🔍 Search...  │  src › components › chat › ChatHeader.tsx  📋  📝  │  ← Search + Breadcrumb + actions
├───────────────┼─────────────────────────────────────────────────────┤
│ 📁 apps/      │   1 │ import { GitBranch, Menu } from 'lucide'    │
│   📁 backend/ │   2 │ import { Button } from '@/components/...'   │
│   📁 ui/      │   3 │                                              │
│     📁 src/   │   4 │ export function ChatHeader({                 │
│       📁 comp │   5 │   connected,                                 │
│         📁 ch │   6 │   activeAgentId,                             │
│           ◉ C │   7 │   ...props                                   │
│           Chat│   8 │ }: ChatHeaderProps) {                        │
│         📁 di │   9 │   return (                                   │
│         📁 ui │  10 │     <header className="sticky ...">          │
│     📁 lib/   │     │                                              │
│ 📁 packages/  │     │                                              │
│ 📄 package.js │     │                                              │
│               │     │                                              │
│  2,881 files  │     │                                              │
├───────────────┴─────────────────────────────────────────────────────┤
│  UTF-8 · TypeScript · 245 lines · 8.2 KB                          │  ← Status bar
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 Panel Sizing

- **Tree sidebar:** Resizable via `useResizablePanel` (from `apps/ui/src/components/diff-viewer/useResizablePanel.ts`).
  - Default: 260px
  - Min: 180px
  - Max: 450px
  - Storage key: `'file-browser-tree-width'`
- **Content pane:** Remaining width (`flex-1`).
- **Resize handle:** 4px draggable divider between panels, same pattern as diff viewer's `ChangesView.tsx`.

### 5.3 Tree Sidebar Structure

```
┌─────────────────┐
│ 🔍 Filter...    │  ← Search/filter input
├─────────────────┤
│                  │
│  (virtualized    │  ← @tanstack/react-virtual rows
│   tree nodes)    │
│                  │
│                  │
├─────────────────┤
│  2,881 files     │  ← File count footer
└─────────────────┘
```

### 5.4 Content Viewer Modes

The content pane switches between five modes based on the selected file:

| Mode | Trigger | Rendering |
|------|---------|-----------|
| **Empty state** | No file selected | "Select a file to view" centered message |
| **Code viewer** | Text file (non-markdown) | Syntax-highlighted with line numbers |
| **Markdown viewer** | `.md`, `.mdx`, `.markdown` files | Rendered markdown (default) with raw toggle |
| **Image viewer** | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg` | Centered `<img>` with natural dimensions |
| **Binary placeholder** | Binary file detected | "Binary file — N KB" centered message |

### 5.5 Responsive Behavior

| Viewport Width | Behavior |
|---|---|
| ≥1000px | Standard two-panel layout |
| <1000px | Dialog expands to 100vw × 100vh; tree panel collapses to a slide-over (hamburger toggle in content header) |

---

## 6. File Tree Integration

### 6.1 Library Setup

**@headless-tree/react** with **@tanstack/react-virtual** for virtualization.

Install in `apps/ui`:

```bash
cd apps/ui && pnpm add @headless-tree/core @headless-tree/react @tanstack/react-virtual
```

### 6.2 Tree Data Model

The tree uses headless-tree's **async data loading** feature. Each directory node lazily fetches its children from `/api/files/list` on expand.

```ts
interface FileTreeItem {
  /** Unique ID: relative path from CWD (e.g., "src/components/chat") */
  id: string
  /** Display name (basename) */
  name: string
  /** "file" or "directory" */
  type: 'file' | 'directory'
  /** File size in bytes (files only) */
  size?: number
  /** Whether children have been loaded */
  childrenLoaded?: boolean
}
```

### 6.3 Async Data Provider

headless-tree supports async child loading via the `dataLoader` feature. When a directory is expanded for the first time, the tree triggers a data fetch:

```tsx
import { useTree } from '@headless-tree/react'
import { useVirtualizer } from '@tanstack/react-virtual'

function FileTree({ wsUrl, agentId, cwd, onSelectFile }: FileTreeProps) {
  const [treeData, setTreeData] = useState<Map<string, FileTreeItem[]>>(new Map())

  const tree = useTree<FileTreeItem>({
    rootItemId: 'root',
    getItemName: (item) => item.name,
    isItemFolder: (item) => item.type === 'directory',
    dataLoader: {
      getItem: (itemId) => resolveItem(treeData, itemId),
      getChildren: (itemId) => resolveChildren(treeData, itemId),
    },
    asyncDataLoader: {
      // Called when a folder is expanded and children aren't yet loaded
      onLoadChildren: async (itemId) => {
        const relativePath = itemId === 'root' ? '' : itemId
        const result = await fetchDirectoryListing(wsUrl, agentId!, relativePath)
        const children = result.entries.map((entry) => ({
          id: relativePath ? `${relativePath}/${entry.name}` : entry.name,
          name: entry.name,
          type: entry.type,
          size: entry.size,
        }))
        setTreeData((prev) => new Map(prev).set(itemId, children))
      },
    },
    features: [
      // Enable async data loading, keyboard navigation, search, selection
      asyncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      searchFeature,
    ],
  })

  // Virtualization: headless-tree exposes a flat list of visible items
  const items = tree.getItems()
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28, // row height in px
    overscan: 10,
  })

  return (
    <div ref={parentRef} className="flex-1 overflow-auto" role="tree">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const treeItem = items[virtualItem.index]
          return (
            <div
              key={treeItem.getId()}
              {...treeItem.getProps()}
              style={{
                position: 'absolute',
                top: virtualItem.start,
                height: virtualItem.size,
                width: '100%',
              }}
            >
              <FileTreeNode
                item={treeItem}
                onSelect={() => {
                  if (treeItem.isFolder()) {
                    treeItem.toggleExpand()
                  } else {
                    onSelectFile(treeItem.getId())
                  }
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

**Note:** The exact headless-tree API above is illustrative. During implementation, consult the actual `@headless-tree/react` documentation for the precise feature import names and API surface, as the library is in active development. The core architectural approach (async data loading + BYO virtualizer + flat item list) is stable and documented.

### 6.4 Search and Filter

Two modes in the search input:

1. **Local filter** (default, as-you-type): Filters currently-loaded tree nodes by name. headless-tree's built-in `searchFeature` handles this — it filters visible items and auto-expands matching parents.

2. **Deep search** (triggered by pressing Enter or clicking a search icon): Calls `/api/files/search` on the backend. Results render as a flat list replacing the tree temporarily. Clicking a result:
   - Switches back to tree view
   - Expands the tree path to the clicked file (loading intermediate directories as needed)
   - Selects and scrolls to the file

The search input shows a mode indicator: filter icon for local filter, magnifying glass for deep search. A keyboard shortcut (`/` when tree is focused) focuses the search input.

### 6.5 Keyboard Navigation

headless-tree provides W3C-compliant tree keyboard navigation out of the box:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate between visible tree items |
| `→` | Expand directory (if collapsed) or move to first child |
| `←` | Collapse directory (if expanded) or move to parent |
| `Enter` | Select file (load content) or toggle directory expand |
| `Home` / `End` | Jump to first/last visible item |
| `*` | Expand all siblings |
| Type characters | Incremental search (jump to matching item) |
| `/` | Focus search input |
| `Escape` | Clear search, or close dialog if search is empty |

---

## 7. Content Viewer

### 7.1 Syntax Highlighting

**Reuse the existing `syntax-highlight.ts` module** from `apps/ui/src/components/diff-viewer/`. This module provides:

- `highlightCode(source, language)` — returns HTML with highlight.js spans
- `detectLanguage(fileName)` — maps file extensions and special filenames to highlight.js language IDs
- 14 registered languages: TypeScript, JavaScript, JSON, CSS, HTML/XML, Markdown, Python, Bash, YAML, TOML, SQL, Go, Rust, Diff

**Shared extraction (Phase 3 prep, not a separate phase):** Before building the file browser content viewer, move `syntax-highlight.ts` and `syntax-highlight.css` to shared locations:

```
apps/ui/src/lib/syntax-highlight.ts      # shared module (moved from diff-viewer/)
apps/ui/src/styles/syntax-highlight.css  # shared styles (moved from diff-viewer/)
```

Update both diff viewer and file browser imports. The CSS scope class changes from `.diff-viewer-syntax` to `.syntax-highlight` (or add `.file-browser-syntax` as an alias — simplest approach for v1).

This is a narrow extraction — just two files moved, with import path updates. Run typecheck after the move to catch broken imports.

**Additional languages to register** for the file browser (source files that aren't common in diffs but are in repos):

```ts
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import scala from 'highlight.js/lib/languages/scala'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

// + extension mappings:
// java → 'java', c/h → 'c', cpp/hpp/cc → 'cpp', rb → 'ruby',
// php → 'php', swift → 'swift', kt → 'kotlin', scala → 'scala',
// Dockerfile → 'dockerfile'
```

### 7.2 Line-Numbered Code View

The code viewer renders syntax-highlighted content with line numbers:

```tsx
function CodeViewer({ content, language }: { content: string; language: string | undefined }) {
  const lines = content.split('\n')

  return (
    <div className="syntax-highlight flex overflow-auto font-mono text-[13px] leading-6">
      {/* Line number gutter */}
      <div className="sticky left-0 z-10 flex select-none flex-col border-r border-border/40 bg-card/50 px-3 text-right text-muted-foreground/50">
        {lines.map((_, i) => (
          <span key={i} className="leading-6">{i + 1}</span>
        ))}
      </div>

      {/* Code content */}
      <pre className="flex-1 overflow-x-auto px-4">
        {lines.map((line, i) => (
          <div
            key={i}
            className="leading-6"
            dangerouslySetInnerHTML={{ __html: highlightCode(line, language) || '&nbsp;' }}
          />
        ))}
      </pre>
    </div>
  )
}
```

**Performance note:** For files with >5,000 lines, virtualize the line rendering using `@tanstack/react-virtual` — same virtualizer already installed for the tree. Lines above/below the viewport are not rendered. (This threshold is 5,000 consistently — see §10.3 for the same value.)

### 7.3 Markdown Rendering

For `.md`, `.mdx`, and `.markdown` files, the content viewer defaults to a **rendered markdown view** with a toggle to view raw source.

**Reuse the existing `MarkdownMessage` component** from `apps/ui/src/components/chat/MarkdownMessage.tsx`. This already uses:
- `react-markdown` (v10, already installed)
- `remark-gfm` (already installed)
- Full-featured component overrides for headings, lists, tables, code blocks, images, links
- Dark/light theme support
- Document variant styling (`variant="document"`)

**v1 limitation — relative links/images are unsupported.** `MarkdownMessage` does not rewrite relative URLs — its `urlTransform` only allows extra protocols (e.g., `vscode:`), otherwise defers to `defaultUrlTransform`. This means common repo markdown patterns like `![diagram](./docs/diagram.png)` or `[Architecture](../ARCHITECTURE.md)` will resolve relative to the Forge app URL, rendering as broken links/images.

**This is acceptable for v1.** The rendered text, headings, tables, code blocks, and Mermaid diagrams all work correctly. A future enhancement (post-v1) could add a URL rewrite layer that:
- Maps relative image paths to `/api/read-file` GET URLs (e.g., `./docs/diagram.png` → `/api/read-file?path=docs/diagram.png&agentId=...`)
- Maps relative `.md` link clicks to file browser navigation

```tsx
function MarkdownViewer({ content, filePath }: { content: string; filePath: string }) {
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered')

  return (
    <div className="h-full overflow-auto">
      {/* Toggle in FileContentHeader */}
      {viewMode === 'rendered' ? (
        <div className="max-w-3xl mx-auto px-8 py-6">
          <MarkdownMessage content={content} variant="document" enableMermaid />
        </div>
      ) : (
        <CodeViewer content={content} language="markdown" />
      )}
    </div>
  )
}
```

The markdown/raw toggle button lives in the `FileContentHeader` (breadcrumb bar), visible only for markdown files. Default is rendered; the toggle shows an `<Eye>` / `<Code>` icon pair.

### 7.4 Image Preview

For image files, render a centered preview with natural dimensions:

```tsx
function ImagePreview({ wsUrl, filePath, agentId }: ImagePreviewProps) {
  // Construct URL for GET /api/read-file?path=<relative>&agentId=<id>
  // filePath is repo-relative (e.g., "docs/diagram.png"), resolved server-side via agentId's CWD
  const imageUrl = useMemo(() => {
    const params = new URLSearchParams({ path: filePath, agentId: agentId! })
    return resolveApiEndpoint(wsUrl, `/api/read-file?${params.toString()}`)
  }, [wsUrl, filePath, agentId])

  return (
    <div className="flex h-full items-center justify-center p-8">
      <img
        src={imageUrl}
        alt={filePath.split('/').pop() ?? 'Image preview'}
        className="max-h-full max-w-full rounded-lg border border-border/50 bg-muted/20 object-contain"
        loading="lazy"
      />
    </div>
  )
}
```

The existing `/api/read-file` GET endpoint returns raw file bytes with the correct `Content-Type` (resolved by `resolveReadFileContentType` in `http-utils.ts`). This works directly as an `<img src>`.

### 7.5 Binary Detection

Binary detection is **server-side** (see §3.5). The `/api/read-file` POST response includes a `binary` field. When `binary: true`, the response has `content: null` and a `size` field. No client-side sniffing is needed.

```ts
// Response from /api/read-file POST with detectBinary:
// Binary:  { path, content: null, binary: true, size: 45678 }
// Text:    { path, content: "...", binary: false }
```

Binary files show a placeholder:

```tsx
<div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
  <FileWarning className="size-10 opacity-40" />
  <p className="text-sm">Binary file — cannot display</p>
  <p className="text-xs opacity-60">{formatFileSize(fileSize)}</p>
</div>
```

### 7.6 Content Loading Flow

When a file is selected in the tree:

1. Determine content type by extension.
2. **If image** (by extension — see §3.5 for supported list): Construct GET URL with repo-relative path + agentId, render `<img src={url}>`. No POST content fetch needed.
3. **If text/markdown:** Call `/api/read-file` via POST with `{ path: relativeFilePath, agentId }`.
4. On response, check the `binary` field from the server (§3.5 / §7.5).
5. If `binary: true` → show placeholder with file size. If text → detect language → render CodeViewer or MarkdownViewer.
6. If response is 413 (too large) → show "File too large to display (>2 MB)" placeholder.

---

## 8. File Icons

### 8.1 material-icon-theme Integration

Install in `apps/ui`:

```bash
cd apps/ui && pnpm add material-icon-theme
```

The `material-icon-theme` npm package provides:
- `generateManifest()` — returns the complete mapping of file names/extensions → icon names
- All icons as SVG files in the package's `icons/` directory

### 8.2 Icon Resolution

Create a utility module `file-browser-icons.ts`:

```ts
import { generateManifest } from 'material-icon-theme'

// Generate manifest once at module load
const manifest = generateManifest()

// Build lookup maps from the manifest
const fileExtensionMap: Record<string, string> = manifest.fileExtensions ?? {}
const fileNameMap: Record<string, string> = manifest.fileNames ?? {}
const folderNameMap: Record<string, string> = manifest.folderNames ?? {}
const defaultFileIcon = manifest.file ?? 'file'
const defaultFolderIcon = manifest.folder ?? 'folder'
const defaultFolderExpandedIcon = manifest.folderExpanded ?? 'folder-open'

export function resolveFileIcon(fileName: string, isDirectory: boolean, isExpanded?: boolean): string {
  const baseName = fileName.toLowerCase()
  const ext = baseName.split('.').pop() ?? ''

  if (isDirectory) {
    // Check specific folder name first
    const folderIcon = folderNameMap[baseName]
    if (folderIcon) {
      return isExpanded
        ? `${folderIcon}-open`  // material-icon-theme convention for expanded folders
        : folderIcon
    }
    return isExpanded ? defaultFolderExpandedIcon : defaultFolderIcon
  }

  // Check exact filename match first (e.g., "Dockerfile", "package.json")
  const fileNameIcon = fileNameMap[baseName]
  if (fileNameIcon) return fileNameIcon

  // Check extension
  const extIcon = fileExtensionMap[ext]
  if (extIcon) return extIcon

  return defaultFileIcon
}
```

### 8.3 FileIcon Component

```tsx
import { resolveFileIcon } from './file-browser-icons'

interface FileIconProps {
  name: string
  isDirectory: boolean
  isExpanded?: boolean
  className?: string
}

export function FileIcon({ name, isDirectory, isExpanded, className }: FileIconProps) {
  const iconName = resolveFileIcon(name, isDirectory, isExpanded)

  // Load SVG from material-icon-theme package
  // The icons are at node_modules/material-icon-theme/icons/<iconName>.svg
  // Vite can import these as URLs with ?url suffix, or we can use a dynamic import
  const iconUrl = useMemo(
    () => new URL(`material-icon-theme/icons/${iconName}.svg`, import.meta.url).href,
    [iconName],
  )

  return (
    <img
      src={iconUrl}
      alt=""
      className={cn('size-4 shrink-0', className)}
      loading="lazy"
      aria-hidden="true"
    />
  )
}
```

**Implementation note:** The exact Vite import mechanism for the SVG files will need verification during implementation. Options:
1. `new URL(..., import.meta.url)` — Vite's standard asset reference pattern
2. Dynamic `import()` with `?raw` suffix — inlines SVG as string for `dangerouslySetInnerHTML`
3. Pre-built map of the ~100 most common icons as static imports — deterministic, tree-shakeable

If material-icon-theme's package structure doesn't play well with Vite's asset resolution, fall back to hosting the SVGs in `public/icons/` (copied at build time) or using the Lucide fallback strategy (§8.4).

### 8.4 Fallback Strategy

If material-icon-theme has integration issues, use Lucide icons with a color-coded mapping:

```ts
const EXTENSION_ICON_MAP: Record<string, { icon: LucideIcon; color: string }> = {
  ts:   { icon: FileCode2, color: 'text-blue-400' },
  tsx:  { icon: FileCode2, color: 'text-blue-400' },
  js:   { icon: FileCode2, color: 'text-yellow-400' },
  json: { icon: FileJson,  color: 'text-yellow-600' },
  md:   { icon: FileText,  color: 'text-purple-400' },
  css:  { icon: FileCode2, color: 'text-pink-400' },
  py:   { icon: FileCode2, color: 'text-green-400' },
  // ... ~30 common extensions
}
```

This provides functional differentiation without the visual richness of material-icon-theme. Adequate for v1 if the full icon set proves problematic.

---

## 9. Breadcrumb Navigation

### 9.1 Breadcrumb Display

The `FileContentHeader` shows the file's path as clickable segments:

```
src › components › chat › ChatHeader.tsx     📋  🔤  📝
                                             copy wrap editor
```

Each segment is a button. Clicking a directory segment:
1. Navigates the tree to that directory (expands all ancestors, scrolls to the folder).
2. Clears the selected file and shows the empty state in the content pane. This is the simpler, more predictable behavior — the user clicked a directory, so we show that directory context in the tree without a stale file viewer.

### 9.2 Implementation

```tsx
function FileContentHeader({ filePath, cwd, onNavigateToDir, onCopyPath, wordWrap, onToggleWordWrap }: Props) {
  const segments = filePath.split('/')
  // Construct absolute path for clipboard/editor only — never sent to the backend.
  // Uses CWD from the root list response (already OS-native format).
  const absolutePath = [cwd, filePath].join('/')
  const editorPreference = readStoredEditorPreference()
  const editorScheme = EDITOR_URL_SCHEMES[editorPreference]
  const editorLabel = EDITOR_LABELS[editorPreference]

  return (
    <div className="flex h-9 items-center gap-2 border-b border-border/40 bg-card/50 px-3">
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs" aria-label="File path">
        {segments.map((segment, i) => {
          const isLast = i === segments.length - 1
          const dirPath = segments.slice(0, i + 1).join('/')
          return (
            <Fragment key={dirPath}>
              {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />}
              {isLast ? (
                <span className="truncate font-medium text-foreground">{segment}</span>
              ) : (
                <button
                  type="button"
                  className="truncate text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => onNavigateToDir(dirPath)}
                >
                  {segment}
                </button>
              )}
            </Fragment>
          )
        })}
      </nav>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <CopyPathButton path={absolutePath} />
        <WordWrapToggle active={wordWrap} onToggle={onToggleWordWrap} />
        <a
          href={toEditorHref(absolutePath, editorScheme)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title={`Open in ${editorLabel}`}
        >
          <ExternalLink className="size-3" />
          <span className="hidden lg:inline">{editorLabel}</span>
        </a>
      </div>
    </div>
  )
}
```

The "Open in editor" button uses the same `toEditorHref()` utility from `apps/ui/src/lib/artifacts.ts` and the same `readStoredEditorPreference()` from `apps/ui/src/lib/editor-preference.ts`. The editor preference is set in Settings > General (already exists).

---

## 10. Performance

### 10.1 Lazy Directory Loading (Critical)

The tree **never** loads the full file tree upfront. Each directory level is fetched on demand:

1. On dialog open → fetch root directory listing (`/api/files/list?agentId=<id>` — path defaults to `""`).
2. On directory expand → fetch that directory's children.
3. Children are cached in React state. Re-expanding a previously loaded directory uses the cache.
4. "Refresh" button clears the cache and refetches the current tree state.

### 10.2 Virtualized Tree

With `@tanstack/react-virtual`, only ~30-50 tree rows are in the DOM at any time, regardless of how many directories are expanded. headless-tree's flat-list rendering model makes this trivial — the tree provides a flat array of visible items, and the virtualizer renders only the viewport slice.

### 10.3 Content Loading

- **One file at a time.** Only the selected file's content is in memory. Selecting a new file triggers a new query (cached results available for quick re-selection via the query cache).
- **No prefetching.** Unlike the diff viewer (which prefetches on hover), the file browser doesn't prefetch content — the files may be large and the user may be just browsing the tree.
- **Large file handling:**
  - Files >2 MB: backend returns 413, UI shows "File too large" placeholder.
  - Files >5,000 lines: virtualize the line rendering (§7.2).
  - Binary files: detected server-side and shown as placeholder (no attempt to render).

### 10.4 Caching Strategy

| Data | Stale Time | Rationale |
|------|-----------|-----------|
| Directory listing | 30s | Directory contents change as agents work, but not rapidly |
| File content | 15s | Files may be actively edited by agents |
| File count | 120s | Total file count changes slowly |
| File search results | 10s | Results should be reasonably fresh |

All caches are invalidated on manual refresh (refresh button in header).

### 10.5 Icon Loading

material-icon-theme has 1000+ SVG icons. Performance strategy:
- Icons are loaded as `<img src>` referencing the SVG URL — browser caches them after first load.
- In practice, a typical project uses ~30-50 unique icons. After the first tree expansion, all common icons are in the browser cache.
- SVGs are tiny (1-3 KB each). Even loading 50 unique icons adds only ~100 KB total.

---

## 11. Accessibility

### 11.1 Focus Management

- **On open:** Focus moves to the search input in the tree sidebar.
- **On close (Escape or button):** Focus returns to the file browser trigger button in `ChatHeader`.
- **On file selection:** Focus moves to the content area. Screen reader announces the file name.
- **Focus trapping:** Handled automatically by Radix Dialog.

### 11.2 Keyboard Navigation

| Key | Context | Action |
|-----|---------|--------|
| `Escape` | Dialog (no search text) | Close file browser |
| `Escape` | Search input with text | Clear search text |
| `⌘⇧E` / `Ctrl+Shift+E` | Global | Toggle file browser open/close |
| `↑` / `↓` | Tree focused | Navigate between tree items |
| `→` / `←` | Tree focused | Expand/collapse directory |
| `Enter` | Tree focused | Select file or toggle directory |
| `/` | Tree focused | Focus search input |
| `Tab` | Dialog | Move focus between tree, content, actions |

### 11.3 ARIA Annotations

- **Dialog:** `role="dialog"`, `aria-label="File browser"` — provided by Radix Dialog.
- **Tree:** `role="tree"` on container, `role="treeitem"` on each row — handled by headless-tree.
- **Tree items:** `aria-expanded` for directories, `aria-selected` for selected file, `aria-level` for depth.
- **Content area:** `role="region"`, `aria-label="File content: {filename}"`.
- **Breadcrumb:** `<nav aria-label="File path">` with breadcrumb segments.
- **Status bar:** `aria-live="polite"` — updates when file selection changes.
- **Search input:** `aria-label="Filter files"`, `aria-controls` pointing to tree container.

---

## 12. Implementation Phases

### Phase 1 — Backend Endpoints

**New files:**
- `apps/backend/src/ws/routes/file-browser-routes.ts` — HTTP route handlers for `/api/files/list`, `/api/files/count`, `/api/files/search`
- `apps/backend/src/ws/routes/file-browser-service.ts` — Core logic: filesystem listing, git-ignore filtering, repo metadata, binary detection

**Modified files:**
- `apps/backend/src/ws/server.ts` — Import and register `createFileBrowserRoutes` in `httpRoutes` array
- `apps/backend/src/ws/routes/git-diff-routes.ts` — Extract `resolveCwdFromAgent` to shared `route-utils.ts`, update import
- `apps/backend/src/ws/routes/route-utils.ts` — **New file:** shared `resolveCwdFromAgent` utility

**Deliverable:** All three endpoints functional and testable via curl.

**Test checkpoint:**
- `curl /api/files/list?agentId=<id>` returns root directory entries with `repoName`, `branch`, `isGitRepo`
- `curl /api/files/list?agentId=<id>&path=src/components` returns subdirectory entries
- Entries are sorted: directories first, then alphabetical
- `.gitignore`-excluded paths (like `node_modules`) are not listed
- Fresh `git init` repos (no commits) still list files correctly
- Empty directories appear in the listing
- Symlinked directories outside CWD are excluded
- `curl /api/files/count?agentId=<id>` returns file count (including untracked files)
- `curl /api/files/search?agentId=<id>&query=ChatHeader` returns matching paths (including untracked)
- Non-existent agent returns 404
- Agent with no CWD returns 400
- Path traversal attempts (e.g., `path=../../etc`) return 403
- Permission-denied directories return structured errors

**Risk:** Low. Additive-only — new routes + service, no modification to existing code beyond registration and the small `resolveCwdFromAgent` extraction.

**Depends on:** Nothing.

---

### Phase 2 — Dialog Shell + File Tree (Frontend MVP)

**New files:**
- `apps/ui/src/components/file-browser/FileBrowserDialog.tsx`
- `apps/ui/src/components/file-browser/FileBrowserHeader.tsx`
- `apps/ui/src/components/file-browser/FileTree.tsx`
- `apps/ui/src/components/file-browser/FileTreeNode.tsx`
- `apps/ui/src/components/file-browser/FileStatusBar.tsx`
- `apps/ui/src/components/file-browser/use-file-browser-queries.ts`
- `apps/ui/src/components/file-browser/file-browser.css`

**Modified files:**
- `apps/ui/src/components/chat/ChatHeader.tsx` — Add file browser button + props
- `apps/ui/src/routes/index.tsx` — Dialog state, keyboard shortcut (`⌘⇧E`), render `FileBrowserDialog`
- `apps/ui/package.json` — Add `@headless-tree/core`, `@headless-tree/react`, `@tanstack/react-virtual`

**Deliverable:** Working dialog with file tree — lazy-loading directories, expand/collapse, file selection (no content viewer yet, just the tree + empty content area).

**Test checkpoint:**
- File browser button appears in ChatHeader with correct icon/tooltip
- `⌘⇧E` opens/closes the dialog
- Root directory loads and displays entries with directories first
- Expanding a directory lazily loads its children
- `.gitignore`-excluded entries are not shown
- Tree keyboard navigation works (arrows, enter, expand/collapse)
- File count appears in the tree footer
- Resizable tree sidebar persists width in localStorage
- Escape closes dialog, focus returns to trigger button

**Risk:** Medium. `@headless-tree/react` is in beta — verify API stability before committing. The library's flat-list rendering model is well-documented, but edge cases around async loading may surface. Have react-arborist as a fallback.

**Depends on:** Phase 1 (backend endpoints must exist).

---

### Phase 3 — Content Viewer (Code + Images)

**New files:**
- `apps/ui/src/components/file-browser/FileContentViewer.tsx` — Mode-switching content component
- `apps/ui/src/components/file-browser/FileContentHeader.tsx` — Breadcrumb + actions
- `apps/ui/src/components/file-browser/ImagePreview.tsx` — Image rendering

**Modified files:**
- `apps/ui/src/components/file-browser/FileBrowserDialog.tsx` — Wire content viewer into the right panel
- `apps/ui/src/components/file-browser/use-file-browser-queries.ts` — Add `useFileContent` hook

**Shared extraction (part of this phase, not a separate pre-phase):**
- Move `syntax-highlight.ts` → `apps/ui/src/lib/syntax-highlight.ts`
- Move `syntax-highlight.css` → `apps/ui/src/styles/syntax-highlight.css`
- Update diff viewer imports to use new shared paths
- Add `.file-browser-syntax` scope to the CSS (or generalize to `.syntax-highlight`)
- Run typecheck after moves to catch broken imports

**Deliverable:** Clicking a file in the tree shows its content — syntax-highlighted code with line numbers, image preview for images, binary placeholder for binary files.

**Test checkpoint:**
- Selecting a `.ts` file shows syntax-highlighted TypeScript with line numbers
- Selecting a `.json` file shows highlighted JSON
- Selecting a `.png` or `.jpg` shows inline image preview
- Selecting a binary file shows "Binary file — cannot display" (server-side detection)
- File >2 MB shows "File too large" placeholder
- Breadcrumb shows the file path, segments are clickable
- "Copy path" button copies the absolute path to clipboard
- "Open in editor" link opens the file in the configured editor (VS Code/Cursor)
- Word-wrap toggle works
- Status bar shows: encoding, language, line count, file size

**Risk:** Low. Reuses existing `highlightCode` / `detectLanguage` from syntax-highlight module. `/api/read-file` is already battle-tested.

**Depends on:** Phase 2 (tree must exist for file selection to work).

---

### Phase 4 — Markdown Preview + Search

**New files:**
- `apps/ui/src/components/file-browser/MarkdownPreview.tsx` — Rendered markdown with raw toggle

**Modified files:**
- `apps/ui/src/components/file-browser/FileContentViewer.tsx` — Add markdown mode
- `apps/ui/src/components/file-browser/FileContentHeader.tsx` — Add markdown raw/rendered toggle
- `apps/ui/src/components/file-browser/FileTree.tsx` — Wire deep search results
- `apps/ui/src/components/file-browser/use-file-browser-queries.ts` — Add `useFileSearch` hook

**Deliverable:** Markdown files render as formatted markdown by default, with a toggle to view raw source. Deep search finds files across the whole repo.

**Test checkpoint:**
- `.md` files render as formatted markdown (headings, lists, code blocks, tables)
- Relative links/images render as broken (known v1 limitation — documented in §7.3)
- Toggle switches between rendered and raw source
- Mermaid diagrams render (reusing existing MarkdownMessage mermaid support)
- Deep search (type + Enter) returns results from backend
- Clicking a search result navigates tree to that file
- Search result count shown ("showing N of M")

**Risk:** Low. `MarkdownMessage` with `variant="document"` already handles markdown rendering. Search is a thin backend endpoint.

**Depends on:** Phase 3.

---

### Phase 5 — File Icons

**New files:**
- `apps/ui/src/components/file-browser/FileIcon.tsx`
- `apps/ui/src/components/file-browser/file-browser-icons.ts`

**Modified files:**
- `apps/ui/src/components/file-browser/FileTreeNode.tsx` — Integrate `FileIcon` component
- `apps/ui/package.json` — Add `material-icon-theme`

**Deliverable:** File tree shows VS Code-quality file and folder icons.

**Test checkpoint:**
- TypeScript files show the TS icon
- JavaScript files show the JS icon
- Package.json shows the npm/node icon
- Folders show folder icons (different when expanded)
- Special folders (src, lib, test, node_modules) show themed folder icons
- Unrecognized extensions show the generic file icon
- Icons load without visible FOUC (flash of unstyled content)

**Risk:** Medium. material-icon-theme's npm package structure may not play perfectly with Vite's asset resolution. If `new URL(...)` pattern doesn't work, fall back to Lucide icons (§8.4). Test this early — potentially pull forward a quick spike before Phase 5 to de-risk.

**Depends on:** Phase 2 (tree must exist). Can run in parallel with Phases 3–4.

---

### Phase 6 — Polish + Performance

**Changes:**
- Line virtualization for files >5,000 lines (consistent with §7.2 and §10.3)
- Tree expand/collapse animations (CSS transitions on height, ~150ms)
- Hover-to-expand directories on drag? (deferred — read-only, no drag)
- Responsive collapse for <1000px viewports
- Additional highlight.js languages (Java, C, C++, Ruby, PHP, Swift, Kotlin, Dockerfile)
- Search UX refinement: debounced input, loading states, keyboard hints

**Depends on:** Phases 3–5.

---

### Parallelization Guidance

- **Phase 1 and Phase 2** can be worked in parallel — backend routes have no UI dependency, and the tree can be built against mocked data initially.
- **Phase 5 (icons)** can run in parallel with Phases 3–4 since it only touches the tree node component.
- **Phases 3–4** are sequential (content viewer must exist before markdown mode is added).
- **Phase 6** is incremental polish, triggered by real-world usage.

---

## 13. Risks and Mitigations

### 13.1 @headless-tree/react Beta Stability

**Risk:** The library is in beta. API surface may change or have undiscovered bugs in async data loading.

**Mitigation:** Before committing to Phase 2, run a quick spike: install the library, render a simple async-loading tree with virtualization, verify keyboard nav works. If unstable, fall back to **react-arborist** (342 KB larger but stable, 3.4k+ stars, built-in virtualization via react-window).

**Severity:** Medium. Would delay Phase 2 by the time to swap tree libraries.

### 13.2 material-icon-theme Vite Integration

**Risk:** The npm package's SVG file layout may not be compatible with Vite's asset import patterns.

**Mitigation:** Three fallback strategies in order:
1. Use Vite's `new URL(path, import.meta.url)` pattern (standard for asset references).
2. Copy icons to `public/icons/` at build time via a vite plugin or build script.
3. Fall back to Lucide icons with color-coded mappings (§8.4) — zero risk, just less visual richness.

**Severity:** Low. The Lucide fallback provides a functional (if less beautiful) experience.

### 13.3 Large Repo Performance (File Listing)

**Risk:** Repos with very large directories (e.g., monorepo root with 100+ subdirectories) could make `/api/files/list` slow.

**Mitigation:** `readdir` is fast for single-level listing — O(entries in that directory). The `git check-ignore` filter adds per-entry overhead, but can be batched via `--stdin` mode. The lazy-loading strategy means we never scan the full tree. For non-git repos, the hardcoded exclusion list prevents `node_modules` (often 50,000+ entries) from being listed. If a single directory has >1,000 entries, the backend can return a capped result with a `truncated: true` flag.

**Severity:** Low with lazy loading in place.

### 13.4 Concurrent Agent File Modifications

**Risk:** Agents actively modifying files while the user is browsing.

**Mitigation:** Acceptable for v1 — the file browser is a snapshot tool. The refresh button and stale-time-based cache invalidation provide manual recourse. Working directory contents have a 30s stale time, and file content has a 15s stale time.

**Severity:** Low.

### 13.5 Git Not Installed or Non-Git Directory

**Risk:** The CWD may not be a git repo, or git may not be in PATH.

**Mitigation:** Since the filesystem is the source of truth for listing (§3.3), non-git directories work by default:
- Not a git repo → `readdir` with hardcoded exclusions (no git-ignore filter).
- Git not found → same fallback.
- `/api/files/count` returns `{ count: 0, method: "none" }` for non-git — UI hides the count footer.
- `/api/files/search` returns `{ results: [], totalMatches: 0, unavailable: true }` for non-git — UI shows "Search requires a git repository."
- Unborn HEAD (fresh `git init`, no commits): listing works normally via `readdir`; `git check-ignore` still functions for filtering; branch is `null`.

**Severity:** Low. The filesystem-first model makes graceful degradation the natural default.

### 13.6 Syntax Highlight Shared Module Extraction

**Risk:** Moving `syntax-highlight.ts` and `syntax-highlight.css` to shared paths could break diff viewer imports if done incorrectly.

**Mitigation:** This is a simple file move with import path updates. Run typecheck (`pnpm exec tsc --noEmit`) after the move to catch any broken imports. Alternatively, keep the original files in place and have the file browser import from the diff-viewer directory — less clean but zero-risk.

**Severity:** Low.

---

## Appendix A: File-by-File Change Checklist

### Backend (Phase 1)
- [ ] `apps/backend/src/ws/routes/file-browser-routes.ts` — **New file:** `/api/files/list`, `/api/files/count`, `/api/files/search` route handlers
- [ ] `apps/backend/src/ws/routes/file-browser-service.ts` — **New file:** Core fs/git logic (listing, filtering, metadata, count, search)
- [ ] `apps/backend/src/ws/routes/route-utils.ts` — **New file:** Shared `resolveCwdFromAgent` utility (extracted from git-diff-routes)
- [ ] `apps/backend/src/ws/routes/git-diff-routes.ts` — Update `resolveCwdFromAgent` import to use shared `route-utils.ts`
- [ ] `apps/backend/src/ws/server.ts` — Import and register `createFileBrowserRoutes`

### Frontend — Phase 2 (Dialog + Tree)
- [ ] `apps/ui/package.json` — Add `@headless-tree/core`, `@headless-tree/react`, `@tanstack/react-virtual`
- [ ] `apps/ui/src/components/file-browser/FileBrowserDialog.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/FileBrowserHeader.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/FileTree.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/FileTreeNode.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/FileStatusBar.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/use-file-browser-queries.ts` — **New file**
- [ ] `apps/ui/src/components/file-browser/file-browser.css` — **New file**
- [ ] `apps/ui/src/components/chat/ChatHeader.tsx` — Add file browser button + props
- [ ] `apps/ui/src/routes/index.tsx` — Dialog state, `⌘⇧E` keyboard shortcut, render dialog

### Frontend — Phase 3 (Content Viewer)
- [ ] `apps/ui/src/components/file-browser/FileContentViewer.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/FileContentHeader.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/ImagePreview.tsx` — **New file**
- [ ] `apps/ui/src/lib/syntax-highlight.ts` — **Moved** from `components/diff-viewer/syntax-highlight.ts`
- [ ] `apps/ui/src/styles/syntax-highlight.css` — **Moved** from `components/diff-viewer/syntax-highlight.css`
- [ ] `apps/ui/src/components/diff-viewer/` — Update imports to use shared paths

### Frontend — Phase 4 (Markdown + Search)
- [ ] `apps/ui/src/components/file-browser/MarkdownPreview.tsx` — **New file**

### Frontend — Phase 5 (Icons)
- [ ] `apps/ui/package.json` — Add `material-icon-theme`
- [ ] `apps/ui/src/components/file-browser/FileIcon.tsx` — **New file**
- [ ] `apps/ui/src/components/file-browser/file-browser-icons.ts` — **New file**

### Unchanged (verified)
- `packages/protocol/` — No changes needed (no new wire types)
- `apps/backend/src/ws/routes/file-routes.ts` — Reused as-is (`/api/read-file`), not modified (binary detection enhancement may add a conditional path but does not change existing behavior)
- `apps/backend/src/swarm/` — No changes
- `apps/ui/src/lib/ws-client.ts` — No changes (HTTP-only, no WS commands)
- `apps/ui/src/lib/editor-preference.ts` — Reused as-is, not modified
- `apps/ui/src/lib/artifacts.ts` — Reused (`toEditorHref`), not modified

---

## Appendix B: Dependency Assessment

| Package | Purpose | Bundle Impact (min+gz) | Risk |
|---------|---------|----------------------|------|
| `@headless-tree/core` | Tree logic | ~3.1 kB | Medium — beta |
| `@headless-tree/react` | React bindings | ~0.4 kB | Medium — beta |
| `@tanstack/react-virtual` | Virtualized list rendering | ~3.5 kB | Low — widely used, TanStack ecosystem |
| `material-icon-theme` | File/folder SVG icons | SVGs on demand (~1-3 KB each) | Low — MIT, well-maintained |

**Total new JS: ~7 kB** (excluding on-demand SVG icons). No new backend dependencies.

---

## Appendix C: Existing Code Reuse Summary

| Existing Module | Location | Reuse in File Browser |
|----------------|----------|----------------------|
| `syntax-highlight.ts` | `components/diff-viewer/` → shared `lib/` | Direct reuse for code highlighting + language detection |
| `syntax-highlight.css` | `components/diff-viewer/` → shared `styles/` | Direct reuse for highlight.js theme |
| `useResizablePanel.ts` | `components/diff-viewer/` | Direct reuse for tree sidebar resize |
| `MarkdownMessage` | `components/chat/MarkdownMessage.tsx` | Direct reuse for markdown rendering (`variant="document"`) |
| `editor-preference.ts` | `lib/editor-preference.ts` | Direct reuse for "Open in editor" preference |
| `toEditorHref()` | `lib/artifacts.ts` | Direct reuse for editor deep-link URL construction |
| `resolveApiEndpoint()` | `lib/api-endpoint.ts` | Direct reuse for API URL construction |
| `/api/read-file` endpoint | `ws/routes/file-routes.ts` | Direct reuse for file content loading |
| `resolveCwdFromAgent()` | `ws/routes/route-utils.ts` (extracted from git-diff-routes) | Direct reuse for CWD resolution in new routes |
| `handleGet` / route helpers | `ws/routes/git-diff-routes.ts` | Pattern reuse for new route handler structure |
| `DiffViewerDialog` | `components/diff-viewer/DiffViewerDialog.tsx` | Pattern reuse for dialog shell structure |

---

## Appendix D: Future Enhancements (Post-v1)

These are explicitly out of scope for v1 but documented for planning:

1. **Markdown relative URL rewriting** — Map relative image paths to `/api/read-file` GET URLs and relative `.md` links to file browser navigation, so README previews fully work
2. **File editing** — Inline editing with CodeMirror 6, save via `/api/write-file`
2. **File search by content** — `git grep` backend endpoint, search inside file contents
3. **Multi-file tabs** — Open multiple files with tab bar (like VS Code)
4. **Minimap** — VS Code-style miniature file overview for large files
5. **Git integration** — Show file modification status (M/A/D badges) from `git status` alongside tree entries
6. **Drag-and-drop into chat** — Drag a file from the tree into the message input as an attachment
7. **Diff from tree** — Right-click a file to view its diff (opens diff viewer with that file selected)
8. **Shiki upgrade** — Replace highlight.js with Shiki for VS Code-accurate syntax highlighting
9. **File watching** — WebSocket push when files change, auto-refresh tree/content
10. **Code folding** — Collapse code blocks in the viewer (requires CodeMirror or similar)
