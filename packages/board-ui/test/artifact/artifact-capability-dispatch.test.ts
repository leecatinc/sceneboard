import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactCapabilityDispatcherV1 } from '../../src/artifact/artifact-capability-dispatch.js';

const REQUEST_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ID = 'BBBBBBBBBBBBBBBBBBBBBB';

const action = (requestId = REQUEST_ID) => ({
  type: 'artifact.user-action' as const,
  requestId,
  capability: 'clipboard.write' as const,
});
const request = (payload: Record<string, unknown>, requestId = REQUEST_ID) => ({
  type: 'artifact.capability.request' as const,
  requestId,
  capability: 'clipboard.write' as const,
  payload,
});
const fixture = (
  overrides: {
    requested?: boolean;
    allowed?: boolean;
    now?: number;
    rejectWrite?: boolean;
  } = {},
) => {
  let currentNow = overrides.now ?? 100;
  const writes: string[] = [];
  const dispatcher = new ArtifactCapabilityDispatcherV1({
    requestedCapabilities: overrides.requested === false ? [] : ['clipboard.write'],
    allowedCapabilities: overrides.allowed === false ? [] : ['clipboard.write'],
    capabilityEpoch: 1,
    writeClipboard: async (text) => {
      if (overrides.rejectWrite) throw new TypeError('private browser failure');
      writes.push(text);
    },
    now: () => currentNow,
  });
  return {
    dispatcher,
    writes,
    setNow(value: number) {
      currentNow = value;
    },
  };
};

test('matching admitted action writes exact bounded text once and returns byte length', async () => {
  const value = fixture();
  value.dispatcher.admitAction(action());
  assert.deepEqual(await value.dispatcher.dispatch(request({ text: '한글 JSON' })), {
    ok: true,
    result: { byteLength: 11 },
  });
  assert.deepEqual(value.writes, ['한글 JSON']);
  assert.deepEqual(await value.dispatcher.dispatch(request({ text: 'replay' })), {
    ok: false,
    error: 'activation_required',
  });
});

test('non-clipboard requests and binary payloads remain unavailable to the dispatcher', async () => {
  const value = fixture();
  value.dispatcher.admitAction({
    type: 'artifact.user-action',
    requestId: REQUEST_ID,
    capability: 'download',
  });
  assert.deepEqual(
    await value.dispatcher.dispatch({
      type: 'artifact.capability.request',
      requestId: REQUEST_ID,
      capability: 'download',
      payload: {},
    }),
    { ok: false, error: 'invalid_request' },
  );
  value.dispatcher.admitAction(action());
  assert.deepEqual(
    await value.dispatcher.dispatch(request({ text: 'safe' }), new Uint8Array([1]).buffer),
    { ok: false, error: 'invalid_request' },
  );
  assert.deepEqual(value.writes, []);
});

test('manifest and policy failures are closed and call clipboard zero times', async () => {
  for (const [overrides, error] of [
    [{ requested: false }, 'not_requested'],
    [{ allowed: false }, 'policy_denied'],
  ] as const) {
    const value = fixture(overrides);
    value.dispatcher.admitAction(action());
    assert.deepEqual(await value.dispatcher.dispatch(request({ text: 'safe' })), {
      ok: false,
      error,
    });
    assert.deepEqual(value.writes, []);
  }
});

test('expiry, mismatch, policy generation change and competing actions fail closed', async () => {
  const expired = fixture();
  expired.dispatcher.admitAction(action());
  expired.setNow(1_601);
  assert.deepEqual(await expired.dispatcher.dispatch(request({ text: 'safe' })), {
    ok: false,
    error: 'activation_expired',
  });

  const mismatch = fixture();
  mismatch.dispatcher.admitAction(action());
  assert.deepEqual(await mismatch.dispatcher.dispatch(request({ text: 'safe' }, OTHER_ID)), {
    ok: false,
    error: 'activation_required',
  });

  const revoked = fixture();
  revoked.dispatcher.admitAction(action());
  revoked.dispatcher.updateAllowedCapabilities([], 2);
  assert.deepEqual(await revoked.dispatcher.dispatch(request({ text: 'safe' })), {
    ok: false,
    error: 'revoked',
  });

  const competing = fixture();
  competing.dispatcher.admitAction(action());
  competing.dispatcher.admitAction(action(OTHER_ID));
  assert.deepEqual(await competing.dispatcher.dispatch(request({ text: 'safe' })), {
    ok: false,
    error: 'activation_required',
  });
  assert.deepEqual(competing.writes, []);
});

test('an authority epoch change revokes admission even when the allow-list is unchanged', async () => {
  const value = fixture();
  value.dispatcher.admitAction(action());
  value.dispatcher.updateAllowedCapabilities(['clipboard.write'], 2);
  assert.deepEqual(await value.dispatcher.dispatch(request({ text: 'stale authority' })), {
    ok: false,
    error: 'revoked',
  });
  assert.deepEqual(value.writes, []);
});

test('payload keys, scalar validity and byte limit are exact', async () => {
  for (const payload of [
    {},
    { text: 'safe', extra: true },
    { text: new Uint8Array([1]) },
    { text: '\ud800' },
    { text: 'a'.repeat(49_153) },
  ]) {
    const value = fixture();
    value.dispatcher.admitAction(action());
    assert.deepEqual(await value.dispatcher.dispatch(request(payload)), {
      ok: false,
      error: 'invalid_request',
    });
    assert.deepEqual(value.writes, []);
  }
  const maximum = fixture();
  maximum.dispatcher.admitAction(action());
  assert.equal((await maximum.dispatcher.dispatch(request({ text: 'a'.repeat(49_152) }))).ok, true);
});

test('browser rejection is redacted', async () => {
  const rejected = fixture({ rejectWrite: true });
  rejected.dispatcher.admitAction(action());
  assert.deepEqual(await rejected.dispatcher.dispatch(request({ text: 'secret text' })), {
    ok: false,
    error: 'unavailable',
  });
});
