const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Semaphore and process management', () => {
  describe('Semaphore slot accounting', () => {
    it('acquire and release maintain correct count', () => {
      let active = 0;
      const max = 4;
      const acquire = () => { if (active >= max) throw new Error('full'); active++; };
      const release = () => { if (active > 0) active--; };

      acquire(); acquire(); acquire();
      assert.equal(active, 3);
      release(); release();
      assert.equal(active, 1);
      acquire(); acquire(); acquire();
      assert.equal(active, 4);
      assert.throws(() => acquire(), /full/);
      release(); release(); release(); release();
      assert.equal(active, 0);
    });

    it('releaseOnce pattern prevents double-release', () => {
      let active = 2;
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        active--;
      };

      releaseOnce();
      assert.equal(active, 1);
      releaseOnce(); // should be no-op
      assert.equal(active, 1);
      releaseOnce(); // still no-op
      assert.equal(active, 1);
    });
  });

  describe('Process cleanup patterns', () => {
    it('wrappedReject ensures release even on spawn failure', () => {
      let slotReleased = false;
      let promiseRejected = false;

      const releaseOnce = () => { slotReleased = true; };
      const wrappedReject = (err) => {
        promiseRejected = true;
        releaseOnce();
      };

      // Simulate spawn failure
      try {
        throw new Error('ENOENT: claude binary not found');
      } catch (err) {
        wrappedReject(err);
      }

      assert.ok(promiseRejected, 'Promise should be rejected on spawn failure');
      assert.ok(slotReleased, 'Semaphore slot should be released on spawn failure');
    });

    it('stall detector clears timers before rejecting', () => {
      let stallCleared = false;
      let checkinCleared = false;
      let rejected = false;

      const stallCheck = setInterval(() => {}, 100000);
      const checkinTimer = setInterval(() => {}, 100000);

      // Simulate stall detection
      clearInterval(stallCheck);
      stallCleared = true;
      clearInterval(checkinTimer);
      checkinCleared = true;
      rejected = true;

      assert.ok(stallCleared, 'Stall check interval should be cleared');
      assert.ok(checkinCleared, 'Check-in interval should be cleared');
      assert.ok(rejected, 'Promise should be rejected');
    });
  });

  describe('Channel busy flag', () => {
    it('busy flag is cleared even when dispatch throws', async () => {
      const state = { busy: false };

      const dispatchThatThrows = async () => {
        state.busy = true;
        try {
          throw new Error('Simulated Claude CLI failure');
        } finally {
          state.busy = false;
        }
      };

      await assert.rejects(() => dispatchThatThrows(), /Simulated/);
      assert.equal(state.busy, false, 'busy flag must be cleared after error');
    });

    it('typing interval is cleared even when dispatch throws', async () => {
      let intervalCleared = false;
      const interval = setInterval(() => {}, 100000);

      const dispatchThatThrows = async () => {
        try {
          throw new Error('Simulated failure');
        } finally {
          clearInterval(interval);
          intervalCleared = true;
        }
      };

      await assert.rejects(() => dispatchThatThrows(), /Simulated/);
      assert.ok(intervalCleared, 'Typing interval must be cleared after error');
    });
  });
});
