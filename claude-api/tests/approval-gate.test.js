const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { proposePending, getPending, approvePending, consumeApproval, clearPending } = require('../approval-gate');

describe('Approval gate', () => {
  const uid = 'test-user-' + Date.now();

  it('proposePending stores actions', () => {
    proposePending(uid, 'unsub', [
      { label: 'spam@example.com (10 emails)', meta: { sender: 'spam@example.com', messageId: 'msg1' } },
      { label: 'news@example.com (5 emails)', meta: { sender: 'news@example.com', messageId: 'msg2' } },
    ]);
    const pending = getPending(uid, 'unsub');
    assert.equal(pending.length, 2);
    assert.equal(pending[0].id, 1);
    assert.equal(pending[1].id, 2);
    assert.equal(pending[0].approved, false);
  });

  it('approvePending by number', () => {
    const result = approvePending(uid, 'unsub', 1);
    assert.ok(result.approved.includes(1));
    const pending = getPending(uid, 'unsub');
    assert.equal(pending[0].approved, true);
    assert.equal(pending[1].approved, false);
  });

  it('consumeApproval succeeds for approved item', () => {
    const meta = consumeApproval(uid, 'unsub', m => m.sender === 'spam@example.com');
    assert.ok(meta);
    assert.equal(meta.sender, 'spam@example.com');
    assert.equal(meta.messageId, 'msg1');
  });

  it('consumeApproval returns null on second attempt (one-time use)', () => {
    const meta = consumeApproval(uid, 'unsub', m => m.sender === 'spam@example.com');
    assert.equal(meta, null);
  });

  it('consumeApproval returns null for unapproved item', () => {
    const meta = consumeApproval(uid, 'unsub', m => m.sender === 'news@example.com');
    assert.equal(meta, null);
  });

  it('approvePending "all" approves remaining', () => {
    approvePending(uid, 'unsub', 'all');
    const pending = getPending(uid, 'unsub');
    assert.ok(pending.every(p => p.approved));
  });

  it('clearPending removes all', () => {
    clearPending(uid, 'unsub');
    const pending = getPending(uid, 'unsub');
    assert.equal(pending, null);
  });

  it('getPending returns null for unknown user', () => {
    assert.equal(getPending('nobody', 'unsub'), null);
  });

  it('approvePending returns notFound for empty store', () => {
    const result = approvePending('nobody', 'unsub', 1);
    assert.ok(result.notFound);
  });
});
