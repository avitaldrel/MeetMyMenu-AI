// A menu can be a complete DOCUMENT and still be the wrong menu.
//
// Reported by Jonathan Mosen (National Federation of the Blind): he searched
// for Facci in Baltimore, the app found and added the PDF it turned up, and it
// was only the drinks list — "a good list of things to drink, but no food."
//
// Nothing was broken in the usual sense. The drinks PDF really was a whole,
// internally consistent document, so the extraction model rightly called it
// complete. Two separate things had to go wrong for him to end up there, and
// both are covered below:
//   1. link ranking preferred the drinks PDF over the actual dinner menu, and
//   2. nothing afterwards noticed that a menu with no food on it is not a menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreLink,
  classifySection,
  narrowMenuReason,
  assessMenuCompleteness,
  menuLikelihood,
} from '../api/_menuCore.ts';
import type { ParsedMenu } from '../api/_menuCore.ts';

const menu = (sections: Record<string, number>): ParsedMenu => ({
  categories: Object.entries(sections).map(([name, n]) => ({
    name,
    items: Array.from({ length: n }, (_, i) => ({ name: `${name} item ${i + 1}` })),
  })),
});

// ── 1. Ranking: the food menu must outrank the drinks list ──────────────────

test('the real dinner menu outranks a drinks PDF (the Facci ranking bug)', () => {
  const drinksPdf = 'https://faccirestaurant.com/wp-content/uploads/drink-menu.pdf';
  const dinner = 'https://faccirestaurant.com/menus/dinner';
  assert.ok(
    scoreLink(dinner) > scoreLink(drinksPdf),
    `dinner scored ${scoreLink(dinner)}, drinks PDF scored ${scoreLink(drinksPdf)} — the drinks list must not win`
  );
});

test('the narrow-link penalty outweighs the PDF bonus, not just the word bonus', () => {
  // Otherwise "drinks-menu.pdf" still wins on file format alone.
  const foodPage = 'https://example.com/menus/dinner';
  for (const narrow of [
    'https://example.com/cocktail-menu.pdf',
    'https://example.com/wine-list-menu.pdf',
    'https://example.com/bar-menu.pdf',
    'https://example.com/dessert-menu.pdf',
    'https://example.com/kids-menu.pdf',
  ]) {
    assert.ok(
      scoreLink(foodPage) > scoreLink(narrow),
      `${narrow} (${scoreLink(narrow)}) should rank below the food page (${scoreLink(foodPage)})`
    );
  }
});

test('an ordinary food menu PDF is still preferred over a plain page', () => {
  // The penalty must not cost us real full-menu PDFs, which are usually best.
  assert.ok(
    scoreLink('https://example.com/dinner-menu.pdf') > scoreLink('https://example.com/menu'),
    'a food menu PDF should still win on format'
  );
});

test('a page with no food words at all scores below a real food menu', () => {
  const drinksPage =
    'Cocktails $14 Negroni $15 Old Fashioned $16 Margarita $14 Wines by the glass $12 ' +
    'Red $13 White $12 Beers $8 Draft $7 Bottles $6 Drinks list beverages '.repeat(6);
  const foodPage =
    'Appetizers $12 Calamari $14 Salads $11 Caesar $12 Entrees $26 Salmon $28 Chicken $24 ' +
    'Pasta $22 Desserts $9 Sides $6 Soups $8 Sandwiches $15 '.repeat(6);
  assert.ok(
    menuLikelihood(foodPage) > menuLikelihood(drinksPage),
    `food page ${menuLikelihood(foodPage)} should beat drinks page ${menuLikelihood(drinksPage)}`
  );
});

// ── 2. Detection: a menu with no food is not the menu ───────────────────────

test('a big, internally complete drinks menu is still reported as partial', () => {
  // 60 items across 4 sections — it clears every size check comfortably.
  const drinks = menu({ Cocktails: 20, 'Wines by the Glass': 20, 'Beers on Tap': 12, 'Spirits': 8 });
  const verdict = assessMenuCompleteness(drinks);
  assert.equal(verdict.incomplete, true, 'a drinks-only menu must never be announced as the whole menu');
  assert.match(verdict.reason!, /drinks list/);
  assert.match(verdict.reason!, /no food/);
});

test('a dessert-only menu is reported as partial too', () => {
  const verdict = assessMenuCompleteness(menu({ Desserts: 10, 'Ice Cream': 6, Pastries: 5 }));
  assert.equal(verdict.incomplete, true);
  assert.match(verdict.reason!, /dessert menu/);
});

test('a normal menu that happens to include a drinks section is NOT flagged', () => {
  const full = menu({ Appetizers: 8, Entrees: 14, Desserts: 5, Drinks: 12 });
  assert.equal(assessMenuCompleteness(full).incomplete, false);
});

test('a food-only menu with no drinks section is NOT flagged', () => {
  const full = menu({ Starters: 7, 'Main Courses': 15, Sides: 6 });
  assert.equal(assessMenuCompleteness(full).incomplete, false);
});

// ── Section classification: the tricky names ────────────────────────────────

test('food sections that merely mention a drink word are classified as food', () => {
  // These are the false positives a naive keyword match would produce.
  for (const name of ['Bar Snacks', 'Bar Bites', 'Beer Battered Sides', 'Wine Country Salads']) {
    assert.equal(classifySection(name), 'food', `"${name}" is food`);
  }
});

test('genuine drink sections are classified as drinks', () => {
  for (const name of ['Cocktails', 'Wine List', 'Beers on Tap', 'By the Glass', 'Libations', 'Coffee & Tea']) {
    assert.equal(classifySection(name), 'drink', `"${name}" is a drink section`);
  }
});

test('an unrecognised section name counts as food, so real menus are never flagged', () => {
  // One-directional by design: we would rather miss a narrow menu than tell
  // someone their real menu is incomplete.
  assert.equal(classifySection('Chef’s Table'), 'food');
  assert.equal(classifySection('House Favourites'), 'food');
  assert.equal(narrowMenuReason(menu({ 'House Favourites': 20 })), null);
});

test('empty sections do not swing the verdict', () => {
  const withEmptyFood: ParsedMenu = {
    categories: [
      { name: 'Cocktails', items: [{ name: 'Negroni' }, { name: 'Martini' }] },
      { name: 'Entrees', items: [] },
    ],
  };
  assert.match(narrowMenuReason(withEmptyFood)!, /drinks list/);
});
