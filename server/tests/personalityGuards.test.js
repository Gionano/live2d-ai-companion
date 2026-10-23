import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PERSONALITY_URL = new URL('../personality.js', import.meta.url);
const MIN_ADULT_AGE = 18;
const ENGLISH_SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const ENGLISH_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const INDONESIAN_SMALL = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
const numberWords = new Map();

for (let age = 0; age < 100; age += 1) {
  const units = age % 10;
  const tens = Math.floor(age / 10);
  const english = age < 20 ? ENGLISH_SMALL[age]
    : ENGLISH_TENS[tens] + (units ? ` ${ENGLISH_SMALL[units]}` : '');
  const indonesian = age < 12 ? INDONESIAN_SMALL[age]
    : age < 20 ? `${INDONESIAN_SMALL[age - 10]} belas`
      : `${INDONESIAN_SMALL[tens]} puluh` + (units ? ` ${INDONESIAN_SMALL[units]}` : '');
  numberWords.set(english, age);
  numberWords.set(indonesian, age);
}

const NUMBER_WORD_PATTERN = new RegExp(`\\b(?:${[...numberWords.keys()]
  .sort((a, b) => b.length - a.length).map(words => words.replaceAll(' ', '[\\s-]+')).join('|')})\\b`, 'gi');
const AGE_VALUE = String.raw`(\d+(?:[.,]\d+)?)(?:\s*(?:-|to|hingga|sampai)\s*(\d+(?:[.,]\d+)?))?`;
const AGE_PATTERNS = [
  new RegExp(String.raw`\b(?:berusia|berumur|usia(?:mu)?|umur(?:mu)?|age|aged)\s*(?:(?:adalah|is|of)\s*|[:=]\s*)?${AGE_VALUE}\b`, 'gi'),
  new RegExp(String.raw`\b${AGE_VALUE}\+?[\s-]*(?:tahun|thn|(?:years?|yrs?)[\s-]*(?:old|of[\s-]*age)|y\/?o)\b`, 'gi'),
];
const UNDER_AGE_PATTERN = /\b(?:under|below|less than|younger than|di bawah|kurang dari|belum)\s+(\d+(?:[.,]\d+)?)/gi;

function findPersonaAges(text) {
  const normalized = text.normalize('NFKC').replace(/[\u2010-\u2015]/g, '-')
    .replace(NUMBER_WORD_PATTERN, words => String(numberWords.get(words.toLowerCase().replace(/[\s-]+/g, ' '))));
  const ages = [];
  for (const pattern of AGE_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      for (const value of match.slice(1).filter(value => value !== undefined)) {
        ages.push({ value: Number(value.replace(',', '.')), mention: match[0] });
      }
    }
  }
  for (const match of normalized.matchAll(UNDER_AGE_PATTERN)) {
    ages.push({ value: Number(match[1].replace(',', '.')), mention: match[0], exclusive: true });
  }
  return ages;
}

function assertAdultAges(ages, context) {
  for (const age of ages) {
    assert.ok(age.exclusive ? age.value > MIN_ADULT_AGE : age.value >= MIN_ADULT_AGE,
      `Persona regressed: ${context} contains underage mention "${age.mention}"; all stated ages must be at least ${MIN_ADULT_AGE}`);
  }
}

test('persona states an explicit adult character age of at least 18', async () => {
  let personality;
  await assert.doesNotReject(async () => {
    personality = await import(PERSONALITY_URL.href);
  }, 'Persona regressed: server/personality.js no longer loads');
  assert.equal(typeof personality.WAIFU_SYSTEM_PROMPT, 'string',
    'Persona regressed: WAIFU_SYSTEM_PROMPT is missing or no longer text');
  const ages = findPersonaAges(personality.WAIFU_SYSTEM_PROMPT);
  const characterAges = personality.WAIFU_SYSTEM_PROMPT.split(/[\r\n.!?]+/)
    .filter(sentence => /\b(?:Amika|kamu|you)\b/i.test(sentence)).flatMap(findPersonaAges);
  assert.ok(characterAges.some(age => !age.exclusive && age.value >= MIN_ADULT_AGE),
    'Persona regressed: the active character persona no longer states an explicit adult age (>= 18)');
  assertAdultAges(ages, 'the active character persona');
});

test('persona source contains no underage age in active or translated text', () => {
  let source;
  assert.doesNotThrow(() => {
    source = fs.readFileSync(PERSONALITY_URL, 'utf8');
  }, 'Persona regressed: server/personality.js is missing or unreadable');
  assertAdultAges(findPersonaAges(source), 'server/personality.js');
});

test('persona age guard recognizes age formats without matching sentence limits', () => {
  for (const text of ['berusia 17 tahun', 'berumur 16', 'umur: 16', 'a 17-year-old character', 'aged seventeen',
    'tujuh belas tahun', '16-18 years old', 'under 18', 'di bawah delapan belas tahun']) {
    assert.throws(() => assertAdultAges(findPersonaAges(text), 'a guard fixture'), /Persona regressed:.*underage mention/,
      `Persona guard regressed: it missed underage text "${text}"`);
  }
  for (const text of ['berusia 18 tahun', 'a 24-year-old character', 'twenty-four years old', 'dua puluh empat tahun']) {
    const ages = findPersonaAges(text);
    assert.ok(ages.length, `Persona guard regressed: it missed adult text "${text}"`);
    assert.doesNotThrow(() => assertAdultAges(ages, 'a guard fixture'),
      `Persona guard regressed: it rejected adult text "${text}"`);
  }
  assert.deepEqual(findPersonaAges('1-3 kalimat, 4 kalimat; 1-3 sentences, every 3-4 replies.'), [],
    'Persona guard regressed: sentence limits were mistaken for character ages');
});
