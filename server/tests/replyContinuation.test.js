import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyContinuationGuard } from '../replyContinuation.js';

const delta = (text, speechText = text, segmentId) => ({ type: 'delta', text, speechText,
  ...(segmentId !== undefined && { segmentId }) });
const display = events => events.filter(event => event.type === 'delta').map(event => event.text).join('');
const speech = events => events.filter(event => event.type === 'delta').map(event => event.speechText ?? event.text).join('');
const collect = (guard, events) => [...events.flatMap(event => guard.push(event)), ...guard.finish()];

test('the duplicated screenshot opening is removed from display and spoken text in one chunk', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Ya ampun, ditanya balik lagi deh.' });
  const output = collect(guard, [delta('Ya ampun, ditanya balik lagi deh. Kamu tuh ya, ditanyain gitu aja bingung.')]);
  assert.equal(display(output), 'Kamu tuh ya, ditanyain gitu aja bingung.');
  assert.equal(speech(output), display(output));
  assert.equal(guard.removedSentences, 1);
});

test('every split of an exact opening stays hidden until it becomes a distinct continuation', () => {
  const text = 'Ya gitu doang? Nggak cerita apa-apa nih?';
  for (let offset = 0; offset <= text.length; offset++) {
    const guard = new ReplyContinuationGuard({ spokenText: 'Ya gitu doang?' });
    const output = collect(guard, [delta(text.slice(0, offset)), delta(text.slice(offset))]);
    assert.equal(display(output), 'Nggak cerita apa-apa nih?', `display split ${offset}`);
    assert.equal(speech(output), display(output), `speech split ${offset}`);
    assert.equal(guard.removedSentences, 1);
  }
});

test('case, punctuation, whitespace and greeting-juga variants match only the opening', () => {
  for (const text of ['HALO JUGA, SAYANG! Kamu udah pulang?', 'Halo, sayang. Kamu udah pulang?',
    '  Halo\t juga  sayang… Kamu udah pulang?']) {
    const guard = new ReplyContinuationGuard({ spokenText: 'Halo, sayang.' });
    const output = collect(guard, [delta(text)]);
    assert.equal(display(output), 'Kamu udah pulang?');
    assert.equal(guard.removedSentences, 1);
  }
  const guard = new ReplyContinuationGuard({ spokenText: 'Ya gitu doang?' });
  assert.equal(display(collect(guard, [delta('Ya gitu juga doang?')])), 'Ya gitu juga doang?');
  assert.equal(guard.removedSentences, 0);
});

test('a short shared prefix releases as soon as the actual answer differs', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  assert.deepEqual(guard.push(delta('Aku ')), []);
  assert.equal(display(guard.push(delta('suka'))), 'Aku suka');
  assert.equal(display(guard.push(delta(' ide itu.'))), ' ide itu.');
  assert.equal(guard.removedSentences, 0);
});

test('all repeated leading sentences are removed but later intentional repetition survives', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const output = collect(guard, [delta('Aku dengar. Aku dengar! Kita pelan-pelan dulu. Aku dengar.')]);
  assert.equal(display(output), 'Kita pelan-pelan dulu. Aku dengar.');
  assert.equal(guard.removedSentences, 2);
});

test('quoted discussion of the earlier response remains intentional prose', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Ya gitu doang?' });
  const text = '"Ya gitu doang?" itu cuma candaan tadi.';
  assert.equal(display(collect(guard, [delta(text)])), text);
  assert.equal(guard.removedSentences, 0);
});

test('inline tags on discarded words are removed and tags on kept speech survive', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const output = collect(guard, [delta('', '[sigh]'),
    delta('Aku dengar. Kamu masih capek?', 'Aku dengar. [laugh]Kamu masih capek?')]);
  assert.equal(display(output), 'Kamu masih capek?');
  assert.equal(speech(output), '[laugh]Kamu masih capek?');
});

test('a trailing tag stays with the retained continuation across delta chunks', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const output = collect(guard, [delta('Aku dengar. ', '[sigh]Aku dengar. [laugh]'), delta('Kamu masih capek?')]);
  assert.equal(display(output), 'Kamu masih capek?');
  assert.equal(speech(output), '[laugh]Kamu masih capek?');
});

test('fully removed segments drop their metadata and retain immutable tone for the next segment', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const events = [
    { type: 'segment_start', segmentId: 0, emotion: 'sedih', register: 'serious' },
    { type: 'emotion', segmentId: 0, emotion: 'sedih' }, delta('Aku dengar.', '[sigh]Aku dengar.', 0),
    { type: 'segment_end', segmentId: 0 },
    { type: 'segment_start', segmentId: 1, emotion: 'sayang', register: 'intimate', speechEmotion: 'compassionate' },
    { type: 'emotion', segmentId: 1, emotion: 'sayang' }, delta(' Kamu masih capek?', '[whisper]Kamu masih capek?', 1),
    { type: 'segment_end', segmentId: 1 },
  ].map(event => Object.freeze(event));
  const output = collect(guard, events);
  assert.equal(display(output).trim(), 'Kamu masih capek?');
  assert.equal(speech(output), '[whisper]Kamu masih capek?');
  assert.ok(output.every(event => event.segmentId === 1));
  assert.equal(output.find(event => event.type === 'segment_start').register, 'intimate');
  assert.equal(events[2].text, 'Aku dengar.');
});

test('display-only segment separators do not eat the retained spoken character', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const output = collect(guard, [delta(' Aku dengar. Kamu masih capek?', '[sigh]Aku dengar. [whisper]Kamu masih capek?')]);
  assert.equal(display(output), 'Kamu masih capek?');
  assert.equal(speech(output), '[whisper]Kamu masih capek?');
});

test('all-duplicate completion suppresses bubbles/audio while retaining private reflection metadata', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const metadata = { type: 'reply_metadata', reflectionRequest: 'Consider a helpful follow-up.' };
  const output = collect(guard, [{ type: 'emotion', emotion: 'sayang' }, delta('Aku dengar.'), metadata]);
  assert.deepEqual(output, [metadata]);
  assert.equal(guard.removedSentences, 1);
});

test('an unpunctuated duplicate closes at a segment boundary and drops orphan inline tags', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  const output = collect(guard, [{ type: 'segment_start', segmentId: 0 }, delta('Aku dengar', '[sigh]Aku dengar', 0),
    { type: 'segment_end', segmentId: 0 }, { type: 'segment_start', segmentId: 1 },
    delta(' Kamu masih capek?', '[laugh]Kamu masih capek?', 1), { type: 'segment_end', segmentId: 1 }]);
  assert.equal(display(output).trim(), 'Kamu masih capek?');
  assert.equal(speech(output), '[laugh]Kamu masih capek?');
  assert.ok(output.every(event => event.segmentId === 1));
});

test('a partial nonmatching finish remains visible instead of being lost', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  assert.deepEqual(guard.push(delta('Aku de')), []);
  assert.equal(display(guard.finish()), 'Aku de');
  assert.equal(guard.removedSentences, 0);
});

test('bounded pending characters and empty metadata cannot grow indefinitely', () => {
  const guard = new ReplyContinuationGuard({ spokenText: 'A'.repeat(100), maxPendingChars: 12 });
  assert.deepEqual(guard.push(delta('AAAA')), []);
  assert.equal(display(guard.push(delta('AAAA'))), 'AAAAAAAA');
  assert.equal(guard.pending.length, 0);
  assert.equal(display(guard.push(delta('BBBB'))), 'BBBB');
  const metadataGuard = new ReplyContinuationGuard({ spokenText: 'Aku dengar.' });
  let released = 0;
  for (let index = 0; index < 600; index++) released += metadataGuard.push({ type: 'register', register: 'casual' }).length;
  assert.equal(released, 600);
  assert.equal(metadataGuard.pending.length, 0);
});

test('without a prior spoken reaction all sanitized events pass through unchanged', () => {
  const guard = new ReplyContinuationGuard();
  const events = [{ type: 'emotion', emotion: 'sayang' }, delta('Halo, sayang.')];
  assert.deepEqual(collect(guard, events), events);
  assert.equal(guard.removedSentences, 0);
});
