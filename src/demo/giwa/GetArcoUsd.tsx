// Get ArcoUSD: converts a stablecoin to ArcoUSD one for one, or ArcoUSD back to a stablecoin, on the Savings transfer
// screen titled Convert. The shell's nav carries its trigger, Convert (the desktop rail and the phone tab bar,
// GiwaNavRail.tsx). Shown only where there are converters (ArcoUsdConvertContext): the live ArcoUSD v1 Reserve
// (arcousd-live-context.tsx), or a preview's demo chain. The screen loads on the first press, so the shell every page
// shares carries only this provider; there is one screen however many triggers the shell shows.

import { Suspense, createContext, lazy, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { ArcoUsdConvertContext } from "./savings-routes"

const ArcoUsdConvertScreen = lazy(() => import("./ArcoUsdConvertScreen"))

/** Opens the Convert screen; null where there are no converters (then there is no Convert). */
const GetArcoUsdContext = createContext<(() => void) | null>(null)

export function useGetArcoUsd(): (() => void) | null {
  return useContext(GetArcoUsdContext)
}

export function GetArcoUsdProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const convert = useContext(ArcoUsdConvertContext)
  const [open, setOpen] = useState(false)
  // The screen, and its reads, start on the first press and then stay: a conversion left running finishes in it.
  const [started, setStarted] = useState(false)
  const show = useCallback(() => {
    setStarted(true)
    setOpen(true)
  }, [])
  const available = enabled && convert !== null && convert.converters.length > 0
  const value = useMemo(() => (available ? show : null), [available, show])
  return (
    <GetArcoUsdContext.Provider value={value}>
      {children}
      {available && started && (
        <Suspense fallback={null}>
          <ArcoUsdConvertScreen convert={convert} open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </GetArcoUsdContext.Provider>
  )
}
