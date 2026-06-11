/**
 * wagmi Connector for the CDP smart-account wallet — the nucleus of a future
 * standalone `cdp-wagmi-rn` package.
 *
 * It wraps the pieces PR #14 established: `createCdpEip1193Provider` (the EIP-1193
 * view of the CDP capability core) as `getProvider()`, and `cdpBridge` for the
 * session state. For now it runs in **adopt mode** — it reflects the CDP session
 * the app already established via `useWalletSession` rather than owning it:
 *   - `connect()` waits for the existing signed-in address (no modal).
 *   - `disconnect()` is a no-op (the app owns real sign-out; tearing down the
 *     shared CDP session from here would log the user out of the whole app).
 * The future "own connection" variant injects the email-OTP modal trigger into
 * `connect()` and lets wagmi drive sign-in.
 */

import { createConnector } from '@wagmi/core';
import type { CreateConnectorFn } from '@wagmi/core';
import { ethers } from 'ethers';
import { createCdpEip1193Provider } from './cdpEip1193';
import { getCdpState, subscribeCdpState, waitForCdpAddress } from './cdpBridge';
import { signOut as cdpSignOut } from '@coinbase/cdp-core';
import type { CdpWalletConfig } from './cdpConfig';
import type { Eip1193Provider } from 'ethers';

type Address = `0x${string}`;

// App registers a fn that shows the CDP email-OTP modal and resolves once
// sign-in completes (rejects on cancel). The connector calls it on a fresh
// connect; on reconnect it's skipped (CDP auto-restores silently).
let authRequester: (() => Promise<void>) | null = null;
export function registerCdpAuthRequester(fn: (() => Promise<void>) | null): void {
  authRequester = fn;
}

export function cdpWagmiConnector(cfg: CdpWalletConfig): CreateConnectorFn {
  // Lazily-built singletons so getProvider() is stable across calls.
  let provider: Eip1193Provider | null = null;
  let unsubscribe: (() => void) | null = null;

  function getOrCreateProvider(): Eip1193Provider {
    if (!provider) {
      const readProvider = new ethers.JsonRpcProvider(
        cfg.rpcUrl,
        { name: cfg.cdpNetwork, chainId: cfg.chainId },
        { staticNetwork: true },
      );
      provider = createCdpEip1193Provider({
        smartAccount: getCdpState().evmAddress ?? '',
        readProvider,
        cfg,
      });
    }
    return provider;
  }

  return createConnector((config) => ({
    id: 'cdp',
    name: 'CDP Embedded Wallet',
    type: 'cdp' as const,

    async setup() {
      // Translate CDP bridge transitions into wagmi connector events so
      // `useAccount()` stays in step (e.g. external sign-out elsewhere).
      if (!unsubscribe) {
        let last = getCdpState().evmAddress ?? null;
        unsubscribe = subscribeCdpState((s) => {
          const next = s.evmAddress ?? null;
          if (next === last) return;
          last = next;
          if (!next) {
            config.emitter.emit('disconnect');
          } else {
            config.emitter.emit('change', { accounts: [next as Address] });
          }
        });
      }
    },

    // Cast: wagmi v3 types `connect` with a conditional EIP-5792 `withCapabilities`
    // return that a hand-authored connector can't satisfy structurally. The
    // runtime shape ({ accounts, chainId }) is correct for the default case.
    connect: (async (params?: { isReconnecting?: boolean }) => {
      // Drive the email-OTP modal only for a fresh connect when CDP is NOT
      // already authenticated. If a CDP session already exists — reconnect, or
      // wagmi state diverged from CDP's own (e.g. wagmi storage cleared while
      // the CDP session persisted) — adopt it instead. Calling signInWithEmail
      // again throws "user is already authenticated".
      const alreadyAuthed = getCdpState().signedIn && !!getCdpState().evmAddress;
      if (!params?.isReconnecting && !alreadyAuthed && authRequester) {
        await authRequester();
      }
      const address = await waitForCdpAddress();
      return { accounts: [address as Address], chainId: cfg.chainId };
    }) as never,

    async disconnect() {
      try {
        await cdpSignOut();
      } catch (err: any) {
        console.warn('[cdp] signOut error', err?.message ?? err);
      }
    },

    async getAccounts() {
      const a = getCdpState().evmAddress;
      return (a ? [a as Address] : []) as readonly Address[];
    },

    async getChainId() {
      return cfg.chainId;
    },

    async getProvider() {
      return getOrCreateProvider();
    },

    async isAuthorized() {
      const s = getCdpState();
      return s.signedIn && !!s.evmAddress;
    },

    onAccountsChanged(accounts: string[]) {
      if (accounts.length === 0) config.emitter.emit('disconnect');
      else config.emitter.emit('change', { accounts: accounts as Address[] });
    },

    onChainChanged(chainId: string) {
      config.emitter.emit('change', { chainId: Number(chainId) });
    },

    onDisconnect() {
      config.emitter.emit('disconnect');
    },
  }));
}
