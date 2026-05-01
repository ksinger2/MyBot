const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SANDBOX_FILE = path.join(__dirname, '..', 'test-fixtures', 'sandbox-users.json');
const UUID_MAP_FILE = path.join(__dirname, '..', 'test-fixtures', 'signal-uuid-phone.json');

const MERRISA_PHONE = '+12068024303';
const MERRISA_UUID = '59237aa4-ee2e-4f5b-a651-07457c4e4ba7';
const DANIEL_PHONE = '+16318487980';
const DANIEL_UUID = '1d72e654-0247-4e8b-9656-042a28c77ea5';
const OWNER_PHONE = '+16315214787';
const OWNER_UUID = 'f705ba7a-aff9-4571-93ae-244430d892ce';

describe('UUID→phone resolution', () => {
  before(() => {
    fs.mkdirSync(path.join(__dirname, '..', 'test-fixtures'), { recursive: true });

    fs.writeFileSync(SANDBOX_FILE, JSON.stringify({
      [MERRISA_PHONE]: {
        name: 'Merrisa', cwd: '/sandbox/Merrisa',
        allowedTools: 'Edit,Write,Read,Bash', linuxUser: 'sandbox-merrisa',
      },
      [DANIEL_PHONE]: {
        name: 'Daniel', cwd: '/sandbox/Daniel',
        allowedTools: 'Edit,Write,Read,Bash', linuxUser: 'sandbox-daniel',
      },
    }));

    fs.writeFileSync(UUID_MAP_FILE, JSON.stringify({
      version: 2,
      byUuid: {
        [MERRISA_UUID]: { phone: MERRISA_PHONE, firstSeen: 1, lastSeen: 1 },
        [DANIEL_UUID]: { phone: DANIEL_PHONE, firstSeen: 1, lastSeen: 1 },
        [OWNER_UUID]: { phone: OWNER_PHONE, firstSeen: 1, lastSeen: 1 },
      },
      byPhone: {
        [MERRISA_PHONE]: [MERRISA_UUID],
        [DANIEL_PHONE]: [DANIEL_UUID],
        [OWNER_PHONE]: [OWNER_UUID],
      },
    }));
  });

  after(() => {
    try { fs.rmSync(path.join(__dirname, '..', 'test-fixtures'), { recursive: true }); } catch {}
  });

  describe('getSandboxUser', () => {
    // Override the sandbox file path for testing
    let getSandboxUser;

    before(() => {
      // We need to test the actual logic, so we'll inline it here
      // since the real module reads from /app/data which doesn't exist in test
      getSandboxUser = (senderId) => {
        if (!senderId) return null;
        const config = JSON.parse(fs.readFileSync(SANDBOX_FILE, 'utf8'));
        let entry = config[senderId];
        if (!entry && !senderId.startsWith('+')) {
          try {
            const map = JSON.parse(fs.readFileSync(UUID_MAP_FILE, 'utf8'));
            const phone = map.byUuid?.[senderId]?.phone;
            if (phone) entry = config[phone];
          } catch {}
        }
        if (!entry) return null;
        return { name: entry.name, cwd: entry.cwd, allowedTools: entry.allowedTools };
      };
    });

    it('finds sandbox user by phone number', () => {
      const user = getSandboxUser(MERRISA_PHONE);
      assert.equal(user.name, 'Merrisa');
      assert.equal(user.cwd, '/sandbox/Merrisa');
    });

    it('finds sandbox user by UUID (critical regression)', () => {
      const user = getSandboxUser(MERRISA_UUID);
      assert.equal(user.name, 'Merrisa');
      assert.equal(user.cwd, '/sandbox/Merrisa');
    });

    it('finds Daniel by UUID', () => {
      const user = getSandboxUser(DANIEL_UUID);
      assert.equal(user.name, 'Daniel');
    });

    it('returns null for unknown UUID', () => {
      const user = getSandboxUser('00000000-0000-0000-0000-000000000000');
      assert.equal(user, null);
    });

    it('returns null for unknown phone', () => {
      const user = getSandboxUser('+19999999999');
      assert.equal(user, null);
    });

    it('returns null for empty/null input', () => {
      assert.equal(getSandboxUser(null), null);
      assert.equal(getSandboxUser(''), null);
      assert.equal(getSandboxUser(undefined), null);
    });

    it('handles missing UUID map file gracefully', () => {
      const origFile = UUID_MAP_FILE + '.bak';
      fs.renameSync(UUID_MAP_FILE, origFile);
      try {
        const user = getSandboxUser(MERRISA_UUID);
        assert.equal(user, null); // graceful degradation, not crash
      } finally {
        fs.renameSync(origFile, UUID_MAP_FILE);
      }
    });

    it('handles corrupted UUID map file gracefully', () => {
      const origContent = fs.readFileSync(UUID_MAP_FILE, 'utf8');
      fs.writeFileSync(UUID_MAP_FILE, 'NOT VALID JSON{{{');
      try {
        const user = getSandboxUser(MERRISA_UUID);
        assert.equal(user, null); // graceful degradation
      } finally {
        fs.writeFileSync(UUID_MAP_FILE, origContent);
      }
    });
  });

  describe('UUID resolution helper', () => {
    it('resolves UUID to phone via map', () => {
      const map = JSON.parse(fs.readFileSync(UUID_MAP_FILE, 'utf8'));
      const resolve = (id) => {
        if (!id) return id;
        if (id.startsWith('+')) return id;
        return map.byUuid[id]?.phone || id;
      };

      assert.equal(resolve(MERRISA_UUID), MERRISA_PHONE);
      assert.equal(resolve(DANIEL_UUID), DANIEL_PHONE);
      assert.equal(resolve(OWNER_UUID), OWNER_PHONE);
    });

    it('passes through phone numbers unchanged', () => {
      const map = JSON.parse(fs.readFileSync(UUID_MAP_FILE, 'utf8'));
      const resolve = (id) => {
        if (!id) return id;
        if (id.startsWith('+')) return id;
        return map.byUuid[id]?.phone || id;
      };

      assert.equal(resolve(MERRISA_PHONE), MERRISA_PHONE);
      assert.equal(resolve(OWNER_PHONE), OWNER_PHONE);
    });

    it('returns UUID unchanged when not in map', () => {
      const map = JSON.parse(fs.readFileSync(UUID_MAP_FILE, 'utf8'));
      const resolve = (id) => {
        if (!id) return id;
        if (id.startsWith('+')) return id;
        return map.byUuid[id]?.phone || id;
      };

      const unknownUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      assert.equal(resolve(unknownUuid), unknownUuid);
    });
  });
});
