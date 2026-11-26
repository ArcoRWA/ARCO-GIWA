// The Portfolio's Activity tab (look "V3": summary + feed). On top, Deposited · Withdrawn · Net supplied: where the
// hero's Supplied comes from (portfolio-activity.ts says exactly what counts). Under it a segment (All / Deposits /
// Withdrawals) and one card of the wallet's transactions grouped by day, newest first. A row: which way the money moved,
// the product's mark, the action, "product · token amount · time", and its dollars at today's price with the
// transaction link under it (phones: the time, which links the transaction).

import { useId, useState } from "react"
import { ArrowDown, ArrowUp, Clock, ExternalLink } from "lucide-react"
import { GiwaBrandMark } from "./components"
import type { ActivityDirection, ActivityRow } from "./activity-feed"
import {
  ACTIVITY_FILTERS, activityDayLabel, activityTimeLabel, activityUsd, filterActivity, groupActivityByDay,
  type ActivityFilter, type ActivitySummary, type AssetUsdOf,
} from "./portfolio-activity"
import { explorerTx } from "./wallet"
import { money, shortAddr, token } from "../lib/format"

const INK = "text-[var(--color-arco-ink)]"
const SOFT = "text-[var(--color-arco-muted-text)]"
const GREEN = "text-[var(--color-arco-up-text)]"
const SEGMENT_ACTIVE = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const SEGMENT_IDLE = "text-[var(--color-arco-muted-text)]"
const CARD = "rounded-[var(--radius-funds-row)] border border-[var(--color-funds-row-line)] bg-[var(--color-arco-surface)]"
const FOCUS = "rounded-[var(--radius-control)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

/** The round direction chip: neutral in, the up-green tint out, amber while a redemption is pending. */
const DIRECTION_CHIP: Record<ActivityDirection, string> = {
  in: "bg-[var(--color-arco-chip)] text-[var(--color-arco-ink)]",
  out: "bg-[var(--color-risk-low-bg)] text-[var(--color-risk-low-ink)]",
  pending: "bg-[var(--color-risk-medium-bg)] text-[var(--color-risk-medium-ink)]",
}
const DIRECTION_ICON: Record<ActivityDirection, typeof ArrowDown> = { in: ArrowDown, out: ArrowUp, pending: Clock }

const EMPTY_FILTERED: Record<ActivityFilter, string> = {
  all: "No indexed activity yet.",
  deposits: "No deposits yet.",
  withdrawals: "No withdrawals yet.",
}

/** "+$100.00", "−$100.42", "$0.00" — max 2 decimals as everywhere money shows. */
function signedMoney(usd: number): string {
  if (Math.abs(usd) < 0.005) return money(0)
  return `${usd > 0 ? "+" : "−"}${money(Math.abs(usd))}`
}

export type PortfolioActivityProps = {
  status: "loading" | "ready"
  /** The built feed (buildActivityFeed), newest first. */
  rows: readonly ActivityRow[]
  assetUsdOf: AssetUsdOf
  /** Null while the hero's Supplied is not known ("—" there too). */
  summary: ActivitySummary | null
  /** Notes under the summary after "Values at today's prices." (Partial, closed positions, ArcoUSD). */
  notes: readonly string[]
}

export function PortfolioActivity({ status, rows, assetUsdOf, summary, notes }: PortfolioActivityProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all")
  const baseId = useId()
  const shown = filterActivity(rows, filter)
  return (
    <div data-testid="portfolio-activity" className="w-full space-y-3.5">
      <h2 className="sr-only">Activity</h2>
      <div className="space-y-2">
        {/* Three across; under 375px the figures do not fit side by side, so each card is a row. */}
        <dl className="grid grid-cols-1 gap-1.5 min-[375px]:grid-cols-3 sm:gap-2.5">
          <SummaryCard
            label="Deposited"
            testId="activity-deposited"
            value={summary ? (summary.deposited >= 0.005 ? `+${money(summary.deposited)}` : money(0)) : "—"}
            tone={summary && summary.deposited >= 0.005 ? GREEN : summary ? INK : SOFT}
          />
          <SummaryCard
            label="Withdrawn"
            testId="activity-withdrawn"
            value={summary ? (summary.withdrawn >= 0.005 ? `−${money(summary.withdrawn)}` : money(0)) : "—"}
            tone={summary ? INK : SOFT}
          />
          <SummaryCard label="Net supplied" testId="activity-net-supplied" value={summary ? money(summary.netSupplied) : "—"} tone={summary ? INK : SOFT} />
        </dl>
        <div data-testid="activity-notes" className={`space-y-0.5 px-1 text-xs ${SOFT}`}>
          <p>Values at today&apos;s prices.</p>
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      </div>

      <div role="group" aria-label="Activity filter" className="inline-flex max-w-full flex-wrap rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-sm">
        {ACTIVITY_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={`rounded-[var(--radius-pill)] px-3 py-1.5 sm:px-4 ${filter === option.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div data-testid="activity-feed" className={`${CARD} px-3.5 pb-2 pt-1 sm:px-5 sm:pb-2.5 sm:pt-1.5`}>
        {status === "loading" ? (
          <p role="status" className={`py-10 text-center text-sm ${SOFT}`}>Loading your activity…</p>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center">
            <p className={`text-sm font-medium ${INK}`}>{EMPTY_FILTERED[filter]}</p>
            {filter === "all" && <p className={`mt-1 text-sm ${SOFT}`}>Your deposits and withdrawals on GIWA will appear here.</p>}
          </div>
        ) : (
          groupActivityByDay(shown).map((day) => (
            <section key={day.key} aria-labelledby={`${baseId}-${day.key}`}>
              <h3 id={`${baseId}-${day.key}`} className={`pb-1 pt-3.5 text-xs font-normal ${SOFT}`}>{day.label}</h3>
              <ul aria-labelledby={`${baseId}-${day.key}`}>
                {day.rows.map((row) => (
                  <ActivityItem key={row.key} row={row} usd={activityUsd(row, assetUsdOf)} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, tone, testId }: { label: string; value: string; tone: string; testId: string }) {
  return (
    <div className={`${CARD} flex min-w-0 items-baseline justify-between gap-1 px-3.5 py-2.5 min-[375px]:flex-col min-[375px]:items-stretch min-[375px]:justify-start min-[375px]:px-2.5 sm:gap-1.5 sm:px-[18px] sm:py-3.5`}>
      <dt className={`text-[11px] sm:text-[13px] ${SOFT}`}>{label}</dt>
      <dd data-testid={testId} className={`font-mono text-[13px] font-medium leading-tight tabular-nums [overflow-wrap:anywhere] sm:text-xl ${tone}`}>
        {value}
      </dd>
    </div>
  )
}

function ActivityItem({ row, usd }: { row: ActivityRow; usd: number | null }) {
  const Icon = DIRECTION_ICON[row.direction]
  const amount = token(row.tokenAmount, row.product.symbol)
  const time = activityTimeLabel(row.sortTs)
  const value = usd !== null ? signedMoney(usd) : "—"
  const valueTone = usd === null ? SOFT : row.direction === "in" && Math.abs(usd) >= 0.005 ? GREEN : INK
  // Read as one sentence; the visible parts below are its parts again, hidden from screen readers.
  const sentence = `${row.typeLabel}, ${amount} (${row.product.name}), ${usd !== null ? value : "value unavailable"}, ${activityDayLabel(row.sortTs)}${time ? ` at ${time}` : ""}.`
  const txLabel = row.txHash ? `View transaction ${shortAddr(row.txHash)} on the explorer` : ""
  return (
    <li data-activity={row.key} className="flex items-center gap-3 border-t border-[var(--color-funds-row-line)] py-2.5 first:border-t-0">
      <span className="sr-only">{sentence}</span>
      <span aria-hidden="true" className={`grid size-[26px] shrink-0 place-items-center rounded-[var(--radius-pill)] ${DIRECTION_CHIP[row.direction]}`}>
        <Icon className="size-3.5" strokeWidth={2.25} />
      </span>
      <span aria-hidden="true" className="hidden shrink-0 sm:block">
        <GiwaBrandMark src={row.product.imageUrl} label={row.product.symbol} size={34} />
      </span>
      <div aria-hidden="true" className="min-w-0 flex-1">
        <p className={`text-[15px] font-medium leading-5 ${INK}`}>{row.typeLabel}</p>
        <p className={`mt-0.5 text-xs [overflow-wrap:anywhere] ${SOFT}`}>
          {row.product.name} · {amount}
          {time && <span className="hidden sm:inline"> · {time}</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
        <span aria-hidden="true" data-cell="usd" className={`whitespace-nowrap font-mono text-sm tabular-nums ${valueTone}`}>{value}</span>
        {row.txHash ? (
          <>
            <a
              href={explorerTx(row.txHash)}
              target="_blank"
              rel="noreferrer"
              aria-label={txLabel}
              className={`hidden items-center gap-1 font-mono text-xs text-[var(--color-arco-text-soft)] hover:text-[var(--color-arco-ink)] sm:inline-flex ${FOCUS}`}
            >
              {shortAddr(row.txHash)}
              <ExternalLink aria-hidden="true" className={`size-3 ${SOFT}`} />
            </a>
            {/* Phones: the time under the value, still opening the transaction. */}
            <a href={explorerTx(row.txHash)} target="_blank" rel="noreferrer" aria-label={txLabel} className={`text-xs ${SOFT} sm:hidden ${FOCUS}`}>
              {time ?? "—"}
            </a>
          </>
        ) : (
          time && <span aria-hidden="true" className={`text-xs ${SOFT} sm:hidden`}>{time}</span>
        )}
      </div>
    </li>
  )
}
