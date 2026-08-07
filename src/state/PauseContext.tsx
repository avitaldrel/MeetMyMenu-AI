import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { stopSpeaking } from '../lib/speech';
import { useProfile } from './ProfileContext';

interface PauseCtx {
  paused: boolean;
  status: string;
  pause: (message?: string) => void;
  resume: (message?: string) => void;
  registerStopListening: (fn: (() => void) | null) => () => void;
}

const Ctx = createContext<PauseCtx | null>(null);

export function PauseProvider({ children }: { children: React.ReactNode }) {
  const { profile, loaded } = useProfile();
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState('');
  const stopListeningRef = useRef<(() => void) | null>(null);

  // Apply the saved "open menus in" preference once, as soon as the profile is
  // read. Screen-reader users who never want the app to self-voice previously
  // had to press Browse Menu on every single launch, because this state reset
  // to Conversation each time. Set directly rather than through pause() so the
  // starting mode is silent — announcing "Voice paused" for a preference the
  // user chose deliberately would be noise, not information.
  const appliedSavedModeRef = useRef(false);
  useEffect(() => {
    if (!loaded || appliedSavedModeRef.current) return;
    appliedSavedModeRef.current = true;
    if (profile.menuOpenMode === 'browse') setPaused(true);
  }, [loaded, profile.menuOpenMode]);

  const pause = useCallback((message = 'Voice paused. Meet My Menu AI stopped speaking and the microphone is off. Your conversation is saved.') => {
    stopSpeaking();
    stopListeningRef.current?.();
    setPaused(true);
    setStatus(message);
  }, []);

  const resume = useCallback((message = 'Voice resumed. The microphone is on and Meet My Menu AI can speak again.') => {
    setPaused(false);
    setStatus(message);
  }, []);

  const registerStopListening = useCallback((fn: (() => void) | null) => {
    stopListeningRef.current = fn;
    return () => {
      if (stopListeningRef.current === fn) stopListeningRef.current = null;
    };
  }, []);

  const value = useMemo(
    () => ({ paused, status, pause, resume, registerStopListening }),
    [paused, status, pause, resume, registerStopListening],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePause(): PauseCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error('usePause must be used inside PauseProvider');
  return value;
}
