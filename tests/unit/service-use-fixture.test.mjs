import { describe, expect, it } from 'vitest';
import { createServiceFixture } from '../../scripts/service-use-fixture.mjs';

function action(item, patch = {}) {
  return { token: item.token, url: item.url, clickEpochMs: performance.timeOrigin + performance.now(),
    clickWallEpochMs: Date.now(), hidden: false, ...patch };
}

async function send(fixture, item, payload) {
  return fetch(`${fixture.baseUrl}/accept/${item.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
}

describe('independent local acceptance ledger', () => {
  it('records a real HTTP acknowledgement through a pre-subscribed receipt', async () => {
    // Given
    const fixture = await createServiceFixture();
    const item = fixture.register('accepted');
    try {
      // When
      const response = await send(fixture, item, action(item));
      const receipt = await item.receipt;
      // Then
      expect(response.status).toBe(200);
      expect(receipt).toMatchObject({ accepted: true, duplicate: false, early: false });
      expect(fixture.attempts).toEqual(item.receipts);
      expect(item.receipts).toHaveLength(1);
    } finally { expect(await fixture.close()).toMatchObject({ closed: true }); }
  });

  it('keeps duplicate attempts visible instead of masking them with deduplication', async () => {
    // Given
    const fixture = await createServiceFixture();
    const item = fixture.register('duplicate');
    await send(fixture, item, action(item));
    try {
      // When
      const response = await send(fixture, item, action(item));
      // Then
      expect(response.status).toBe(409);
      expect(item.receipts).toHaveLength(2);
      expect(item.receipts[1]).toMatchObject({ duplicate: true, accepted: false });
    } finally { await fixture.close(); }
  });

  it('rejects cross-case action evidence without adding an accepted receipt', async () => {
    // Given
    const fixture = await createServiceFixture();
    const item = fixture.register('bound');
    try {
      // When
      const response = await send(fixture, item, action(item, { url: `${item.url}/other` }));
      // Then
      expect(response.status).toBe(400);
      expect(fixture.attempts).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('records and rejects an action timestamp before its approved boundary', async () => {
    // Given
    const fixture = await createServiceFixture();
    const item = fixture.register('early', { at: 1 });
    try {
      // When
      const response = await send(fixture, item, action(item, { clickWallEpochMs: 0, clickEpochMs: 0 }));
      // Then
      expect(response.status).toBe(409);
      expect(await item.receipt).toMatchObject({ accepted: false, early: true });
      expect(item.receipts).toHaveLength(1);
    } finally { await fixture.close(); }
  });
});
