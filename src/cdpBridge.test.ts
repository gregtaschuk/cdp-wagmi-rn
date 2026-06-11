/**
 * The bridge is the module-level singleton that carries CDP's async session
 * state out of the React tree to the wagmi connector and the cold-start
 * reconnect logic. These tests pin the behaviour the reconnect fix relies on:
 * subscribers fire on real transitions, and waitForCdpAddress resolves the
 * moment an address appears (the "adopt the restored session" handoff).
 */
import {
  getCdpState,
  setCdpState,
  subscribeCdpState,
  waitForCdpAddress,
} from './cdpBridge';

// Reset the singleton to signed-out between tests.
beforeEach(() => {
  setCdpState({ evmAddress: null, evmEoaAddress: null, initialized: false, signedIn: false });
});

describe('getCdpState / setCdpState', () => {
  test('starts signed-out and uninitialized', () => {
    expect(getCdpState()).toEqual({
      evmAddress: null,
      evmEoaAddress: null,
      initialized: false,
      signedIn: false,
    });
  });

  test('returns a copy, not the live object', () => {
    const a = getCdpState();
    a.signedIn = true;
    expect(getCdpState().signedIn).toBe(false);
  });

  test('patches only the provided keys', () => {
    setCdpState({ initialized: true });
    expect(getCdpState()).toMatchObject({ initialized: true, signedIn: false, evmAddress: null });
  });
});

describe('subscribeCdpState', () => {
  test('notifies on a real change with a snapshot', () => {
    const cb = jest.fn();
    const unsub = subscribeCdpState(cb);
    setCdpState({ initialized: true, signedIn: true, evmAddress: '0xabc' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ initialized: true, signedIn: true, evmAddress: '0xabc' });
    unsub();
  });

  test('does not notify when the patch changes nothing', () => {
    setCdpState({ initialized: true });
    const cb = jest.fn();
    const unsub = subscribeCdpState(cb);
    setCdpState({ initialized: true }); // no-op
    expect(cb).not.toHaveBeenCalled();
    unsub();
  });

  test('stops notifying after unsubscribe', () => {
    const cb = jest.fn();
    const unsub = subscribeCdpState(cb);
    unsub();
    setCdpState({ signedIn: true });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('waitForCdpAddress', () => {
  test('resolves immediately when an address is already present', async () => {
    setCdpState({ evmAddress: '0xalready' });
    await expect(waitForCdpAddress()).resolves.toBe('0xalready');
  });

  test('resolves once the address arrives later (post-restore handoff)', async () => {
    const p = waitForCdpAddress();
    setCdpState({ signedIn: true, evmAddress: '0xlater' });
    await expect(p).resolves.toBe('0xlater');
  });

  test('rejects after the timeout when no address ever arrives', async () => {
    jest.useFakeTimers();
    try {
      const p = waitForCdpAddress(1000);
      // Attach a catch synchronously so the rejection is never "unhandled"
      // between advancing timers and awaiting.
      const settled = expect(p).rejects.toThrow(/Timed out/);
      jest.advanceTimersByTime(1000);
      await settled;
    } finally {
      jest.useRealTimers();
    }
  });
});
