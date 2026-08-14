---
name: brave-search
description: Use Brave for exact or navigational lookup, country or freshness controls, or direct URL extraction; use exa-search for semantic or conceptual web discovery and multi-source research. Lightweight, no browser required.
env:
  - name: BRAVE_API_KEY
    description: Brave Search API key
    required: true
    helpUrl: https://api-dashboard.search.brave.com/register
---

# Brave Search

Exact, navigational, freshness-filtered, and URL-oriented web search plus page-content extraction using the official Brave Search API. No browser required. Use `exa-search` instead for semantic or conceptual discovery and multi-source research.

## Setup

Requires a Brave Search API account with a free subscription. A credit card is required to create the free subscription (you won't be charged).

1. Create an account at https://api-dashboard.search.brave.com/register
2. Create a "Free AI" subscription
3. Create an API key for the subscription
4. Configure `BRAVE_API_KEY` in the app Settings → Environment Variables.
   (Fallback for standalone usage: export `BRAVE_API_KEY` in your shell.)
5. Dependencies are installed via the backend workspace package.
   If running this skill standalone, install once from this skill directory:
   ```bash
   npm install
   ```

## Search

```bash
node ./search.js "query"                         # Basic search (5 results)
node ./search.js "query" -n 10                   # More results (max 20)
node ./search.js "query" --content               # Include page content as markdown
node ./search.js "query" --freshness pw          # Results from last week
node ./search.js "query" --freshness 2024-01-01to2024-06-30  # Date range
node ./search.js "query" --country DE            # Results from Germany
node ./search.js "query" -n 3 --content          # Combined options
```

### Options

- `-n <num>` - Number of results (default: 5, max: 20)
- `--content` - Fetch and include page content as markdown
- `--country <code>` - Two-letter country code (default: US)
- `--freshness <period>` - Filter by time:
  - `pd` - Past day (24 hours)
  - `pw` - Past week
  - `pm` - Past month
  - `py` - Past year
  - `YYYY-MM-DDtoYYYY-MM-DD` - Custom date range

## Extract Page Content

```bash
node ./content.js https://example.com/article
```

Fetches a URL and extracts readable content as markdown.

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Age: 2 days ago
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## When to Use

**Brave vs. Exa — choose the provider before searching:**

- **Use Brave** for exact or navigational lookup, country or freshness controls, and direct URL or page-content extraction. `content.js` is the direct-URL path.
- **Use `exa-search`** for semantic or conceptual discovery, unfamiliar topics, multi-source research, source landscapes, and cross-source synthesis.
- If a task needs both, discover candidates with Exa, then use Brave to verify exact wording, regional or freshness constraints, or page content.
- Do not search when the answer is already established in the conversation or local repository.
