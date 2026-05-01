const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('Security gates', () => {
  describe('[BACKGROUND] tag ownership check', () => {
    it('system prompt does NOT include [BACKGROUND] tag for non-owner users', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        readOnly: false,
        isGroupChat: false,
        ownerDmMode: false,
      });
      assert.ok(!prompt.includes('[BACKGROUND:'),
        'Non-owner system prompt should NOT contain [BACKGROUND:] tag');
    });

    it('system prompt does NOT include [REBUILD] tag for non-owner users', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        readOnly: false,
        isGroupChat: false,
        ownerDmMode: false,
      });
      assert.ok(!prompt.includes('[REBUILD]') || prompt.includes('SELF-MODIFICATION') === false,
        'Non-owner system prompt should NOT contain [REBUILD] tag');
    });

    it('system prompt DOES include [BACKGROUND] for owner DM mode', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        ownerDmMode: true,
      });
      assert.ok(prompt.includes('[BACKGROUND:'),
        'Owner DM system prompt should contain [BACKGROUND:] tag');
    });

    it('system prompt DOES include [REBUILD] for owner DM mode', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        ownerDmMode: true,
      });
      assert.ok(prompt.includes('[REBUILD]'),
        'Owner DM system prompt should contain [REBUILD] tag');
    });

    it('group chat prompt does NOT include [BACKGROUND] tag', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        isGroupChat: true,
        ownerDmMode: false,
      });
      assert.ok(!prompt.includes('[BACKGROUND:'),
        'Group chat system prompt should NOT contain [BACKGROUND:] tag');
    });

    it('readOnly prompt does NOT include [BACKGROUND] tag', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        readOnly: true,
        ownerDmMode: false,
      });
      assert.ok(!prompt.includes('[BACKGROUND:'),
        'ReadOnly system prompt should NOT contain [BACKGROUND:] tag');
    });
  });

  describe('System prompt content validation', () => {
    it('FILESYSTEM LAYOUT does NOT claim /workspace/ is the C drive', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({ ownerDmMode: true });
      if (prompt.includes('FILESYSTEM')) {
        assert.ok(!prompt.includes('host C:\\'),
          'FILESYSTEM LAYOUT should not claim /workspace/ maps to C:\\ drive');
        assert.ok(!prompt.includes('/workspace/Users/karen'),
          'Should not reference /workspace/Users/karen — that path does not exist');
      }
    });

    it('voice mode prompt is ultra-compact', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        isVoice: true,
      });
      assert.ok(prompt.length < 2000, `Voice prompt should be compact, got ${prompt.length} chars`);
      assert.ok(prompt.includes('VOICE MODE'),
        'Voice prompt should contain VOICE MODE marker');
    });

    it('non-owner prompt includes essential tags (CALENDAR, WEATHER, IMAGINE)', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        ownerDmMode: false,
      });
      assert.ok(prompt.includes('[CALENDAR:'), 'Should include CALENDAR tag');
      assert.ok(prompt.includes('[WEATHER:'), 'Should include WEATHER tag');
      assert.ok(prompt.includes('[IMAGINE:'), 'Should include IMAGINE tag');
    });

    it('owner DM prompt includes speed guidance', () => {
      const { buildSystemPrompt } = require('../system-prompt');
      const prompt = buildSystemPrompt({
        identity: { name: 'Bianca', description: 'AI assistant' },
        ownerDmMode: true,
      });
      assert.ok(prompt.includes('SPEED:'),
        'Owner DM prompt should include speed guidance');
    });
  });
});
