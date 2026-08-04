# Meet My Menu AI: iOS App Store Plan (Capacitor)

Wrapping the existing web app for the App Store, not rebuilding it. The web
app stays as-is, Capacitor packages it into a real iOS app that can talk to
native device features where the web version can't.

## No Mac, here's the actual plan

Capacitor's iOS build step normally needs Xcode, which only runs on macOS.
Nobody on the team owns one, and renting one this early (MacStadium,
MacinCloud) means spending money before the pilot's even proven the product.
So:

1. Ask Avi first. Free, thirty seconds, if he already has a Mac that's the
   simplest path for early testing.
2. If not, use **Codemagic**. Built specifically for Capacitor and Ionic
   apps, builds and signs the iOS app entirely in the cloud, free tier is
   enough for an early-stage app, and it can even submit to App Store
   Connect directly. No Mac needed at any point.
3. A real iPhone is still needed regardless of the Mac question, that's for
   physical device testing (VoiceOver, camera), covered in step 4 below.
   Much easier and cheaper to get access to than a Mac.

## Step by step

### Step 1: Ask Avi about Mac access

Costs nothing, do this before anything else.

### Step 2: Prep the repo now, none of this needs a Mac

```
npm install @capacitor/core @capacitor/cli
npx cap init
```

`cap init` asks for an app name and bundle ID (e.g. `com.meetmymenu.app`).
This is permanent once published, decide it deliberately.

In `capacitor.config.ts`, set `webDir: 'dist'`, since that's where
`npm run build` already outputs the production bundle.

### Step 3: Fix Google Sign-In before touching iOS at all — done

`LoginScreen.tsx` now branches on `Capacitor.isNativePlatform()`. On the
web it still uses `@react-oauth/google`'s embedded button as before. On
native, a plain button opens the system browser (`@capacitor/browser`) to
Google's OAuth consent screen, and `src/lib/nativeGoogleAuth.ts` catches
the redirect back through the app's custom URL scheme
(`com.meetmymenu.app://oauth-callback`) via `@capacitor/app`'s
`appUrlOpen` listener. From there the flow rejoins the existing code path,
`establishSyncSession` and `verifyGoogleIdToken` on the server don't
change at all, since a native sign-in produces the same kind of Google ID
token as the web popup does.

One wrinkle: Google's implicit flow needs an `https` redirect URI (custom
schemes need a separate "iOS" type OAuth client, which this app doesn't
have yet). `public/oauth-callback.html` is a small static page on our own
domain whose only job is bouncing the token from that `https` redirect
into the app's custom scheme. Two things still need doing at the Xcode
config step (step 6, no Mac needed for this part either, just tracked
here so it isn't forgotten):

- Register `com.meetmymenu.app` as a URL Type in `Info.plist` so iOS
  routes that scheme back to the app.
- Add `https://meetmymenu.com/oauth-callback.html` as an authorized
  redirect URI on the existing Google OAuth client in Google Cloud
  Console (Web client, no new client needed).

This was pure web/TypeScript work, no Mac needed, done ahead of step 4 so
the eventual Codemagic build isn't blocked on it.

### Step 4: When ready to actually build for iOS, use Codemagic

```
npm install @capacitor/ios
```

Then connect the repo to Codemagic (free tier) and let it run
`npx cap add ios` and the Xcode build in the cloud. This is the step that
needed a Mac before, Codemagic removes that requirement entirely.

### Step 5: Camera and microphone

- Current camera capture uses raw `getUserMedia`, which generally works
  inside Capacitor's WebView but is worth testing directly. `@capacitor/camera`
  is the native-plugin fallback if it's unreliable.
- `MediaRecorder` for voice input and `speechSynthesis` for TTS fallback
  should both work as-is, also worth confirming on a real device.
- `localStorage` works fine as-is, no migration needed for the pilot.

### Step 6: iOS permissions and URL scheme

`Info.plist` needs usage-description strings for camera and microphone
(`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`), each with a
clear, honest explanation. Apple's review rejects vague or missing ones.

It also needs `com.meetmymenu.app` registered as a URL Type, for the
native Google Sign-In flow from step 3 to work (the system browser hands
control back to the app through that scheme).

### Step 7: Real device testing, this needs an actual iPhone

Same testing surface as the two device-only items already in the bug
queue (Pause/Resume mic behavior, camera capture across lighting and menu
conditions), worth doing as one combined pass once there's a real device
and a Codemagic build, rather than twice. Also confirm VoiceOver navigates
the wrapped app correctly, WKWebView accessibility bridging is generally
solid but deserves direct confirmation given what this app is for.

### Step 8: App Store assets and submission

- App icon in the required sizes (`@capacitor/assets` can generate these).
- Screenshots for the App Store listing.
- A real, accurate privacy policy URL. This app handles allergy and
  health-adjacent data, Apple's review and the App Privacy questionnaire
  both need this to be genuine.
- TestFlight beta before public submission, the Newark pilot users are the
  natural first beta testers, this folds the App Store work into the same
  pilot instead of starting a separate effort. Codemagic can push straight
  to TestFlight.
- Submit for review. Expect real scrutiny on the accessibility claims,
  since reviewers may actually test it with VoiceOver.

### Step 9: After launch

- App Store Optimization matters more here than for a typical app.
  VoiceOver users browse the Accessibility category directly, so keywords
  like "blind," "low vision," "VoiceOver," and "menu reader" should be in
  the listing deliberately.
- Decide on an update process. A native app doesn't auto-update with every
  web deploy, each fix needs a new build and usually another review cycle.
  Ionic Appflow's live-update feature is worth looking into for frequent
  small fixes, within Apple's policy limits on what can be updated without
  a full review.
