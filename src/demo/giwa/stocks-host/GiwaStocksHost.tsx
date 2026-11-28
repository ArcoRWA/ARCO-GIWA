import { useMemo, type ReactNode } from "react"
import { ARCO_API_BASE } from "../config"
import { useGiwaWallet } from "../wallet"
import { signWithActiveGiwaWallet } from "./active-wallet"
import { StocksHostProvider } from "./StocksHostProvider"
import { StocksWalletCommandsContext } from "./wallet-commands"

const dependencies = { signMessage: signWithActiveGiwaWallet }

/**
 * Bridge BOTH existing wallet modes; connecting never automatically signs in. maxSessionMs: the longest
 * session this host accepts (default 15 minutes; the admin console passes 60 minutes).
 */
export function GiwaStocksHost({ children, maxSessionMs }: { children: ReactNode; maxSessionMs?: number }) {
  const wallet = useGiwaWallet()
  const hostDependencies = useMemo(() => (maxSessionMs === undefined ? dependencies : { ...dependencies, maxSessionMs }), [maxSessionMs])
  // Explicit user actions only (the Stocks trade panel's Connect / Switch buttons); never run on render.
  const { connect, switchToGiwa } = wallet
  const commands = useMemo(() => ({ connect: () => void connect().catch(() => {}), switchNetwork: () => void switchToGiwa().catch(() => {}) }), [connect, switchToGiwa])
  return (
    <StocksWalletCommandsContext.Provider value={commands}>
    <StocksHostProvider
      context={{ walletAddress: wallet.connected ? wallet.address : null, chainId: wallet.chainId, frontendOrigin: window.location.origin, apiBase: ARCO_API_BASE, walletEpoch: wallet.sessionEpoch }}
      signingReady={wallet.signingReady}
      walletSource={wallet.source}
      dependencies={hostDependencies}
    >{children}</StocksHostProvider>
    </StocksWalletCommandsContext.Provider>
  )
}
