'use strict';

const { detectLanguage, SUPPORTED } = require('../src/language');
const seeds = require('../data/seed-reviews.json');
const fixtures = require('../data/fake-provider-fixtures.json');

describe('detectLanguage', () => {
  test('reads every seeded review as the language its fixture says', () => {
    for (const review of seeds) {
      expect(detectLanguage(review.originalText).language).toBe(fixtures.byId[review.id].language);
    }
  });

  test('reads every canned and stock reply as the language it is written in', () => {
    for (const [id, canned] of Object.entries(fixtures.byId)) {
      expect({ id, language: detectLanguage(canned.reply).language }).toEqual({ id, language: canned.language });
    }
    for (const [language, byCategory] of Object.entries(fixtures.generic.replies)) {
      for (const [category, reply] of Object.entries(byCategory)) {
        expect({ language, category, got: detectLanguage(reply).language }).toEqual({ language, category, got: language });
      }
    }
  });

  test('covers exactly the four demo languages', () => {
    expect(SUPPORTED.slice().sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  test.each([
    ['a different language from the one claimed', 'Thank you very much for your kind review, we are delighted that you enjoyed it.', 'en'],
    ['Swiss German spelling', 'Wir freuen uns, Sie bald wieder bei uns zu begrüssen und danken Ihnen für den Besuch.', 'de'],
  ])('%s', (_label, text, expected) => {
    expect(detectLanguage(text).language).toBe(expected);
  });

  test.each([
    ['empty text', ''],
    ['one word', 'Danke'],
    ['digits and symbols', '12345 !!! ???'],
    ['a language outside the four', 'Muchas gracias por su visita, esperamos volver a verle pronto.'],
    ['not a string', null],
  ])('returns und for %s', (_label, text) => {
    expect(detectLanguage(text).language).toBe('und');
  });
});
