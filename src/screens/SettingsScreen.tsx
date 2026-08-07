// Settings: hide prices, edit allergies/preferences.
// This screen never speaks — VoiceOver reads all controls and the status
// region.

import { useRef, useState } from 'react';
import { Screen, Title, Body, Heading, PrimaryButton, SecondaryButton, AllergenReviewPanel, type AllergenQuestion } from '../components';
import { ScreenProps } from '../nav';
import { useProfile } from '../state/ProfileContext';
import { splitList, reviewAllergenInput, removeFromList } from '../util';
import { setSpeechRate } from '../lib/speech';
import { track } from '../lib/telemetry';
import { configuredAppleShortcutUrl, isAppleMobileDevice } from '../lib/appleShortcut';
import type { AppTheme, TextScale, MenuOpenMode } from '../types';

const THEME_OPTIONS: { value: AppTheme; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Light text on a near-black background. Easiest on the eyes in low light.' },
  { value: 'light', label: 'Light', hint: 'Dark text on a white background. Highest edge contrast.' },
  { value: 'high-contrast', label: 'High contrast', hint: 'White text and orange accents on pure black. Maximum contrast.' },
];
const TEXT_SIZES: { value: TextScale; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' },
  { value: 'xxlarge', label: 'Maximum' },
];
const SPEECH_RATES: { value: number; label: string }[] = [
  { value: 0.8, label: 'Slow' },
  { value: 1, label: 'Normal' },
  { value: 1.25, label: 'Fast' },
];
const MENU_OPEN_MODES: { value: MenuOpenMode; label: string; hint: string }[] = [
  {
    value: 'conversation',
    label: 'Talk with me',
    hint: 'Meet My Menu AI reads the menu aloud and listens for your questions.',
  },
  {
    value: 'browse',
    label: 'Stay silent',
    hint: 'Menus open silent so your screen reader can read them without the app talking. You can still start a conversation any time.',
  },
];

// A large, accessible segmented control (radiogroup). Each option is a 64px+
// button; the selected one is announced and highlighted with the accent color.
function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="row" role="radiogroup" aria-label={legend} style={{ flexWrap: 'wrap', gap: 8 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            aria-label={`${opt.label}${active ? ', selected' : ''}`}
            className={`seg-btn${active ? ' seg-btn--active' : ''}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function SettingsScreen({ goBack, navigate }: ScreenProps) {
  const { profile, update, reset } = useProfile();
  const shortcutUrl = configuredAppleShortcutUrl();
  const showAppleShortcut = !!shortcutUrl && isAppleMobileDevice();
  const [allergies, setAllergies] = useState(profile.allergies.join(', '));
  const allergyInputRef = useRef<HTMLInputElement>(null);
  const [cuisines, setCuisines] = useState(profile.cuisinesLiked.join(', '));
  const [saved, setSaved] = useState(false);
  const [nameVal, setNameVal] = useState(profile.name);
  const [dislikes, setDislikes] = useState<string[]>(profile.dislikes);
  const [newDislike, setNewDislike] = useState('');
  const [pastOrders, setPastOrders] = useState<string[]>(profile.pastOrders);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const [srStatus, setSrStatus] = useState('');

  // Status region only — Settings never speaks. VoiceOver reads the update
  // from the role="status" live region; app TTS is reserved for Conversation Mode.
  const announce = (msg: string) => {
    setSrStatus(msg);
  };

  // Pending questions about the allergy list. Nothing is saved while this is
  // non-null; the user answers each question, THEN we save.
  const [allergyReview, setAllergyReview] = useState<AllergenQuestion[] | null>(null);
  const reviewAcceptedRef = useRef<string[]>([]);

  const saveAllergyList = async (list: string[]) => {
    // De-dupe case-insensitively while keeping the user's chosen spellings.
    const seen = new Set<string>();
    const final = list.filter((a) => {
      const k = a.trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await update({ allergies: final, cuisinesLiked: splitList(cuisines) });
    setAllergies(final.join(', '));
    setSaved(true);
    // Allergies are a safety feature — confirm in the DOM and aloud what was
    // saved so a VoiceOver user knows the warning list took effect.
    const msg = final.length
      ? `Saved. I will warn you about ${final.join(', ')}.`
      : 'Saved. No allergies set.';
    announce(msg);
    setTimeout(() => setSaved(false), 2000);
  };

  /**
   * The user removed a word we did not recognize. Drop just that word, keep the
   * rest of the list, and return focus to the allergy field so they can retype
   * it rather than having Settings save without that allergy.
   */
  const removeAndRetype = (removed: string) => {
    setAllergies((current) => removeFromList(current, removed));
    setAllergyReview(null);
    announce(`Removed ${removed}. Type it again, spelled differently, or leave it out.`);
    window.setTimeout(() => allergyInputRef.current?.focus(), 0);
  };

  const persist = async () => {
    // NEVER silently rewrite an allergy. If a word looks misspelled we ask
    // before changing it; if we don't recognize it at all, we ask what to do.
    const review = reviewAllergenInput(splitList(allergies));
    const questions: AllergenQuestion[] = [
      ...review.corrections.map(([typed, suggested]) => ({ typed, suggested })),
      ...review.unknown.map((typed) => ({ typed })),
    ];
    if (questions.length > 0) {
      reviewAcceptedRef.current = review.accepted;
      setAllergyReview(questions);
      announce(
        questions.length === 1
          ? 'One quick question about your allergy list before I save it. Answer below.'
          : `${questions.length} quick questions about your allergy list before I save it. Answer below.`,
      );
      return;
    }
    await saveAllergyList(review.accepted);
  };

  const saveName = async (val: string) => {
    const trimmed = val.trim();
    if (!trimmed || trimmed === profile.name) return;
    await update({ name: trimmed });
    announce(`Name updated to ${trimmed}.`);
  };

  const currentTheme: AppTheme = profile.theme ?? 'dark';
  const currentScale: TextScale = profile.textScale ?? 'large';
  const currentRate = profile.speechRate ?? 1;
  const currentMenuOpenMode: MenuOpenMode = profile.menuOpenMode ?? 'conversation';
  const themeHint = THEME_OPTIONS.find((t) => t.value === currentTheme)?.hint ?? '';

  return (
    <Screen>
      <Title>Settings</Title>

      <SecondaryButton
        label="How Meet My Menu AI works"
        hint="Open the step by step tutorial"
        onClick={() => navigate({ name: 'tutorial' })}
      />

      <Heading>Accessibility</Heading>

      <div className="setting-block">
        <span className="setting-label" id="setting-textsize">Text size</span>
        <Segmented
          legend="Text size"
          options={TEXT_SIZES}
          value={currentScale}
          onChange={(v) => {
            update({ textScale: v });
            announce(`Text size ${TEXT_SIZES.find((t) => t.value === v)?.label}.`);
          }}
        />
      </div>

      <div className="setting-block">
        <span className="setting-label">Color scheme</span>
        <Segmented
          legend="Color scheme"
          options={THEME_OPTIONS.map(({ value, label }) => ({ value, label }))}
          value={currentTheme}
          onChange={(v) => {
            update({ theme: v });
            announce(`${THEME_OPTIONS.find((t) => t.value === v)?.label} theme. ${THEME_OPTIONS.find((t) => t.value === v)?.hint ?? ''}`);
          }}
        />
        <p className="body" style={{ margin: '4px 0 0', fontSize: 'calc(14px * var(--text-scale))' }}>{themeHint}</p>
      </div>

      {/* Screen-reader users who prefer to read menus themselves were having to
          press Browse Menu on every launch, because the mode reset each time.
          This makes that choice stick. */}
      <div className="setting-block">
        <span className="setting-label">When you open a menu</span>
        <Segmented
          legend="When you open a menu"
          options={MENU_OPEN_MODES.map(({ value, label }) => ({ value, label }))}
          value={currentMenuOpenMode}
          onChange={(v) => {
            update({ menuOpenMode: v });
            const chosen = MENU_OPEN_MODES.find((m) => m.value === v);
            announce(`${chosen?.label}. ${chosen?.hint ?? ''}`);
          }}
        />
        <p className="body" style={{ margin: '4px 0 0', fontSize: 'calc(14px * var(--text-scale))' }}>
          {MENU_OPEN_MODES.find((m) => m.value === currentMenuOpenMode)?.hint}
        </p>
      </div>

      <div className="setting-block">
        <span className="setting-label">Talking speed</span>
        <Segmented
          legend="Talking speed"
          options={SPEECH_RATES}
          value={currentRate}
          onChange={(v) => {
            // Apply immediately to the next Conversation Mode response, then persist.
            setSpeechRate(v);
            update({ speechRate: v });
            setSrStatus(`Talking speed ${SPEECH_RATES.find((r) => r.value === v)?.label}.`);
          }}
        />
        {currentMenuOpenMode === 'browse' && (
          <p className="body" style={{ margin: '4px 0 0', fontSize: 'calc(14px * var(--text-scale))' }}>
            Only applies once you start a conversation, since menus open silently.
          </p>
        )}
      </div>

      <Heading>Your name</Heading>
      <input
        className="input"
        type="text"
        value={nameVal}
        onChange={(e) => setNameVal(e.target.value)}
        onBlur={() => saveName(nameVal)}
        onKeyDown={(e) => { if (e.key === 'Enter') saveName(nameVal); }}
        placeholder="First name"
        aria-label="Your name"
      />

      <Heading>Foods you dislike</Heading>
      {dislikes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {dislikes.map((item) => (
            <div key={item} className="row" style={{ alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontSize: 16 }}>{item}</span>
              <button
                onClick={() => {
                  const next = dislikes.filter((d) => d !== item);
                  setDislikes(next);
                  update({ dislikes: next });
                }}
                aria-label={`Remove ${item} from dislikes`}
                className="btn-icon"
                style={{ color: 'var(--text-secondary)' }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        className="input"
        type="text"
        value={newDislike}
        onChange={(e) => setNewDislike(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && newDislike.trim()) {
            const trimmed = newDislike.trim();
            const next = [...dislikes.filter((d) => d.toLowerCase() !== trimmed.toLowerCase()), trimmed];
            setDislikes(next);
            setNewDislike('');
            update({ dislikes: next });
            announce(`Added ${trimmed} to your dislikes.`);
          }
        }}
        placeholder="Add a dislike (e.g. mushrooms)"
        aria-label="Add a dislike. Press Enter to add it"
      />

      {pastOrders.length > 0 && (
        <>
          <Heading>Dishes you've ordered before</Heading>
          <Body>Meet My Menu AI remembers these to make better recommendations. Remove any that don't belong.</Body>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pastOrders.map((item) => (
              <div key={item} className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontSize: 16 }}>{item}</span>
                <button
                  onClick={() => {
                    const next = pastOrders.filter((o) => o !== item);
                    setPastOrders(next);
                    update({ pastOrders: next });
                    announce(`Removed ${item} from your past orders.`);
                  }}
                  aria-label={`Remove ${item} from past orders`}
                  className="btn-icon"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {showAppleShortcut && (
        <section className="card" aria-labelledby="apple-shortcut-heading">
          <Heading><span id="apple-shortcut-heading">Open Meet My Menu AI with Siri</span></Heading>
          <Body>Create a Shortcut so saying “Siri, launch Meet My Menu AI” opens this app.</Body>
          <a
            className="btn btn-secondary"
            href={shortcutUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
            aria-label="Create Siri Shortcut. Opens Apple's Shortcut page in a new tab"
            onClick={() => track('settings', 'shortcut_open', {})}
          >
            Create Siri Shortcut
          </a>
        </section>
      )}

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: 16 }}
      >
        <div>
          <span style={{ fontSize: 18 }}>Save menu photos for analysis</span>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            When on, captured photos are uploaded so you can review them later.
          </p>
        </div>
        <input
          type="checkbox"
          checked={!!profile.imageLogging}
          onChange={(e) => update({ imageLogging: e.target.checked })}
          aria-label="Save menu photos for analysis. When on, captured photos are uploaded for later review"
          style={{ width: 28, height: 28, flexShrink: 0 }}
        />
      </label>

      <label
        className="card"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 18 }}>Hide prices</span>
        <input
          type="checkbox"
          checked={profile.hidePrices}
          onChange={(e) => update({ hidePrices: e.target.checked })}
          aria-label="Hide prices"
          style={{ width: 28, height: 28 }}
        />
      </label>

      <Heading>Allergies &amp; restrictions</Heading>
      <Body>Comma separated. I warn you before describing a dish.</Body>
      <input
        className="input"
        type="text"
        ref={allergyInputRef}
        value={allergies}
        onChange={(e) => setAllergies(e.target.value)}
        placeholder="e.g. shellfish, peanuts"
        aria-label="Allergies, comma separated"
      />

      <Heading>Foods you love</Heading>
      <input
        className="input"
        type="text"
        value={cuisines}
        onChange={(e) => setCuisines(e.target.value)}
        placeholder="e.g. Thai, spicy, seafood"
        aria-label="Favorite foods, comma separated"
      />

      {allergyReview && (
        <AllergenReviewPanel
          questions={allergyReview}
          onDone={(kept) => {
            setAllergyReview(null);
            saveAllergyList([...reviewAcceptedRef.current, ...kept]);
          }}
          onRetype={removeAndRetype}
        />
      )}

      <PrimaryButton label={saved ? 'Saved' : 'Save changes'} onClick={persist} disabled={!!allergyReview} />
      <p role="status" aria-live="polite" className="body" style={{ minHeight: 24, margin: 0, textAlign: 'center' }}>
        {srStatus}
      </p>
      <SecondaryButton label="Back" onClick={goBack} />
      <SecondaryButton
        label={confirmSignOut ? 'Confirm sign out' : 'Sign out'}
        tone="danger"
        hint={confirmSignOut ? 'Tap again to sign out' : 'Tap twice to sign out'}
        onClick={async () => {
          if (!confirmSignOut) {
            setConfirmSignOut(true);
            announce('Tap Confirm sign out to clear your account and return to the login screen.');
            return;
          }
          track('auth', 'logout', {});
          await reset();
          navigate({ name: 'home' });
        }}
      />
    </Screen>
  );
}
