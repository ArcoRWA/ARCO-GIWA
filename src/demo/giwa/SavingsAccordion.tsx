// The Savings sections under the card (Backing, Liquidity, Simulation) as rows of one card, hairlines between them.
// Each row opens and closes on its own: a button with its icon, title and a chevron (down when closed, up when open),
// a one-line summary on the right of a closed row from `sm` up, and an optional preview under the title that shows
// open or closed (the Backing bar). The preview sits beside the button, not in it, so it may hold controls of its own;
// a click anywhere else on the header still toggles the row. The rows stay one flat list, so the button that was
// pressed keeps focus.

import { useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"

export type SavingsSection = Readonly<{
  id: string
  title: string
  icon: ReactNode
  /** One line on the right of the closed row ("Instant liquidity: $5.17K"), or null. Hidden on phones. */
  summary: ReactNode | null
  /**
   * Shown under the title in the row's header, open or closed (the Backing bar); read as the row's description. It
   * lets clicks through to the row's button: a control in it opts back in with `pointer-events-auto`.
   */
  preview?: ReactNode
  content: ReactNode
}>

export function SavingsAccordion({ sections, initialOpen = null }: { sections: readonly SavingsSection[]; initialOpen?: string | null }) {
  const baseId = useId()
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set(initialOpen !== null ? [initialOpen] : []))
  const last = sections.length - 1

  function toggle(id: string) {
    setOpenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="w-full rounded-[22px] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
      {sections.map((section, index) => {
        const open = openIds.has(section.id)
        const buttonId = `${baseId}-${section.id}-button`
        const titleId = `${baseId}-${section.id}-title`
        const previewId = `${baseId}-${section.id}-preview`
        const panelId = `${baseId}-${section.id}-panel`
        const hasPreview = section.preview !== undefined && section.preview !== null
        return (
          <div
            key={section.id}
            data-section={section.id}
            data-open={open ? "true" : "false"}
            className={`w-full ${index === 0 ? "" : "border-t border-[var(--color-arco-border)]"}`}
          >
            {/* The header: the button (icon, title, summary, chevron) and, beside it rather than inside it, the preview,
                which may hold controls of its own (the Backing bar's slices). The button's ::after stretches over the
                whole header, so a click anywhere on it toggles the row and its focus ring frames the whole header; the
                preview sits above that layer but lets clicks through, except on its own controls. */}
            <div className="relative flex min-h-[60px] w-full flex-col justify-center gap-3 px-5 py-4 sm:px-6">
              <h3>
                <button
                  id={buttonId}
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  aria-labelledby={titleId}
                  aria-describedby={hasPreview ? previewId : undefined}
                  onClick={() => toggle(section.id)}
                  className={`flex w-full items-center gap-2.5 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-[var(--color-arco-ink)] ${
                    index === 0 ? "after:rounded-t-[21px]" : ""
                  } ${index === last && !open ? "after:rounded-b-[21px]" : ""}`}
                >
                  <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--color-arco-text-soft)]">
                    {section.icon}
                  </span>
                  <span id={titleId} className="text-[15px] font-medium text-[var(--color-arco-ink)]">
                    {section.title}
                  </span>
                  <span className="ml-auto flex min-w-0 items-center gap-3">
                    {!open && section.summary !== null && (
                      <span className="hidden truncate text-[13px] tabular-nums text-[var(--color-arco-text-soft)] sm:inline">{section.summary}</span>
                    )}
                    <ChevronDown
                      aria-hidden="true"
                      className={`size-4 shrink-0 text-[var(--color-arco-ink)] transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>
              </h3>
              {hasPreview && (
                <div id={previewId} className="pointer-events-none relative z-10 w-full">
                  {section.preview}
                </div>
              )}
            </div>
            <div id={panelId} role="region" aria-labelledby={titleId} hidden={!open} className="px-5 pb-6 sm:px-6">
              {open && section.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}
