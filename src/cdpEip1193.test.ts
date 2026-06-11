/**
 * cdpEip1193 routes EIP-1193 methods to the CDP capability core and forwards
 * reads. The core is mocked so this stays a pure routing test (no cdp-core).
 */

jest.mock('./cdpAccount', () => ({
  cdpGetAddress: jest.fn(() => '0xSmartAccount'),
  cdpSignMessage: jest.fn(async () => '0xsigMsg'),
  cdpSignTypedData: jest.fn(async () => '0xsigTd'),
  cdpSendCalls: jest.fn(async () => '0xTxHash'),
}));

import { createCdpEip1193Provider } from './cdpEip1193';
import * as core from './cdpAccount';
import type { CdpWalletConfig } from './cdpConfig';

const CHAIN_ID = 84532;
const cfg: CdpWalletConfig = { chainId: CHAIN_ID, rpcUrl: 'http://localhost', cdpNetwork: 'base-sepolia' };

function makeProvider() {
  const readProvider = {
    send: jest.fn(async () => '0xread'),
    getTransactionReceipt: jest.fn(async () => null),
  } as any;
  const provider = createCdpEip1193Provider({ smartAccount: '0xSmartAccount', readProvider, cfg });
  return { provider, readProvider };
}

beforeEach(() => jest.clearAllMocks());

test('eth_accounts / eth_requestAccounts return the smart account', async () => {
  const { provider } = makeProvider();
  expect(await provider.request({ method: 'eth_accounts' })).toEqual(['0xSmartAccount']);
  expect(await provider.request({ method: 'eth_requestAccounts' })).toEqual(['0xSmartAccount']);
});

test('eth_chainId returns the configured chain', async () => {
  const { provider } = makeProvider();
  expect(await provider.request({ method: 'eth_chainId' })).toBe(`0x${CHAIN_ID.toString(16)}`);
});

test('personal_sign routes to cdpSignMessage with the provider chain envelope', async () => {
  const { provider, readProvider } = makeProvider();
  const sig = await provider.request({ method: 'personal_sign', params: ['0xdeadbeef', '0xSmartAccount'] });
  expect(sig).toBe('0xsigMsg');
  // A generic wallet signs messages against its own chain (cfg.chainId).
  expect(core.cdpSignMessage).toHaveBeenCalledWith(
    expect.anything(),
    '0xSmartAccount',
    readProvider,
    expect.objectContaining({ chainId: CHAIN_ID }),
  );
});

test('eth_signTypedData_v4 parses JSON and routes to cdpSignTypedData', async () => {
  const { provider } = makeProvider();
  const td = { domain: { chainId: CHAIN_ID }, types: { Foo: [{ name: 'x', type: 'uint256' }] }, message: { x: 1 } };
  const sig = await provider.request({ method: 'eth_signTypedData_v4', params: ['0xSmartAccount', JSON.stringify(td)] });
  expect(sig).toBe('0xsigTd');
  expect(core.cdpSignTypedData).toHaveBeenCalledWith(
    td.domain, td.types, td.message, '0xSmartAccount',
    expect.objectContaining({ chainId: CHAIN_ID }),
  );
});

test('eth_sendTransaction maps to a single-call cdpSendCalls', async () => {
  const { provider } = makeProvider();
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ to: '0xTo', value: '0x10', data: '0xabcd' }],
  });
  expect(hash).toBe('0xTxHash');
  expect(core.cdpSendCalls).toHaveBeenCalledWith(
    [{ to: '0xTo', value: 16n, data: '0xabcd' }], '0xSmartAccount',
    { cdpNetwork: 'base-sepolia' },
  );
});

test('wallet_sendCalls (EIP-5792) batches and returns an id', async () => {
  const { provider } = makeProvider();
  const res = await provider.request({
    method: 'wallet_sendCalls',
    params: [{ calls: [{ to: '0xA', data: '0x01' }, { to: '0xB' }] }],
  });
  expect(res).toEqual({ id: '0xTxHash' });
  expect(core.cdpSendCalls).toHaveBeenCalledWith(
    [{ to: '0xA', value: undefined, data: '0x01' }, { to: '0xB', value: undefined, data: undefined }],
    '0xSmartAccount',
    { cdpNetwork: 'base-sepolia' },
  );
});

test('wallet_getCallsStatus returns PENDING with no receipts while unmined', async () => {
  const { provider, readProvider } = makeProvider();
  readProvider.getTransactionReceipt.mockResolvedValueOnce(null);
  const res = await provider.request({ method: 'wallet_getCallsStatus', params: ['0xTxHash'] });
  expect(res).toEqual({ status: 'PENDING', receipts: [] });
});

test('wallet_getCallsStatus returns a viem-formattable receipt (gasUsed + logs present)', async () => {
  // viem's getCallsStatus runs `hexToBigInt(receipt.gasUsed)` (and reads
  // `receipt.logs` for the batched startRental event parse). When the CDP
  // handler omitted gasUsed, `hexToBigInt(undefined)` → `BigInt(undefined)` →
  // "Invalid argument to BigInt()" the instant a CDP batch (extend/start)
  // confirmed. Every field viem hex-decodes must be a present hex string.
  const { provider, readProvider } = makeProvider();
  const logs = [{ address: '0xEscrow', topics: ['0xtopic'], data: '0xdata' }];
  readProvider.getTransactionReceipt.mockResolvedValueOnce({
    hash: '0xTxHash',
    blockHash: '0xBlockHash',
    blockNumber: 123,
    status: 1,
    gasUsed: 21000n,
    logs,
  });
  const res = await provider.request({ method: 'wallet_getCallsStatus', params: ['0xTxHash'] });
  const receipt = res.receipts[0];
  expect(receipt.gasUsed).toBe('0x5208'); // 21000 — the field that threw when undefined
  expect(receipt.blockNumber).toBe('0x7b'); // 123
  expect(receipt.status).toBe('0x1');
  expect(receipt.transactionHash).toBe('0xTxHash');
  expect(receipt.blockHash).toBe('0xBlockHash');
  expect(receipt.logs).toBe(logs); // batched startRental reads receipt.logs
});

test('wallet_getCapabilities advertises paymaster sponsorship', async () => {
  const { provider } = makeProvider();
  const caps = await provider.request({ method: 'wallet_getCapabilities' });
  expect(caps[`0x${CHAIN_ID.toString(16)}`].paymasterService.supported).toBe(true);
});

test('unknown methods forward to the read provider', async () => {
  const { provider, readProvider } = makeProvider();
  const res = await provider.request({ method: 'eth_getBalance', params: ['0xabc', 'latest'] });
  expect(res).toBe('0xread');
  expect(readProvider.send).toHaveBeenCalledWith('eth_getBalance', ['0xabc', 'latest']);
});
