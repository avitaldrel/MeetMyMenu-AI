// Shared server-side menu pipeline (underscore prefix = not a Vercel route).
// Used by api/menu-from-url.ts and api/find-menu.ts.
//
// fetchMenuSource(url)  -> classified content: HTML text | PDF base64 | image URL.
//                          Handles JS-shell pages (free Jina reader render, with
//                          optional Browserless fallback) and follows ONE "menu"
//                          link hop when a page has no menu signal (most users
//                          paste the homepage, not /menu).
// parseMenuSource(src)  -> ParsedMenu via OpenAI (vision model; PDFs as file input).

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN ?? '';
const JS_SHELL_THRESHOLD = 500;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const TEXT_CAP = 60000;

// Free JS rendering via Jina AI Reader (https://r.jina.ai). No API key required
// for the low volumes this app generates; it renders client-side menus that a
// plain fetch returns as an empty shell and gives back clean markdown text.
// This is the primary render path so we don't depend on a paid headless service.
// Set JINA_API_KEY to raise rate limits, or READER_BASE to self-host the reader.
const READER_BASE = process.env.READER_BASE ?? 'https://r.jina.ai/';

export const PARSE_MODEL = process.env.VISION_MODEL ?? 'gpt-5.4-mini';

export interface MenuItem {
  name: string;
  description?: string;
  price?: string;
  ingredients?: string[];
}
export interface MenuCategory { name: string; items: MenuItem[]; }
export interface ParsedMenu {
  categories: MenuCategory[];
  notes?: string;
  restaurantName?: string;
  incomplete?: boolean;
  incompleteReason?: string;
}

// ── Source classification ───────────────────────────────────────────────────
// Decide, from a URL, whether a menu came from the restaurant itself or a
// third-party aggregator. Pure + deterministic so it is unit-testable. We err
// toward "third_party" / "unknown" rather than over-claiming "official", because
// presenting an aggregator menu as the restaurant's own is exactly the failure
// mode the product is meant to prevent.

export type MenuSourceType =
  | 'official_site'
  | 'official_pdf'
  | 'official_ordering'
  | 'third_party'
  | 'direct_link'
  | 'photo'
  | 'unknown';

// Hosts that are listings/aggregators, never the restaurant's own site.
const THIRD_PARTY_HOSTS = [
  'yelp.', 'doordash.', 'ubereats.', 'grubhub.', 'seamless.', 'postmates.',
  'tripadvisor.', 'opentable.', 'allmenus.', 'menupix.', 'zomato.', 'foursquare.',
  'facebook.', 'instagram.', 'google.', 'goo.gl', 'maps.app', 'sluurpy.',
  'restaurantji.', 'menuism.', 'singleplatform.', 'yellowpages.', 'mapquest.',
  'beyondmenu.', 'slicelife.', 'eatstreet.',
];

// Hosts that host an official ordering experience FOR a restaurant. These are the
// restaurant's own ordering page (not an aggregator marketplace), so they count
// as official-ish first-party ordering.
const OFFICIAL_ORDERING_HOSTS = [
  'toasttab.', 'order.toasttab.', 'square.site', 'squareup.', 'clover.',
  'chownow.', 'olo.com', 'popmenu.', 'bentobox', 'spoton.', 'menufy.',
  'getbento.',
];

export interface SourceClassification {
  sourceType: MenuSourceType;
  official: boolean;
  sourceLabel: string; // friendly, speakable name
}

function hostName(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Friendly, speakable name for a known aggregator/ordering host, else null. */
function knownBrandLabel(host: string): string | null {
  const map: Record<string, string> = {
    'yelp.': 'Yelp', 'doordash.': 'DoorDash', 'ubereats.': 'Uber Eats',
    'grubhub.': 'Grubhub', 'seamless.': 'Seamless', 'tripadvisor.': 'Tripadvisor',
    'opentable.': 'OpenTable', 'allmenus.': 'Allmenus', 'zomato.': 'Zomato',
    'google.': 'Google', 'facebook.': 'Facebook', 'instagram.': 'Instagram',
    'toasttab.': 'Toast', 'square.site': 'Square', 'squareup.': 'Square',
    'clover.': 'Clover', 'chownow.': 'ChowNow', 'olo.com': 'Olo',
    'beyondmenu.': 'BeyondMenu', 'slicelife.': 'Slice',
  };
  for (const [needle, label] of Object.entries(map)) {
    if (host.includes(needle)) return label;
  }
  return null;
}

/**
 * Classify a menu source URL.
 * @param url   the page the menu was read from
 * @param isPdf whether the fetched content was a PDF
 */
export function classifySource(url: string, isPdf = false): SourceClassification {
  const host = hostName(url);
  if (!host) return { sourceType: 'unknown', official: false, sourceLabel: 'an unknown source' };

  if (THIRD_PARTY_HOSTS.some((h) => host.includes(h))) {
    const label = knownBrandLabel(host) ?? 'a third-party listing';
    return { sourceType: 'third_party', official: false, sourceLabel: label };
  }

  if (OFFICIAL_ORDERING_HOSTS.some((h) => host.includes(h))) {
    const label = knownBrandLabel(host);
    return {
      sourceType: 'official_ordering',
      official: true,
      sourceLabel: label ? `their ordering page on ${label}` : 'their online ordering page',
    };
  }

  if (isPdf || /\.pdf(\?|$)/i.test(url)) {
    return { sourceType: 'official_pdf', official: true, sourceLabel: 'their official menu PDF' };
  }

  // Anything else is treated as the restaurant's own website.
  return { sourceType: 'official_site', official: true, sourceLabel: 'their website' };
}

/**
 * Decide whether a menu read from `url` (with optional restaurant `address` and
 * the page's own `pageText`) is specific to a requested branch, a generic chain
 * menu, or unknown. Heuristic and deliberately conservative: we only claim
 * "location_specific" when there is real textual evidence (a city/street token
 * from the requested location appears in the page or the URL).
 */
export function classifyLocationScope(
  pageText: string,
  url: string,
  requestedLocation?: string | null,
): 'location_specific' | 'generic' | 'unknown' {
  if (!requestedLocation || !requestedLocation.trim()) return 'unknown';
  const tokens = requestedLocation
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 4 && !/^\d{2}$/.test(t)); // skip bare 2-letter states
  if (tokens.length === 0) return 'unknown';
  const hay = (pageText + ' ' + url).toLowerCase();
  const hit = tokens.some((t) => hay.includes(t));
  return hit ? 'location_specific' : 'generic';
}

export type MenuSource =
  | { kind: 'html'; text: string; html: string; url: string }
  | { kind: 'pdf'; base64: string; url: string }
  | { kind: 'image'; url: string };

export class FriendlyError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60000);
}

async function readCappedBody(response: Response, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FriendlyError(tooLargeMessage);
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new FriendlyError(tooLargeMessage);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new FriendlyError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readCappedText(response: Response, maxBytes: number, tooLargeMessage: string): Promise<string> {
  const bytes = await readCappedBody(response, maxBytes, tooLargeMessage);
  return new TextDecoder().decode(bytes);
}

/** Rough "does this text look like a menu" signal: count price-like tokens. */
export function priceSignals(text: string): number {
  return (text.match(/[$€£]\s?\d{1,3}(?:[.,]\d{2})?|\d{1,3}\.\d{2}\b/g) ?? []).length;
}

/**
 * Heuristic score for how menu-like a page's text is, used to pick the best
 * candidate among several found URLs. Prices are the strongest signal, but many
 * chain menus (e.g. The Cheesecake Factory) list no prices online yet are full,
 * valid menus — so food-word density and overall content length count too. This
 * keeps us from rating a rich price-less menu the same as an empty JS shell.
 */
export function menuLikelihood(text: string): number {
  const prices = priceSignals(text);
  // Food and drink words are counted separately. Lumping them together let a
  // bar list — dense with prices and the words "drinks"/"beverages" — score as
  // high as a real food menu, so the wrong page could win the candidate race.
  const foodWords = (
    text.match(
      /\b(appetizers?|entr[ée]es?|desserts?|salads?|sandwich(?:es)?|burgers?|pizzas?|pasta|chicken|beef|seafood|soups?|sides?|starters?|breakfast|lunch|dinner|specials?)\b/gi
    ) ?? []
  ).length;
  const drinkWords = (text.match(/\b(beverages?|drinks?|cocktails?|wines?|beers?)\b/gi) ?? []).length;
  const lengthBonus = Math.min(10, Math.floor(text.length / 4000));
  // Drink words still count as menu-ness — a full menu lists drinks too — but a
  // page with NO food words at all is a drinks list, not the menu we came for.
  const keywords = Math.min(foodWords, 40) + (foodWords > 0 ? Math.min(drinkWords, 8) : 0);
  const base = prices * 2 + keywords + lengthBonus;
  return foodWords === 0 ? Math.floor(base / 4) : base;
}

/** Hrefs on the page that look like links to a menu (absolute, deduped). */
export function findMenuLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 5) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!/menu|food|dinner|lunch|breakfast|brunch|dining|eat|order/i.test(href + ' ' + label)) continue;
    if (/instagram|facebook|twitter|tiktok|mailto:|tel:/i.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (!seen.has(abs) && abs !== baseUrl) {
        seen.add(abs);
        out.push(abs);
      }
    } catch {}
  }
  // PDFs and /menu paths first — they are the most likely full menus.
  return out.sort((a, b) => Number(scoreLink(b)) - Number(scoreLink(a)));
}

// Links whose URL says the page covers only one narrow slice of the offering.
// These are real menus, so they still rank — just below anything that might be
// the food menu.
const NARROW_MENU_URL =
  /(drink|beverage|cocktail|mocktail|wine|beer|bar|liquor|spirit|libation|dessert|kids|children|happy[-_]?hour|brunch[-_]?drink)/i;

export function scoreLink(url: string): number {
  let s = 0;
  if (/\.pdf(\?|$)/i.test(url)) s += 3;
  if (/menu/i.test(url)) s += 2;
  if (/food|dinner|lunch/i.test(url)) s += 1;
  // A drinks PDF used to score 5 (pdf + "menu" in "drink-menu.pdf") and beat
  // the actual dinner page at 3, which is how a tester searching for a
  // restaurant ended up with its bar list and nothing to eat. The penalty has
  // to exceed the PDF bonus, or "drinks-menu.pdf" still wins on format alone.
  if (NARROW_MENU_URL.test(url)) s -= 4;
  return s;
}

async function fetchWithBrowserless(url: string): Promise<string> {
  const res = await fetch('https://chrome.browserless.io/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BROWSERLESS_TOKEN}` },
    body: JSON.stringify({ url, waitFor: 3000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 429 || res.status === 402) {
    console.error('[Meet My Menu AI] BROWSERLESS_CREDITS_EXHAUSTED — headless fallback disabled until plan is renewed.');
    throw new Error('credits_exhausted');
  }
  if (!res.ok) throw new Error(`Browserless error (${res.status})`);
  return readCappedText(
    res,
    MAX_HTML_BYTES,
    'That rendered menu page is too large for me to read. Try a direct link to the menu instead.'
  );
}

/**
 * Render a JS-heavy page to clean text via the free Jina AI Reader. Returns the
 * page as markdown (tags already stripped), which the extractor reads as well as
 * or better than raw HTML. No key required; JINA_API_KEY only raises rate limits.
 */
async function renderViaReader(url: string): Promise<string> {
  const headers: Record<string, string> = {
    // Ask the reader for markdown; it strips boilerplate and keeps menu text/tables.
    'X-Return-Format': 'markdown',
    Accept: 'text/plain',
    'User-Agent': 'MeetMyMenuAI/1.0 (+https://meetmymenu.com; menu reader)',
  };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  // Jina URL form is https://r.jina.ai/<full target url>. Cap at 18s so the
  // find-menu deadline still leaves room for the extraction call afterward.
  const res = await fetch(READER_BASE + url, {
    headers,
    signal: AbortSignal.timeout(18000),
  });
  if (!res.ok) throw new Error(`reader_error_${res.status}`);
  return readCappedText(
    res,
    MAX_HTML_BYTES,
    'That rendered menu page is too large for me to read. Try a direct link to the menu instead.'
  );
}

// SSRF guard: only plain http(s) to public hosts. Blocks localhost, private
// ranges, link-local/metadata endpoints, and raw IPv6 literals.
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[|::)/i;
function assertPublicUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FriendlyError('That does not look like a valid web address.', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FriendlyError('Only regular web links are supported.', 400);
  }
  if (PRIVATE_HOST_RE.test(u.hostname) || u.hostname.endsWith('.internal') || u.hostname.endsWith('.local')) {
    throw new FriendlyError('That address cannot be reached from here.', 400);
  }
}

/** Fetch one URL and classify its content. No link-following at this level. */
async function fetchOne(url: string): Promise<MenuSource> {
  assertPublicUrl(url);
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      Accept: 'text/html,application/xhtml+xml,application/pdf,image/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new FriendlyError(
      `That website returned an error (${response.status}). Double-check the link and try again.`,
      502
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const finalUrl = response.url || url;
  // Redirects followed above could land on a private host — re-check.
  if (finalUrl !== url) assertPublicUrl(finalUrl);

  if (contentType.startsWith('image/')) {
    return { kind: 'image', url: finalUrl };
  }

  if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(finalUrl)) {
    const bytes = await readCappedBody(
      response,
      MAX_PDF_BYTES,
      'That menu PDF is too large for me to read. Try a link to the menu webpage instead.'
    );
    return { kind: 'pdf', base64: Buffer.from(bytes).toString('base64'), url: finalUrl };
  }

  let html = await readCappedText(
    response,
    MAX_HTML_BYTES,
    'That menu page is too large for me to read. Try a direct link to the menu instead.'
  );
  let text = stripHtml(html);

  // JS shell? A plain fetch of a client-rendered menu yields almost no text.
  // Render it: free Jina reader first, then Browserless only if a token is set.
  if (text.length < JS_SHELL_THRESHOLD) {
    let rendered = '';
    try {
      rendered = await renderViaReader(finalUrl); // markdown text, already clean
    } catch {}
    // Browserless is a paid fallback we only touch when a token is configured
    // and the free reader came up short. It returns raw HTML, so strip it.
    if (rendered.length < JS_SHELL_THRESHOLD && BROWSERLESS_TOKEN) {
      try {
        const raw = await fetchWithBrowserless(finalUrl);
        const stripped = stripHtml(raw);
        if (stripped.length > rendered.length) {
          rendered = stripped;
          html = raw; // keep HTML so menu-link following can still work
        }
      } catch {}
    }
    if (rendered.trim().length > text.length) {
      text = rendered.slice(0, TEXT_CAP);
    }
  }

  return { kind: 'html', text, html, url: finalUrl };
}

/**
 * Fetch a URL; if it's an HTML page with weak menu signal but it links to a
 * menu page or PDF, follow the best link one hop and use whichever is stronger.
 */
export async function fetchMenuSource(url: string): Promise<MenuSource> {
  const first = await fetchOne(url);
  if (first.kind !== 'html') return first;

  if (priceSignals(first.text) >= 5) return first;

  for (const link of findMenuLinks(first.html, first.url).slice(0, 2)) {
    try {
      const next = await fetchOne(link);
      if (next.kind !== 'html') return next; // a PDF or image menu — take it
      if (priceSignals(next.text) > priceSignals(first.text)) return next;
    } catch {}
  }
  return first;
}

const MENU_JSON_SHAPE =
  '{"restaurantName":string|null,"categories":[{"name":string,"items":[{"name":string,"description":string,"price":string,"ingredients":string[]}]}],"notes":string,"incomplete":boolean,"incompleteReason":string}';

const PARSE_INSTRUCTIONS =
  'Extract EVERY menu item you can find. Group items into the menu\'s natural sections ' +
  '(appetizers, mains, desserts, drinks, specials, etc.). For each item include: name, ' +
  'description (if shown), price (as written, with currency symbol), and a best-effort ' +
  'ingredients list inferred from the name and description. Extract the restaurant name if visible. ' +
  'If no menu items are found, set categories to an empty array. ' +
  'Set "incomplete" to true if this looks like only PART of the menu — text cut off, ' +
  'sections referenced but missing, a page clearly continuing elsewhere, or unreadable areas. ' +
  'Judge this against the restaurant\'s WHOLE offering, not against the document in front of ' +
  'you. A drinks-only, dessert-only, or kids-only list is a complete document but only PART of ' +
  'the menu, so mark it incomplete and say which part it is. ' +
  'Set it to false only if this looks like the restaurant\'s full food menu. ' +
  'When "incomplete" is true, set "incompleteReason" to a SHORT plain-language phrase a ' +
  'person would understand, naming what is missing if you can tell — for example ' +
  '"the drinks section is missing", "prices are not shown", or "the text was cut off". ' +
  'Leave "incompleteReason" as an empty string when the menu appears whole. ' +
  `Respond ONLY with JSON matching: ${MENU_JSON_SHAPE}`;

async function openaiChat(body: object): Promise<any> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new FriendlyError('No API key configured on the server.', 500);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(55000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[Meet My Menu AI] OpenAI parse error:', res.status, text.slice(0, 500));
    throw new FriendlyError('Something went wrong reading that menu. Please try again in a moment.', 502);
  }
  return res.json();
}

/** Extract the first JSON object from model output (tolerates code fences/prose). */
export function extractJson(raw: string): any {
  const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new FriendlyError('The menu reader returned something unreadable. Please try again.');
}

export function sanitizeMenu(menu: ParsedMenu): ParsedMenu {
  const categories: MenuCategory[] = [];
  if (Array.isArray(menu.categories)) {
    for (const cat of menu.categories) {
      if (!cat || typeof cat !== 'object' || Array.isArray(cat)) continue;
      const name = typeof cat.name === 'string' ? cat.name.trim() : '';
      if (!name || !Array.isArray(cat.items)) continue;
      const items: MenuItem[] = [];
      for (const item of cat.items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const itemName = typeof item.name === 'string' ? item.name.trim() : '';
        if (!itemName) continue;
        items.push({
          name: itemName,
          description: typeof item.description === 'string' ? item.description : undefined,
          price: typeof item.price === 'string' ? item.price : undefined,
          ingredients: Array.isArray(item.ingredients)
            ? item.ingredients.filter((x): x is string => typeof x === 'string')
            : undefined,
        });
      }
      if (items.length) categories.push({ name, items });
    }
  }
  return {
    ...menu,
    categories,
    notes: typeof menu.notes === 'string' ? menu.notes : undefined,
    restaurantName: typeof menu.restaurantName === 'string' ? menu.restaurantName : undefined,
    incomplete: menu.incomplete === true,
    incompleteReason:
      menu.incomplete === true && typeof menu.incompleteReason === 'string' && menu.incompleteReason.trim()
        ? menu.incompleteReason.trim()
        : undefined,
  };
}

/** Run OpenAI extraction over a classified menu source. Throws FriendlyError. */
export async function parseMenuSource(src: MenuSource): Promise<ParsedMenu> {
  let content: any;
  if (src.kind === 'image') {
    content = [
      { type: 'text', text: 'You are reading an image of a restaurant menu. ' + PARSE_INSTRUCTIONS },
      { type: 'image_url', image_url: { url: src.url, detail: 'high' } },
    ];
  } else if (src.kind === 'pdf') {
    content = [
      {
        type: 'file',
        file: { filename: 'menu.pdf', file_data: `data:application/pdf;base64,${src.base64}` },
      },
      { type: 'text', text: 'You are reading a PDF of a restaurant menu. ' + PARSE_INSTRUCTIONS },
    ];
  } else {
    if (!src.text.trim()) {
      throw new FriendlyError(
        'That page looks empty to me. Try linking directly to their menu page, like adding /menu to the address.'
      );
    }
    content =
      'You are reading text scraped from a restaurant website. ' + PARSE_INSTRUCTIONS +
      '\n\nWEBSITE TEXT:\n' + src.text;
  }

  const json = await openaiChat({
    model: PARSE_MODEL,
    messages: [{ role: 'user', content }],
    // response_format json_object is not supported alongside file inputs on all
    // models — extractJson() handles fenced/prose output either way.
    ...(src.kind === 'html' ? { response_format: { type: 'json_object' } } : {}),
  });

  const raw = json.choices?.[0]?.message?.content ?? '{}';
  const parsed = extractJson(raw) as ParsedMenu;
  return sanitizeMenu(parsed);
}

export function menuItemCount(menu: ParsedMenu): number {
  return menu.categories.reduce((s, c) => s + (c.items?.length ?? 0), 0);
}

// ── Deterministic completeness ──────────────────────────────────────────────
// The extraction model sets `incomplete` when it notices a fragment, but often
// it does not: a three-item scrap parses cleanly and looks whole to the model.
// Presenting that as the restaurant's entire menu is exactly the failure this
// product exists to prevent, so these checks run IN ADDITION to the model's
// judgment. They can only ever move a menu toward "incomplete", never away.

/** Below this many items we will not claim to have the whole menu. */
const MIN_CONFIDENT_ITEMS = 8;
/** A one-section menu needs more items before it reads as a whole menu. */
const MIN_SINGLE_SECTION_ITEMS = 12;
/** Listing sites often show a sample, so they need more items to look whole. */
const MIN_THIRD_PARTY_ITEMS = 12;

// Section words that rarely appear inside a dish name, so seeing one in the
// source text with no matching category is real evidence a section was missed.
const EXPECTED_SECTIONS = ['appetizer', 'entree', 'entrée', 'dessert', 'beverage'];

/** Cues that the page or scan stopped part-way through the menu. */
const TRUNCATION_CUES =
  /\b(continued|continues on|page \d+ of \d+|see (?:reverse|other side|next page)|cont'd)\b/i;

// A document can be internally whole and still not be the menu the guest
// wanted. A bar list has every section a bar list should have, so the model
// correctly reports it as complete — "is this document complete" and "is this
// the food menu" are simply different questions, and only the second one is
// what someone deciding what to eat is asking. Reported by a blind tester who
// searched for a restaurant, got its drinks PDF, and was left with "a good
// list of things to drink, but no food".
//
// Checked by CATEGORY NAME rather than item names, and food is tested first,
// so "Bar Snacks" and "Dessert Wines" land on the right side. Anything
// unrecognised counts as food, keeping this one-directional: it can only flag
// a menu that is unambiguously all drinks (or all sweets), never a real one.
const FOOD_SECTION =
  /\b(appetiz|starters?|entr[ée]es?|mains?|main course|plates?|sandwich|burgers?|pizzas?|pastas?|salads?|soups?|sides?|snacks?|bites?|tapas|antipast|primi|secondi|contorni|breakfast|brunch|lunch|dinner|supper|tacos?|burritos?|sushi|sashimi|rolls?|noodles?|ramen|rice|curr(?:y|ies)|seafood|fish|steaks?|chops?|grill|bbq|barbecue|chicken|beef|pork|lamb|veggie|vegetarian|vegan|kids?|children|specials?|platters?|combos?|bowls?|wraps?|subs?|gyros?|kebabs?|dumplings?|charcuterie|cheese board|raw bar|oysters?|small plates?|large plates?|share|for the table)\b/i;
const DRINK_SECTION =
  /\b(drinks?|beverages?|libations?|cocktails?|mocktails?|wines?|beers?|ales?|lagers?|ciders?|spirits?|liqueurs?|liquors?|bar|draft|draught|on tap|by the glass|bottles?|cellar|sake|soju|sodas?|juices?|smoothies?|coffee|espresso|teas?|cordials?|champagne|prosecco|sparkling|ros[ée]|whisk(?:e)?y|bourbon|scotch|gin|vodka|rum|tequila|mezcal|margaritas?|martinis?|sangria|aperitivo|digestivo|amaro|punch|shots?|pours?|flights?)\b/i;
const DESSERT_SECTION =
  /\b(desserts?|sweets?|pastries|pastry|gelato|sorbet|ice cream|cakes?|pies?|dolci|confections?)\b/i;

type SectionKind = 'food' | 'drink' | 'dessert';

/** Classify one category name. Unrecognised names count as food (see above). */
export function classifySection(name: string): SectionKind {
  if (FOOD_SECTION.test(name)) return 'food';
  if (DRINK_SECTION.test(name)) return 'drink';
  if (DESSERT_SECTION.test(name)) return 'dessert';
  return 'food';
}

/**
 * If every section is drinks (or every section is sweets), this is a partial
 * menu no matter how internally complete it looks. Returns the reason, else null.
 */
export function narrowMenuReason(menu: ParsedMenu): string | null {
  const kinds = menu.categories.filter((c) => c.items.length > 0).map((c) => classifySection(c.name));
  if (kinds.length === 0) return null;
  if (kinds.every((k) => k === 'drink')) {
    return 'this is the drinks list — there is no food on it, so the kitchen menu is somewhere else';
  }
  if (kinds.every((k) => k === 'dessert')) {
    return 'this is the dessert menu — the main courses are somewhere else';
  }
  return null;
}

export interface CompletenessAssessment {
  incomplete: boolean;
  reason?: string;
}

/** A section the text names that never became a category, else null. */
function missingSection(menu: ParsedMenu, text: string): string | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  const categoryNames = menu.categories.map((c) => c.name.toLowerCase()).join(' ');
  for (const section of EXPECTED_SECTIONS) {
    if (!hay.includes(section)) continue;
    if (categoryNames.includes(section)) continue;
    return section === 'entrée' ? 'entree' : section;
  }
  return null;
}

/**
 * Decide whether a parsed menu can honestly be called complete.
 * `sourceText` is the page text the menu came from (when available) and
 * `sourceType` its classification; both only ever add caution.
 */
export function assessMenuCompleteness(
  menu: ParsedMenu,
  opts: { sourceText?: string; sourceType?: MenuSourceType } = {},
): CompletenessAssessment {
  const items = menuItemCount(menu);
  const categories = menu.categories.length;

  // The model saying "partial" always stands.
  if (menu.incomplete) {
    return { incomplete: true, reason: menu.incompleteReason ?? 'some of it could not be read' };
  }
  if (items === 0) {
    return { incomplete: true, reason: 'I could not find any dishes on it' };
  }
  // Before the size checks: a 60-item bar list is plenty big and perfectly
  // whole, and would sail through every count below.
  const narrow = narrowMenuReason(menu);
  if (narrow) {
    return { incomplete: true, reason: narrow };
  }
  if (items < MIN_CONFIDENT_ITEMS) {
    return {
      incomplete: true,
      reason: `I only found ${items} ${items === 1 ? 'dish' : 'dishes'}, which is usually part of a menu rather than all of it`,
    };
  }
  if (categories <= 1 && items < MIN_SINGLE_SECTION_ITEMS) {
    return { incomplete: true, reason: 'I only found one section of it' };
  }
  if (opts.sourceType === 'third_party' && items < MIN_THIRD_PARTY_ITEMS) {
    return { incomplete: true, reason: 'it came from a listing site, which often shows only some of the dishes' };
  }

  const text = opts.sourceText ?? '';
  if (text && TRUNCATION_CUES.test(text)) {
    return { incomplete: true, reason: 'the page looks like it continues somewhere else' };
  }
  const missing = missingSection(menu, text);
  if (missing) {
    return { incomplete: true, reason: `the ${missing} section is mentioned but I could not read it` };
  }

  return { incomplete: false };
}

/**
 * Apply the assessment to a menu so the menu object itself carries the honest
 * verdict, and hand back the provenance fields both read routes need.
 */
export function applyCompleteness(
  menu: ParsedMenu,
  opts: { sourceText?: string; sourceType?: MenuSourceType } = {},
): { completeness: 'complete' | 'partial'; warnings?: string[] } {
  const verdict = assessMenuCompleteness(menu, opts);
  menu.incomplete = verdict.incomplete;
  menu.incompleteReason = verdict.incomplete ? verdict.reason : undefined;
  return {
    completeness: verdict.incomplete ? 'partial' : 'complete',
    warnings: verdict.reason ? [verdict.reason] : undefined,
  };
}
