'use strict';

// A small, dependency-free language check for the four languages the demo covers. It is the
// server's own opinion of what language a piece of text is in, so a drafted reply can be
// checked against the review without trusting the model that wrote it. It is deliberately
// conservative: text it cannot place with a clear margin comes back as 'und'.

const STOPWORDS = {
  de: [
    'der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'einen', 'mit', 'für', 'auf', 'den',
    'dem', 'des', 'wir', 'sie', 'ihr', 'ihre', 'ihren', 'ihnen', 'ich', 'es', 'war', 'waren', 'hat',
    'haben', 'wurde', 'sehr', 'bei', 'von', 'zu', 'zum', 'zur', 'auch', 'aber', 'oder', 'dass',
    'uns', 'nach', 'noch', 'niemand', 'danke', 'vielen', 'dank', 'wieder', 'gerne', 'uns', 'wird',
    'sich', 'um', 'als', 'wie', 'wenn', 'mein', 'unser', 'unsere', 'freut', 'leid', 'tut',
  ],
  fr: [
    'le', 'la', 'les', 'des', 'du', 'une', 'et', 'est', 'sont', 'était', 'ne', 'pas', 'que', 'qui',
    'dans', 'pour', 'avec', 'sur', 'nous', 'vous', 'votre', 'vos', 'notre', 'nos', 'je', 'mon',
    'ma', 'mes', 'ce', 'cette', 'ces', 'au', 'aux', 'ont', 'avons', 'avez', 'très', 'mais', 'ou',
    'où', 'comme', 'fait', 'elle', 'ils', 'elles', 'tout', 'tous', 'merci', 'bonjour', 'sommes',
    'été', 'répondu', 'personne', 'jamais', 'afin', 'être', 'plus', 'si',
  ],
  it: [
    'il', 'lo', 'la', 'gli', 'le', 'dei', 'delle', 'del', 'della', 'dello', 'degli', 'uno', 'una',
    'e', 'è', 'sono', 'era', 'erano', 'non', 'che', 'di', 'da', 'per', 'con', 'su', 'nel', 'nella',
    'nei', 'alla', 'alle', 'al', 'ci', 'noi', 'voi', 'vostro', 'vostra', 'nostro', 'nostra', 'più',
    'molto', 'ma', 'anche', 'come', 'grazie', 'siamo', 'stata', 'stato', 'nessuno', 'sua', 'suo',
    'sue', 'suoi', 'tutto', 'tutti', 'ha', 'hanno', 'sempre', 'felici', 'perché', 'cosa', 'dove',
  ],
  en: [
    'the', 'and', 'was', 'were', 'is', 'are', 'to', 'of', 'that', 'this', 'with', 'for', 'you',
    'your', 'we', 'our', 'it', 'not', 'but', 'very', 'had', 'have', 'has', 'they', 'their', 'from',
    'my', 'would', 'could', 'thank', 'thanks', 'been', 'be', 'when', 'which', 'just', 'nobody',
    'nothing', 'after', 'again', 'all', 'there', 'what', 'were', 'about', 'us', 'also', 'who',
    'into', 'will', 'back', 'sorry', 'team', 'kind', 'words',
  ],
};

// Characters that, among these four languages, point to exactly one of them.
const SIGNAL_CHARS = {
  de: /[ßäö]/g,
  fr: /[çêâîôûœëï]/g,
  it: /[ìò]/g,
  en: /(?!)/g,
};

const SUPPORTED = Object.keys(STOPWORDS);
const STOPWORD_SETS = Object.fromEntries(
  SUPPORTED.map((lang) => [lang, new Set(STOPWORDS[lang])]),
);

const MIN_SCORE = 2;
const MIN_MARGIN = 1.5;

function scoreText(text) {
  const lower = text.toLowerCase();
  const tokens = lower.match(/\p{L}+/gu) || [];
  const scores = {};
  for (const lang of SUPPORTED) {
    let score = 0;
    for (const token of tokens) {
      if (STOPWORD_SETS[lang].has(token)) score += 1;
    }
    score += 0.5 * (lower.match(SIGNAL_CHARS[lang]) || []).length;
    scores[lang] = score;
  }
  return { scores, tokenCount: tokens.length };
}

/**
 * Returns { language, scores }. `language` is one of de, fr, it, en, or 'und' when the text
 * is too short or too evenly split to call.
 */
function detectLanguage(text) {
  if (typeof text !== 'string') return { language: 'und', scores: {} };
  const { scores } = scoreText(text);
  const ranked = SUPPORTED.slice().sort((a, b) => scores[b] - scores[a]);
  const best = ranked[0];
  const second = ranked[1];
  if (scores[best] < MIN_SCORE || scores[best] - scores[second] < MIN_MARGIN) {
    return { language: 'und', scores };
  }
  return { language: best, scores };
}

module.exports = { SUPPORTED, detectLanguage };
