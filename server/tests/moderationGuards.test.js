import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModeration, checkModeration, _resetModerationCache } from '../selfie/moderation.js';
import { planSelfie } from '../selfie/planner.js';
import { buildPrompt, loadCharacterCard } from '../selfie/promptBuilder.js';
import { normalizeSlots } from '../selfie/slotMatcher.js';

const MODERATION_PATH = fileURLToPath(new URL('../../config/selfieModeration.json', import.meta.url));
const CHARACTER_CARD_PATH = fileURLToPath(new URL('../../config/characterCard.json', import.meta.url));
// Baseline count from config/selfieModeration.json; additions must not lower this floor.
const MIN_FORBIDDEN_PHRASES = 80;

function mockPlannerLlm(slots = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    client: {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return { choices: [{ message: { content: JSON.stringify(slots) } }] };
          },
        },
      },
    },
  };
}

function assertBlockedPlan(result, context) {
  assert.ok(result, `Moderation regressed: planner returned no result for ${context}`);
  assert.equal(result.ok, false, `Moderation regressed: planner accepted ${context}`);
  assert.equal(result.blocked, true, `Moderation regressed: ${context} was not marked blocked`);
  assert.equal(result.reason, 'FORBIDDEN_CONTENT',
    `Moderation regressed: ${context} failed for a reason other than forbidden content`);
  assert.equal(result.plan, undefined, `Moderation regressed: planner exposed a generation plan for ${context}`);
}

test('moderation list loads with at least 80 distinct blocked phrases', (t) => {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(fs.readFileSync(MODERATION_PATH, 'utf8'));
  }, 'Moderation regressed: config/selfieModeration.json is missing, unreadable, or invalid JSON');
  assert.ok(Array.isArray(parsed?.forbiddenWords),
    'Moderation regressed: forbiddenWords is no longer a phrase list');
  assert.ok(parsed.forbiddenWords.every(phrase => typeof phrase === 'string' && phrase.trim()),
    'Moderation regressed: forbiddenWords contains an empty or non-string phrase');
  assert.ok(parsed.forbiddenWords.length >= MIN_FORBIDDEN_PHRASES,
    `Moderation regressed: blocked phrase count fell below ${MIN_FORBIDDEN_PHRASES} (found ${parsed.forbiddenWords.length})`);

  const phrases = parsed.forbiddenWords.map(phrase => phrase.trim().toLowerCase());
  assert.ok(new Set(phrases).size >= MIN_FORBIDDEN_PHRASES,
    `Moderation regressed: distinct blocked phrase count fell below ${MIN_FORBIDDEN_PHRASES}`);
  _resetModerationCache();
  t.after(_resetModerationCache);
  const loaded = loadModeration(MODERATION_PATH);
  assert.deepEqual(loaded.forbiddenWords, phrases,
    'Moderation regressed: the runtime loader did not load the configured list and may be using fallback phrases');
  assert.ok(loaded.forbiddenWords.length >= MIN_FORBIDDEN_PHRASES,
    `Moderation regressed: runtime blocked phrase count fell below ${MIN_FORBIDDEN_PHRASES}`);
});

const BLOCKED_REQUESTS = [
  ['Indonesian explicit content', 'pap telanjang dong'],
  ['Indonesian multiword content', 'pap lepas baju dong'],
  ['English explicit content', 'send me a nude selfie'],
  ['suggestive content', 'pap pakai bikini'],
  ['Indonesian violence', 'foto pegang senjata'],
  ['English violence', 'selfie with gore'],
  ['leetspeak content', 'nud3 selfie'],
  ['spaced obfuscation', 'pap b u g i l dong'],
];

for (const [label, userText] of BLOCKED_REQUESTS) {
  test(`selfie planner rejects ${label} before calling the LLM`, async () => {
    const llm = mockPlannerLlm();
    let result;
    await assert.doesNotReject(async () => {
      result = await planSelfie({ userText, config: { moderationPath: MODERATION_PATH }, llmClient: llm.client });
    }, `Moderation regressed: planner threw instead of rejecting ${label}`);
    assertBlockedPlan(result, `blocked request "${userText}"`);
    assert.equal(llm.calls, 0, `Moderation regressed: blocked request "${userText}" reached the LLM`);
  });
}

const BLOCKED_PROMPTS = [
  ['explicit pose', 'pose', 'nude selfie pose'],
  ['suggestive expression', 'ekspresi', 'seductive expression'],
  ['violent background', 'latar', 'gore scene'],
];

for (const [label, slot, description] of BLOCKED_PROMPTS) {
  test(`selfie planner rejects a built prompt with ${label} after a safe request`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-moderation-guard-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const baseCard = loadCharacterCard(CHARACTER_CARD_PATH);
    const card = {
      ...baseCard,
      whitelist: {
        ...baseCard.whitelist,
        [slot]: { ...baseCard.whitelist[slot], guard_slot: description },
      },
    };
    const config = {
      moderationPath: MODERATION_PATH,
      characterCardPath: path.join(directory, 'characterCard.json'),
      referenceDir: path.join(directory, 'references'),
      plannerTimeoutMs: 1000,
    };
    fs.writeFileSync(config.characterCardPath, JSON.stringify(card));
    const slots = { ...card.defaults, [slot]: 'guard_slot' };
    const prompt = buildPrompt(normalizeSlots(slots, card, ['default.jpg']), card, config);
    assert.ok(prompt.positivePrompt.includes(description),
      `Moderation guard regressed: the ${label} fixture no longer reaches the built positive prompt`);
    assert.equal(checkModeration(prompt.positivePrompt, { moderationPath: MODERATION_PATH }).blocked, true,
      `Moderation regressed: the built prompt with ${label} bypassed the content filter`);

    const llm = mockPlannerLlm(slots);
    let result;
    await assert.doesNotReject(async () => {
      result = await planSelfie({ userText: 'pap dong sayang', config, llmClient: llm.client });
    }, `Moderation regressed: planner threw instead of rejecting the built prompt with ${label}`);
    assert.equal(llm.calls, 1, `Moderation guard regressed: the ${label} fixture did not exercise prompt assembly`);
    assertBlockedPlan(result, `built prompt with ${label}`);
  });
}
