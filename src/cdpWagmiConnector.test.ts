/**
 * The connector behaviours the cold-start reconnect fix depends on:
 *
 *  - isAuthorized() mirrors the CDP bridge. During the cold-start race it reads
 *    false (CDP not yet restored), which is exactly why wagmi's early reconnect
 *    drops the connector; once CDP restores it reads true and a deferred
 *    reconnect adopts the session.
 *  - connect() adopts an existing CDP session WITHOUT firing the email-OTP modal
 *    — on reconnect, and also on a fresh connect when a session already exists
 *    (calling signInWithEmail again throws "user is already authenticated").
 *    This is the "tap the button and it takes me right through" path.
 */

// @wagmi/core ships ESM that jest doesn't transform. createConnector is just an
// identity wrapper (returns the factory fn), so stub it rather than pull the
// whole ESM package through the transformer.
jest.mock('@wagmi/core', () => ({ createConnector: (fn: unknown) => fn }));

// cdpWagmiConnector → cdpEip1193 → cdpAccount → @coinbase/cdp-core. Mock the
// core so the connector loads without the native/browser CDP runtime.
jest.mock('@coinbase/cdp-core', () => ({ signOut: jest.fn(async () => {}) }));

import { cdpWagmiConnector, registerCdpAuthRequester } from './cdpWagmiConnector';
import { setCdpState } from './cdpBridge';
import * as core from '@coinbase/cdp-core';
import type { CdpWalletConfig } from './cdpConfig';

const cfg: CdpWalletConfig = { chainId: 84532, rpcUrl: 'http://localhost:8545', cdpNetwork: 'base-sepolia' };

// createConnector() just returns the factory fn; call it with a minimal config
// (only emitter is touched, and only by event paths these tests don't exercise).
function makeConnector(): any {
  const fn = cdpWagmiConnector(cfg) as any;
  return fn({ emitter: { emit: jest.fn() } });
}

beforeEach(() => {
  jest.clearAllMocks();
  registerCdpAuthRequester(null);
  setCdpState({ evmAddress: null, evmEoaAddress: null, initialized: false, signedIn: false });
});

describe('isAuthorized', () => {
  test('false while signed out (the cold-start race window)', async () => {
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(false);
  });

  test('false when signed in but the address has not propagated yet', async () => {
    setCdpState({ signedIn: true, evmAddress: null });
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(false);
  });

  test('true once signed in with an address (session restored)', async () => {
    setCdpState({ signedIn: true, evmAddress: '0xabc' });
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(true);
  });
});

describe('connect', () => {
  test('reconnect adopts the existing session without the OTP modal', async () => {
    setCdpState({ signedIn: true, evmAddress: '0xrestored' });
    const auth = jest.fn(async () => {});
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect({ isReconnecting: true });

    expect(auth).not.toHaveBeenCalled();
    expect(res).toEqual({ accounts: ['0xrestored'], chainId: cfg.chainId });
  });

  test('fresh connect with no session fires the OTP modal, then returns the new address', async () => {
    const auth = jest.fn(async () => {
      // The modal flow signs the user in; the bridge then carries the address.
      setCdpState({ signedIn: true, evmAddress: '0xfresh' });
    });
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ accounts: ['0xfresh'], chainId: cfg.chainId });
  });

  test('fresh connect adopts a pre-existing session instead of re-prompting', async () => {
    // wagmi storage cleared but the CDP session persisted: connect() is called
    // without isReconnecting, yet must NOT call signInWithEmail again.
    setCdpState({ signedIn: true, evmAddress: '0xadopted' });
    const auth = jest.fn(async () => {});
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).not.toHaveBeenCalled();
    expect(res).toEqual({ accounts: ['0xadopted'], chainId: cfg.chainId });
  });
});

describe('disconnect', () => {
  test('signs out of the shared CDP session', async () => {
    const c = makeConnector();
    await c.disconnect();
    expect(core.signOut).toHaveBeenCalledTimes(1);
  });
});
