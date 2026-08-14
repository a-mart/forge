import { cn } from '@/lib/utils'
import {
  commitGraphLaneX,
  commitGraphWidth,
  type CommitGraphRow,
} from './commit-graph-layout'

const DOT_RADIUS = 3.5
const STROKE_WIDTH = 1.5

const LANE_COLORS = [
  'var(--primary)',
  'rgb(245 158 11)',
  'rgb(168 85 247)',
  'rgb(20 184 166)',
  'rgb(244 63 94)',
  'rgb(59 130 246)',
]

export interface CommitGraphRowMetrics {
  sha: string
  top: number
  height: number
}

interface CommitGraphOverlayProps {
  rows: CommitGraphRow[]
  metrics: CommitGraphRowMetrics[]
  selectedSha: string | null
}

export function CommitGraphOverlay({ rows, metrics, selectedSha }: CommitGraphOverlayProps) {
  const metricsBySha = new Map(metrics.map((entry) => [entry.sha, entry]))
  const laneCount = Math.max(1, ...rows.map((row) => row.laneCount), 1)
  const width = commitGraphWidth(laneCount)
  const height = Math.max(
    metrics.reduce((max, entry) => Math.max(max, entry.top + entry.height), 0),
    rows.length * 36,
  )

  return (
    <svg
      aria-hidden="true"
      data-testid="commit-graph"
      className="pointer-events-none absolute left-0 top-0"
      width={width}
      height={height}
    >
      {rows.map((row) => {
        const metric = metricsBySha.get(row.sha)
        if (!metric || metric.height <= 0) {
          return null
        }

        const midY = metric.top + metric.height / 2
        const bottomY = metric.top + metric.height
        const color = laneColor(row.column)

        return (
          <g key={row.sha}>
            {row.incoming.map((lane) => (
              <path
                key={`in-${lane}`}
                d={`M ${laneX(lane)} ${metric.top} L ${laneX(lane)} ${midY}`}
                fill="none"
                stroke={laneColor(lane)}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
              />
            ))}
            {row.edges.map((edge, index) => {
              const startX = laneX(edge.from)
              const endX = laneX(edge.to)
              const path =
                edge.from === edge.to
                  ? `M ${startX} ${midY} L ${endX} ${bottomY}`
                  : `M ${startX} ${midY} C ${startX} ${midY + metric.height * 0.35}, ${endX} ${bottomY - metric.height * 0.35}, ${endX} ${bottomY}`

              return (
                <path
                  key={`${edge.from}-${edge.to}-${index}`}
                  d={path}
                  fill="none"
                  stroke={laneColor(edge.to)}
                  strokeWidth={STROKE_WIDTH}
                  strokeLinecap="round"
                />
              )
            })}
            {row.joins.map((lane) => {
              const startX = laneX(lane)
              const endX = laneX(row.column)
              return (
                <path
                  key={`join-${lane}`}
                  d={`M ${startX} ${midY} C ${startX} ${midY + 6}, ${endX} ${midY + 6}, ${endX} ${midY}`}
                  fill="none"
                  stroke={laneColor(lane)}
                  strokeWidth={STROKE_WIDTH}
                  strokeLinecap="round"
                />
              )
            })}
            {row.continuing
              .filter((lane) => !row.edges.some((edge) => edge.to === lane))
              .map((lane) => (
                <path
                  key={`through-${lane}`}
                  d={`M ${laneX(lane)} ${midY} L ${laneX(lane)} ${bottomY}`}
                  fill="none"
                  stroke={laneColor(lane)}
                  strokeWidth={STROKE_WIDTH}
                  strokeLinecap="round"
                />
              ))}
            <circle
              cx={laneX(row.column)}
              cy={midY}
              r={selectedSha === row.sha ? DOT_RADIUS + 0.75 : DOT_RADIUS}
              className={cn(selectedSha === row.sha ? 'fill-background' : undefined)}
              fill={selectedSha === row.sha ? undefined : color}
              stroke={color}
              strokeWidth={selectedSha === row.sha ? 1.75 : 0}
            />
          </g>
        )
      })}
    </svg>
  )
}

function laneX(column: number): number {
  return commitGraphLaneX(column)
}

function laneColor(column: number): string {
  return LANE_COLORS[column % LANE_COLORS.length] ?? LANE_COLORS[0]
}
