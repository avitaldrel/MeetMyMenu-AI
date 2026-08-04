// Google Sign-In inside the Capacitor iOS app. The web flow (@react-oauth/google's
// embedded button/popup) fails with "Error 403: disallowed_useragent" inside a
// WKWebView, since Google blocks OAuth from embedded app browsers. This opens
// the system browser instead, which Google allows, and catches the redirect
// back through the app's custom URL scheme (registered in Info.plist at the
// Xcode/Codemagic build step — see CAPACITOR-IOS-PLAN.md).
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App, type URLOpenListenerEvent } from '@capacitor/app';

export const isNativePlatform = Capacitor.isNativePlatform();

// Google's implicit flow needs an https redirect_uri (custom schemes are only
// allowed for "iOS" type OAuth clients, and this app currently only has a
// Web client). oauth-callback.html is a static page on our own domain whose
// only job is bouncing the token from that https redirect into this scheme.
const REDIRECT_PAGE = 'https://meetmymenu.com/oauth-callback.html';
const APP_CALLBACK_PREFIX = 'com.meetmymenu.app://oauth-callback';

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens the system browser for Google Sign-In and resolves with the raw ID
 * token once the app is reopened via its custom URL scheme. Resolves null if
 * the user cancels (closes the browser without completing sign-in).
 */
export function signInWithGoogleNative(clientId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const nonce = randomNonce();

    const finish = (idToken: string | null) => {
      if (settled) return;
      settled = true;
      urlListener.then((h) => h.remove());
      closedListener.then((h) => h.remove());
      Browser.close().catch(() => {});
      resolve(idToken);
    };

    const urlListener = App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
      if (!event.url.startsWith(APP_CALLBACK_PREFIX)) return;
      const fragment = event.url.split('#')[1] ?? '';
      const params = new URLSearchParams(fragment);
      finish(params.get('id_token'));
    });

    const closedListener = Browser.addListener('browserFinished', () => finish(null));

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_PAGE);
    authUrl.searchParams.set('response_type', 'id_token');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('nonce', nonce);

    Browser.open({ url: authUrl.toString(), presentationStyle: 'popover' });
  });
}
