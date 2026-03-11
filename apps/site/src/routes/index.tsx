import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: LandingPage })

const features = [
  {
    title: 'Parallel Execution',
    description:
      'Spawn multiple workers at once. Codex handles backend, Opus handles UI — all running simultaneously in isolated git worktrees.',
  },
  {
    title: 'Agentic Merge Queue',
    description:
      'A dedicated merger agent serializes all completed work into main. One integration point, no conflicts, no babysitting.',
  },
  {
    title: 'Persistent Memory',
    description:
      'Your manager remembers preferences, routing decisions, and project context across sessions. The knowledge compounds over time.',
  },
  {
    title: 'Event-Driven Manager',
    description:
      'The manager is never blocked. It dispatches work, handles status updates, and steers agents — all without waiting on any single worker.',
  },
  {
    title: 'Multi-Model Teams',
    description:
      'Route tasks to the right model. Codex App for backend features, Opus for UI polish, Codex for code generation. Your manager picks.',
  },
  {
    title: 'Local-First & Open Source',
    description:
      'Self-hosted daemon on your machine. Apache 2.0 licensed. Your code and API keys never leave localhost.',
  },
]

const flow = [
  {
    title: 'Create a manager',
    description:
      "Spin one up for your project. Point it at a repo, pick the models you want it to use, and you're ready to go.",
  },
  {
    title: 'Onboard it',
    description:
      'Tell it how you like to work — how tasks should be broken down, which models handle what, your coding standards and preferences. It remembers everything.',
  },
  {
    title: 'Let it manage',
    description:
      'Hand off the work. Your manager dispatches coding agents, tracks progress, handles merges, and keeps you posted. You direct — it executes.',
  },
]

const quickStartCommands = [
  'git clone https://github.com/radopsai/middleman.git',
  'cd middleman',
  'pnpm install',
  'pnpm dev',
]

function LandingPage() {
  return (
    <div className="min-h-screen bg-page text-ink">
      <div className="mx-auto max-w-[68rem] px-6 sm:px-10 lg:px-16">
        {/* ── Nav ── */}
        <nav className="reveal flex items-center justify-between py-7">
          <a
            href="#"
            className="font-display text-[1.15rem] tracking-[-0.01em] no-underline"
          >
            Middleman
          </a>
          <a
            href="https://github.com/radopsai/middleman"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-muted no-underline transition-colors duration-300 hover:text-ink"
          >
            GitHub
          </a>
        </nav>

        {/* ── Hero ── */}
        <section className="pb-20 pt-24 sm:pt-32 lg:pt-40">
          <h1 className="reveal-1 font-display max-w-[52rem] text-[clamp(2.4rem,5.6vw,4.2rem)] font-normal italic leading-[1.1] tracking-[-0.025em]">
            Stop managing your agents.{' '}
            <span className="text-muted">Hire a middle manager.</span>
          </h1>

          <p className="reveal-2 mt-8 max-w-xl text-[1.05rem] leading-[1.7] text-muted">
            Go from being the agent manager to the CEO of your coding projects.
            Stop dispatching tasks, babysitting terminals, and rebasing
            branches. Give direction, set standards, and let a persistent AI
            manager handle everything between your intent and shipped code.
          </p>

          <div className="reveal-3 mt-10 flex items-center gap-8">
            <a
              href="#quick-start"
              className="text-[13px] font-medium underline decoration-accent decoration-[1.5px] underline-offset-[5px] transition-colors duration-300 hover:text-accent"
            >
              Get started
            </a>
            <a
              href="https://github.com/radopsai/middleman"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-muted no-underline transition-colors duration-300 hover:text-ink"
            >
              View source &rarr;
            </a>
          </div>
        </section>

        <Rule />

        {/* ── At a glance ── */}
        <section className="grid grid-cols-3 gap-y-7 py-12">
          {(
            [
              ['Runtimes', 'Claude, Codex, Codex App'],
              ['Channels', 'Web, Slack, Telegram'],
              ['License', 'Apache 2.0'],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <p className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
                {label}
              </p>
              <p className="mt-2 text-[13px]">{value}</p>
            </div>
          ))}
        </section>

        <Rule />

        {/* ── The pitch ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>The problem</SectionLabel>

          <div className="mt-8 max-w-2xl space-y-5">
            <p className="text-[1.05rem] leading-[1.7] text-muted">
              AI agents are good at focused work — writing code, fixing bugs,
              refactoring modules. But someone still has to play project manager.
              You&rsquo;re the one creating branches, assigning tasks, watching
              terminals, merging PRs, and context-switching between five
              different agent sessions.
            </p>
            <p className="text-[1.05rem] leading-[1.7] text-ink">
              Middleman gives every project a persistent manager that actually
              sticks around. You tell it what needs to get done — it dispatches
              workers, tracks progress, and handles the merge queue. You stay
              informed, not involved.
            </p>
          </div>
        </section>

        <Rule />

        {/* ── How it works ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>How it works</SectionLabel>

          <div className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-x-16">
            {flow.map((step) => (
              <div key={step.title}>
                <h3 className="text-[15px] font-medium">{step.title}</h3>
                <p className="mt-2 text-[13px] leading-[1.7] text-muted">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Rule />

        {/* ── Features ── */}
        <section className="py-20 sm:py-24">
          <SectionLabel>Capabilities</SectionLabel>

          <div className="mt-12 grid gap-x-20 sm:grid-cols-2">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="border-t border-rule py-6"
              >
                <div>
                  <h3 className="text-[14px] font-medium leading-snug">
                    {feature.title}
                  </h3>
                  <p className="mt-1.5 text-[13px] leading-[1.7] text-muted">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <Rule />

        {/* ── Quick start ── */}
        <section id="quick-start" className="py-20 sm:py-24">
          <SectionLabel>Quick start</SectionLabel>

          <div className="mt-12 overflow-hidden rounded-xl bg-ink">
            <pre className="overflow-x-auto p-6 text-[13px] leading-[1.9] text-page/70">
              <code>
                {quickStartCommands
                  .map((c) => `$ ${c}`)
                  .join('\n')}
              </code>
            </pre>
          </div>
          <p className="mt-5 text-[13px] text-muted">
            Opens at{' '}
            <span className="text-ink">localhost:47188</span>. Create a
            manager, point it at a repo, and start delegating. All data stays
            local.
          </p>
        </section>

        <Rule />

        {/* ── Footer ── */}
        <footer className="flex flex-wrap items-center justify-between gap-4 py-8 text-[12px] text-muted">
          <span>Middleman — The middle manager your agents deserve</span>
          <div className="flex gap-6">
            {(
              [
                ['GitHub', 'https://github.com/radopsai/middleman'],
                ['License', 'https://github.com/radopsai/middleman/blob/main/LICENSE'],
              ] as const
            ).map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline transition-colors duration-300 hover:text-ink"
              >
                {label}
              </a>
            ))}
          </div>
        </footer>
      </div>
    </div>
  )
}

function Rule() {
  return <hr className="border-rule" />
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium tracking-[0.14em] text-muted uppercase">
      {children}
    </p>
  )
}
