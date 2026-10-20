/* ---------------------------------------------------------------------------
 * What every shop owner states before they can post.
 *
 * Held here, in one place, with a version. When the wording changes the
 * version changes with it, every owner is asked again, and the old acceptance
 * keeps saying what was actually agreed to on the day — which is the only
 * reason a record like this is worth keeping at all.
 *
 * TWO REGISTERS, ON PURPOSE.
 *
 *   SECTIONS[0] is plain language, ours, and exists to be READ. A shopkeeper
 *   standing behind a counter does not read a policy; they read three short
 *   paragraphs that say what the rule is and why it is not negotiable. That is
 *   what produces compliance.
 *
 *   SECTIONS[1] is the Prohibited Products and Promotions Policy, reproduced
 *   WORD FOR WORD as supplied. It is what allocates responsibility, and it is
 *   not mine to paraphrase, tighten or "improve". Anybody editing this file
 *   should change the plain-language part freely and leave the policy alone
 *   unless the policy itself has been redrafted — in which case bump VERSION.
 *
 *   SECTIONS[2] is ours again, and covers what the policy does not: that the
 *   content is the shop's own and has to be true and lawful. If a full Terms
 *   of Service ever carries that, this section should be replaced by a
 *   reference to it rather than duplicating it in two places that can drift.
 * ------------------------------------------------------------------------- */

/* Bumped whenever ANY of the words below change. An owner who accepted an
   earlier version is asked again; their old row keeps its own text. */
export const TERMS_VERSION = "2026-10-20f";

/* ONE STRING PER PARAGRAPH, and no hand-wrapping inside them.
 *
 * The screen renders this with white-space: pre-wrap — which is what keeps the
 * blank lines between clauses — so an editor line break inside a paragraph
 * becomes a line break on a 390px phone and the clause snaps mid-sentence.
 * The source is less tidy this way; what a shopkeeper reads is right. */
export const TERMS_SECTIONS = [
  {
    id: "why",
    heading: null,
    paras: [
      "Before you post anything, there are two kinds of product Dealtitude can't carry, and it's worth 30 seconds to say why rather than just handing you a policy.",
      "Tobacco and vape. Apple does not allow an app to advertise them — at all, to anyone, at any age. That's their rule, not ours. One post of this kind can have Dealtitude removed from the App Store, which takes every shop on it down with us.",
      "Lottery and gambling. These carry their own advertising rules, state by state, and the app stores treat gambling separately again. Not worth one post.",
      "The formal version is below. Everything else in your shop — groceries, prepared food, household, seasonal, whatever you sell — is fine.",
    ],
  },
  {
    id: "policy",
    heading: "Prohibited Products and Promotions Policy",
    subheading: "Prohibited Tobacco, Cigarette, Lottery, and Gambling-Related Content",
    paras: [
      "Shop Owners are strictly prohibited from creating, uploading, publishing, advertising, promoting, offering for sale, or distributing any content, deals, discounts, coupons, events, or other promotions relating to the following:",
      "1. Tobacco and Nicotine Products: Cigarettes, cigars, chewing tobacco, tobacco products, electronic cigarettes, vapes, nicotine products, and any related accessories or products intended for tobacco or nicotine consumption.",
      "2. Lottery and Gambling Products or Services: Lottery tickets, scratch-off tickets, lottery-related promotions, gambling services, betting, wagering, casino games, and any other products or services that facilitate or promote gambling, except where expressly permitted in writing by the Platform and compliant with applicable law.",
      "3. Circumvention of Restrictions: Any content that indirectly promotes, facilitates, or attempts to circumvent these prohibitions, including links, images, descriptions, or promotional offers directing users to purchase or participate in prohibited products or activities.",
      "The Platform reserves the right, at its sole discretion and subject to applicable law, to reject, remove, disable, or restrict any content that violates this policy; suspend or terminate the offending Shop Owner’s account; and take any other action permitted under the Platform’s Terms of Service. Shop Owners are solely responsible for ensuring that all content they submit complies with this policy and all applicable federal, state, and local laws and regulations.",
      "By using the Platform, Shop Owners acknowledge and agree to comply with this policy.",
    ],
  },
  {
    id: "yours",
    heading: "Your posts are yours",
    paras: [
      "You are responsible for what you announce through Dealtitude: that you are allowed to sell it, that the price and the dates are right, and that the claim is one you can stand behind. We pass your words to people who chose to hear from you; we do not check them for you.",
      "If you post something in the prohibited categories, we will take it down and may remove your shop. Your customers keep their follows, and nothing of theirs is affected.",
    ],
  },
];

/* The words beside the box. Stored with the acceptance, because what somebody
   ticked is part of what they agreed to. */
export const TERMS_CHECKBOX =
  "I have read and agree to the Prohibited Products and Promotions Policy.";

/* The canonical record — what goes in the database beside the date.
 *
 * DERIVED from the sections rather than typed out again. Two copies of a legal
 * text in one file is a drift waiting to happen, and the copy that would drift
 * is the one nobody looks at: the stored one, which is the only copy that
 * matters a year later. */
export const TERMS_TEXT = TERMS_SECTIONS.map((s) => [
  s.heading, s.subheading, ...s.paras,
].filter(Boolean).join("\n\n")).join("\n\n")
  + `\n\n[${TERMS_CHECKBOX}]`;

/** One line for a screen that has no room for the whole thing. */
export const TERMS_SUMMARY =
  "No tobacco or vape posts, no lottery or gambling, and what you post is yours to stand behind.";
