// Login. Remembers the user's email in localStorage so blind users never have
// to type it twice. This screen never speaks — instructions are visible text
// and feedback goes through the role="status" live region, so VoiceOver is the
// only voice here. App TTS is reserved for Conversation Mode.

import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Screen, Title, Heading, Body, PrimaryButton } from '../components';
import { useProfile } from '../state/ProfileContext';
import { restoreFromCloud, isDifferentUser, clearLocalUserData, establishSyncSession } from '../lib/storage';
import { track } from '../lib/telemetry';
import { isNativePlatform, signInWithGoogleNative } from '../lib/nativeGoogleAuth';

interface GoogleJwt {
  email: string;
  name?: string;
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const googleAvailable = !!googleClientId;

export default function LoginScreen() {
  const { profile, update } = useProfile();
  const [email, setEmail] = useState(profile.email ?? '');
  const [showEmail, setShowEmail] = useState(!googleAvailable);
  const [srStatus, setSrStatus] = useState('');

  const announce = (msg: string) => { setSrStatus(msg); };

  const loginWithEmail = async (emailToUse: string, name?: string, method: 'email' | 'google' = 'email') => {
    const trimmed = emailToUse.trim();
    if (!trimmed) {
      announce('Please enter your email address first.');
      return;
    }
    // Signing in as a different account: drop the previous user's local saves
    // first, so if this user has no cloud copy they start clean rather than
    // inheriting someone else's saved restaurants.
    if (await isDifferentUser(trimmed)) clearLocalUserData();
    const restored = await restoreFromCloud(trimmed);
    const base = restored ?? { email: trimmed };
    await update(name ? { ...base, name } : base);
    track('auth', 'login', {
      outcome: 'success',
      metadata: { method, cloud_restore_hit: !!restored },
    });
  };

  const handleGoogleIdToken = async (idToken: string) => {
    try {
      const decoded = jwtDecode<GoogleJwt>(idToken);
      announce(`Welcome, ${decoded.name ?? decoded.email}. Signing you in.`);
      // Exchange for a verified sync session BEFORE loading cloud data, so
      // this first load can actually use it. The server-verified email is the
      // authoritative identity for sync; if the exchange fails (offline, or
      // the server isn't configured for it yet) sign-in still proceeds
      // locally with the client-decoded email — cloud sync just stays
      // unavailable until a later successful Google sign-in.
      const verifiedEmail = await establishSyncSession(idToken);
      await loginWithEmail(verifiedEmail ?? decoded.email, decoded.name, 'google');
    } catch {
      announce('Google sign-in failed. Please enter your email instead.');
      track('auth', 'login', { outcome: 'failure', metadata: { method: 'google' } });
      setShowEmail(true);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: { credential?: string }) => {
    if (!credentialResponse.credential) return;
    await handleGoogleIdToken(credentialResponse.credential);
  };

  const handleGoogleError = () => {
    announce('Google sign-in failed. Please enter your email instead.');
    track('auth', 'login', { outcome: 'failure', metadata: { method: 'google' } });
    setShowEmail(true);
  };

  const handleNativeGoogleLogin = async () => {
    if (!googleClientId) return;
    announce('Opening Google sign-in.');
    const idToken = await signInWithGoogleNative(googleClientId);
    if (!idToken) {
      announce('Google sign-in was cancelled.');
      return;
    }
    await handleGoogleIdToken(idToken);
  };

  return (
    <Screen>
      <Title>Meet My Menu AI</Title>
      <Heading>Login</Heading>

      {/* ── Google Sign-In ─────────────────────────────── */}
      {googleAvailable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'stretch' }}>
          {isNativePlatform ? (
            <PrimaryButton
              label="Sign in with Google"
              onClick={handleNativeGoogleLogin}
              hint="Opens Google sign-in in your browser"
            />
          ) : (
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={handleGoogleError}
              useOneTap={false}
              text="signin_with"
              shape="rectangular"
              size="large"
              width="100%"
            />
          )}
          {!showEmail && (
            <button
              className="btn-ghost"
              onClick={() => {
                setShowEmail(true);
                announce('You can now enter your email address manually.');
              }}
              aria-label="Sign in with email instead of Google"
            >
              Use email
            </button>
          )}
        </div>
      )}

      {/* ── Email fallback ─────────────────────────────── */}
      {showEmail && (
        <>
          {profile.email && <Body>Saved email: {profile.email}.</Body>}

          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            aria-label="Email address"
            autoComplete="email"
            onKeyDown={(e) => { if (e.key === 'Enter') loginWithEmail(email); }}
          />

          <PrimaryButton
            label="Login"
            onClick={() => loginWithEmail(email)}
            hint="Continue with this email"
          />
        </>
      )}
      <p role="status" aria-live="polite" className="body" style={{ minHeight: 24, margin: 0, textAlign: 'center' }}>
        {srStatus}
      </p>
    </Screen>
  );
}
