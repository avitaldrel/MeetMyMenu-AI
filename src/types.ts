export interface UserProfile {
  email: string;
  name: string;
  allergies: string[];
  dislikes: string[];
  cuisinesLiked: string[];
  pastOrders: string[]; // dishes the guest decided on before — feeds recommendations
  diningHistory: DiningHistoryEntry[];
  hidePrices: boolean;
  ttsVoice: string;
  onboarded: boolean;
  imageLogging: boolean;
  // Accessibility preferences.
  theme?: AppTheme; // color scheme (default 'dark': warm amber on near-black)
  textScale?: TextScale; // global text size (default 'large')
  speechRate?: number; // Conversation Mode speaking speed multiplier (default 1)
  tutorialSeen?: boolean; // first-run tutorial shown once, then never auto-shown
  // Which mode a menu opens in. 'conversation' = Meet My Menu AI speaks and
  // listens; 'browse' = silent, so a screen reader reads the menu without the
  // app talking over it. Requested by screen-reader users who never want the
  // app to self-voice: without this the choice reset to 'conversation' on
  // every launch and had to be re-made each time.
  menuOpenMode?: MenuOpenMode; // default 'conversation'
}

export type MenuOpenMode = 'conversation' | 'browse';

export interface DiningHistoryEntry {
  id: string;
  learnedAt: string;
  restaurantName?: string;
  location?: string;
  sourceType?: MenuSourceType;
  orders: string[];
  likes: string[];
  dislikes: string[];
  turnCount: number;
  menuItemCount?: number;
}
// Color schemes tuned for different low-vision needs:
//   dark          – light text on near-black (glare/photophobia friendly)
//   light         – near-black text on white (maximum edge contrast)
//   high-contrast – white text and orange accents on pure black
export type AppTheme = 'dark' | 'light' | 'high-contrast';
export type TextScale = 'normal' | 'large' | 'xlarge' | 'xxlarge';

export interface MenuItem {
  name: string;
  description?: string;
  price?: string;
  ingredients?: string[];
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface ParsedMenu {
  categories: MenuCategory[];
  notes?: string;
  restaurantName?: string; // extracted from the menu photos if visible
  incomplete?: boolean; // model judged the menu partial (cut off, missing sections)
  incompleteReason?: string; // plain-language why it looks partial (e.g. "no drinks section")
  pageCount?: number; // number of menu pages/photos captured when known
}

// Where a menu came from and how much we can vouch for it. This is the backbone
// of the "be honest about uncertainty" product principle: every retrieved menu
// carries one of these so the UI and voice can explain source, location scope,
// freshness, and completeness instead of presenting everything as confirmed.
export type MenuSourceType =
  | 'official_site' // the restaurant's own website menu page
  | 'official_pdf' // a PDF hosted on the restaurant's own domain
  | 'official_ordering' // the restaurant's own ordering page (Toast/Square/etc.)
  | 'third_party' // a listing/aggregator (Yelp, DoorDash, Grubhub, ...)
  | 'direct_link' // a link the user pasted; officiality unknown
  | 'photo' // scanned from the physical menu by camera
  | 'unknown';

export type LocationScope =
  | 'location_specific' // evidence this menu belongs to the requested branch
  | 'generic' // a brand/chain menu not tied to one branch
  | 'unknown';

export type Completeness = 'complete' | 'partial' | 'unknown';

// Coarse freshness buckets derived from checkedAt. Not stored; computed on read.
export type Freshness = 'recent' | 'aging' | 'outdated' | 'unknown';

export interface MenuProvenance {
  sourceType: MenuSourceType;
  official: boolean; // true for official_* and (trusted) photo; false for third_party
  locationScope: LocationScope;
  confirmedLocation?: string; // human address/branch we believe this menu is for
  sourceUrl?: string;
  sourceLabel?: string; // friendly source name, e.g. "their website", "DoorDash"
  checkedAt: string; // ISO date this menu was retrieved/verified
  completeness: Completeness;
  warnings?: string[]; // anything the user should know (e.g. "drinks section missing")
}

export interface SavedRestaurant {
  id: string;
  name: string;
  menu: ParsedMenu;
  capturedAt: string; // ISO date
  createdAt?: string; // first time this restaurant/location was saved
  updatedAt?: string; // last time the saved menu data changed
  lastOpenedAt?: string;
  openCount?: number;
  saveCount?: number;
  categoryCount?: number;
  itemCount?: number;
  sourceUrl?: string;
  location?: string; // confirmed branch address; keeps chain branches separate
  provenance?: MenuProvenance;
}

export interface ChatTurn {
  role: 'assistant' | 'user';
  text: string;
}

export const EMPTY_PROFILE: UserProfile = {
  email: '',
  name: '',
  allergies: [],
  dislikes: [],
  cuisinesLiked: [],
  pastOrders: [],
  diningHistory: [],
  hidePrices: false,
  ttsVoice: 'shimmer',
  onboarded: false,
  imageLogging: false,
  // Default to the warm dark theme; Light and High-contrast stay one tap away
  // in Settings, and any theme a user has already saved is preserved on load.
  theme: 'dark',
  textScale: 'large',
  speechRate: 1,
  // Conversation is the app's headline feature, so it stays the default for a
  // new account; Settings makes Browse the permanent choice in one tap.
  menuOpenMode: 'conversation',
};
