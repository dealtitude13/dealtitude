/* ---------------------------------------------------------------------------
 * What a shop may not announce here.
 *
 * Two categories, and they are here for different reasons.
 *
 *   Tobacco and vape — Apple's rule is unconditional: an app that encourages
 *   their consumption is not permitted, at any age, to any audience. There is
 *   no age gate that makes this allowed, which is why these are refused rather
 *   than gated the way a liquor shop's posts are.
 *
 *   Lottery — state lottery advertising carries its own rules, and app stores
 *   treat gambling content separately again. Not worth a shop's post.
 *
 * WHAT THIS IS NOT. It is a guard against the honest mistake: a shopkeeper who
 * does not know the rule and types "Cigarettes $8.99". It stops that at the
 * moment it is made and says why, in their own words.
 *
 * It is NOT enforcement. It cannot catch a brand name nobody wrote down
 * ("Marlboro Golds"), it cannot catch ordinary speech ("smokes", "scratchers"),
 * and it has no concept of the much larger set of things that are unlawful to
 * advertise. What carries that weight is the undertaking every owner signs
 * before they can post, and the fact that one person knows every shopkeeper on
 * this platform. Treating this file as a shield would be a mistake.
 * ------------------------------------------------------------------------- */

/* Each entry is matched as a WHOLE WORD, with an optional plural. Substring
   matching was the obvious first idea and is wrong: "chew" inside "chewy
   caramels", "cigar" inside nothing useful, "lotto" inside a surname. A shop
   refused for selling dog chews learns to distrust the app, and a shopkeeper
   who distrusts the app stops posting. */
const TOBACCO = [
  "cigarette", "cigarettes", "cigar", "cigars", "cigarillo", "cigarillos",
  "tobacco", "vape", "vapes", "vaping", "e-cig", "ecig", "e-cigarette",
  "nicotine", "juul", "hookah", "shisha", "snuff", "snus", "zyn",
  "chewing tobacco", "rolling papers", "nicotine pouch", "nicotine pouches",
];

/* The policy names betting, wagering and casino games as well as lottery, so
   the filter has to reach that far too — a word list narrower than the rule it
   enforces is the worst of both: it reads like enforcement and is not.

   "bet" and "odds" are NOT here as bare words. "Bet you can't eat just one" is
   a sign in half the groceries in New Jersey, and "odds and ends" is a shelf.
   The two-word forms below catch the real thing without catching those. */
const LOTTERY = [
  "lottery", "lotto", "scratch-off", "scratch off", "scratchoff",
  "scratch-offs", "scratch offs", "powerball", "mega millions", "megamillions",
  "pick-6", "pick 6", "cash4life", "quick draw", "instant win",
  "gambling", "casino", "sportsbook", "sports book", "wager", "wagers",
  "wagering", "betting", "bet on", "place a bet", "parlay", "parlays",
  "odds on", "daily fantasy", "fanduel", "draftkings", "bookmaker",
];

/* Deliberately absent, and worth knowing why rather than wondering later:
     "chew"   — dog chews, chewy sweets. "chewing tobacco" is listed instead.
     "pipe"   — plumbing, piping on a cake.
     "smoke"  — smoked salmon, smoked paprika, a smokehouse. The commonest word
                of all for the thing, and the one that cannot be used.
     "jackpot"— figurative, and a legitimate name for a sweet or a deal.
     "bet"    — "bet you can\'t eat just one" is a sign in half the groceries
                in New Jersey. "bet on" and "place a bet" are listed instead.
     "odds"   — odds and ends. "odds on" is listed instead.
   Each of these would block an ordinary grocery post, which costs more than
   the rare case it would catch.

   ACCEPTED THE OTHER WAY: "cigar" blocks "cigar-shaped chocolate rolls", and
   "chewing tobacco" will not save a novelty sweet called a candy cigarette.
   Excluding those would mean guessing at the word before, which is a game with
   no end. A shop that sells chocolate cigars renames the post once; a shop
   that sells real ones must not get through. */

const CATEGORY = [
  { name: "tobacco or vape", terms: TOBACCO,
    why: "Apple doesn't allow apps to advertise them — that's their rule, not "
       + "ours, and it applies whoever the alert reaches.",
    /* The shopper's version. They are typing into an ask box, so the clause
       about who an alert reaches means nothing to them and trails off the end
       of the refusal as a non-sequitur. */
    short: "Apple doesn't allow apps to advertise them, at any age." },
  { name: "lottery or gambling", terms: LOTTERY,
    why: "Lottery and gambling advertising carry their own rules, state by "
       + "state, and the app stores treat gambling separately again.",
    short: "Lottery and gambling carry their own rules, and the app stores "
         + "treat them separately again." },
];

/* Fold case, turn punctuation into spaces so "e-cig" and "e cig" are the same
   thing, and collapse runs of space. Matching then happens on words rather
   than on characters. */
const fold = (s) => String(s || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/* A term may be several words, so the haystack is searched for the term's
   words in sequence, each on a word boundary. Padding both with spaces turns
   that into a plain substring test without a regex per term. */
const hasTerm = (folded, term) => ` ${folded} `.includes(` ${fold(term)} `);

/**
 * Check one or more pieces of text a shop wants to publish.
 *
 * Returns null when there is nothing to object to, or { term, category, why }
 * naming what was found — the caller turns that into a sentence the shopkeeper
 * reads, which is the whole point of returning the detail rather than a bare
 * false.
 */
export function forbidden(...texts) {
  const folded = fold(texts.filter(Boolean).join(" "));
  if (!folded) return null;
  for (const cat of CATEGORY) {
    for (const term of cat.terms) {
      if (hasTerm(folded, term)) {
        return { term, category: cat.name, why: cat.why,
                 short: cat.short || cat.why };
      }
    }
  }
  return null;
}

/** The sentence a shopkeeper sees. Says what, and says why. */
export const forbiddenMessage = (hit) =>
  `Dealtitude can't carry ${hit.category} posts. ${hit.why} `
  + `Everything else in your shop is fine — edit this one and try again.`;

/** The same refusal, for a SHOPPER rather than a shopkeeper.
 *
 * The shopkeeper's version tells them to edit the post and says the rest of
 * their shop is fine, which is meaningless to somebody typing into an ask box
 * — and faintly accusing, which is worse. A shopper who typed "cigarettes"
 * into a grocery app has almost always just done it without thinking. */
export const forbiddenAskMessage = (hit) =>
  `Dealtitude can't carry ${hit.category} items. ${hit.short} `
  + `Ask for something else and we'll pass it on to the shop.`;
