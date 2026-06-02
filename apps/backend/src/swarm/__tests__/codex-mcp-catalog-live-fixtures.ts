/** Live-shaped Codex app-server 0.129 catalog snippets for regression tests. */

export const LIVE_PLUGIN_LIST_RESPONSE = {
  marketplaces: [
    {
      name: "openai-curated",
      path: "/marketplaces/openai-curated",
      interface: "curated",
      plugins: [
        {
          id: "fireflies@openai-curated",
          name: "fireflies",
          enabled: true,
          installed: true,
          availability: "available",
          interface: {
            displayName: "Fireflies",
            shortDescription: "Meeting transcripts and summaries",
            longDescription: "Search and summarize Fireflies meeting notes.",
            category: "productivity",
            keywords: ["meetings", "transcripts"],
          },
        },
        {
          id: "google-calendar@openai-curated",
          name: "google_calendar",
          enabled: true,
          installed: false,
          availability: "available",
          interface: {
            displayName: "Google Calendar",
            shortDescription: "Calendar events",
            category: "productivity",
          },
        },
        {
          id: "gmail@openai-curated",
          name: "gmail",
          enabled: true,
          installed: true,
          availability: "available",
          interface: {
            displayName: "Gmail",
            shortDescription: "Email search",
            category: "productivity",
          },
        },
      ],
    },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: ["fireflies@openai-curated"],
} as const;

export const LIVE_APP_LIST_RESPONSE = {
  apps: [
    {
      id: "codex-apps-ecosystem",
      name: "Codex Apps",
      pluginDisplayNames: {
        fireflies: "Fireflies",
        google_calendar: "Google Calendar",
        gmail: "Gmail",
      },
    },
  ],
} as const;

export const LIVE_MCP_SERVER_STATUS_RESPONSE = {
  servers: [
    {
      name: "codex_apps",
      tools: [
        {
          name: "fireflies_fireflies_get_summary",
          description: "Get Fireflies meeting summary",
          readOnly: true,
          annotations: { readOnlyHint: true },
        },
        {
          name: "google_calendar_google_calendar_list_events",
          description: "List calendar events",
          readOnly: true,
          annotations: { readOnlyHint: true },
        },
        {
          name: "gmail_gmail_search_messages",
          description: "Search Gmail messages",
          readOnly: true,
          annotations: { readOnlyHint: true },
        },
      ],
    },
    {
      name: "RepoPrompt",
      tools: {
        get_code_structure: {
          description: "Inspect repository structure",
          readOnly: true,
          annotations: { readOnlyHint: true },
        },
      },
    },
  ],
} as const;
