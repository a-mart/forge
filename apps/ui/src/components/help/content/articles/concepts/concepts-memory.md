Forge keeps three layers of memory so agents have the right context without you repeating yourself.

## Profile memory

Each profile has a memory file that stores durable facts — project conventions, tech stack details, decisions you have made. Every session in that profile can read this memory. Think of it as the shared knowledge base for a particular project or workflow.

## Session memory

Each chat session has its own working memory. This is where the agent records things it learns during a conversation — what it tried, what worked, open questions. Session memory is private to that session. Other sessions in the same profile do not see it.

This separation is useful because a session might explore a dead-end approach. You do not want that polluting the shared profile memory. When a session produces insights worth keeping, the memory can be merged up into the profile level.

## Common knowledge

Common knowledge lives above profiles. It stores cross-project preferences — things like your name, how you prefer to communicate, and workflow habits. Cortex manages this file. Every profile and session can read it.

## How they interact

When an agent starts working, it loads all three layers: common knowledge, then profile memory, then session memory. More specific layers take precedence. If session memory says "use approach B" but profile memory says "use approach A," the agent follows the session.

You can ask the agent to remember something and it writes to session memory. Profile memory updates happen through explicit merges or Cortex reviews. Common knowledge updates when you tell Cortex about a cross-project preference.

Memory files are plain markdown stored on disk. You can read and edit them directly if you want.
