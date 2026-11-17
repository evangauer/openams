"use client";

import { useSyncExternalStore } from "react";
import {
  AGENCY_SCHEMES, AGENCY_THEMES, DEFAULT_THEME, SCHEME_STORAGE_KEY,
  type AgencyScheme, type AgencyTheme,
} from "./appearance-options";
export {
  AGENCY_SCHEMES, AGENCY_THEMES, DEFAULT_THEME, SCHEME_STORAGE_KEY, THEME_STORAGE_KEY,
  type AgencyScheme, type AgencyTheme,
} from "./appearance-options";

const isScheme = (value: unknown): value is AgencyScheme =>
  AGENCY_SCHEMES.some((scheme) => scheme.id === value);
const listeners = new Set<() => void>();

const isTheme = (value: unknown): value is AgencyTheme =>
  AGENCY_THEMES.some((theme) => theme.id === value);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAgencyScheme(scheme: AgencyScheme) {
  document.documentElement.dataset.scheme = scheme;
  try {
    localStorage.setItem(SCHEME_STORAGE_KEY, scheme);
  } catch {
    // The choice still applies to this page.
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has("scheme")) {
    url.searchParams.set("scheme", scheme);
    window.history.replaceState(window.history.state, "", url);
  }
  listeners.forEach((listener) => listener());
}

export function useAgencyScheme(): AgencyScheme {
  return useSyncExternalStore(
    subscribe,
    () => {
      const value = document.documentElement.dataset.scheme;
      return isScheme(value) ? value : "saffron";
    },
    () => "saffron",
  );
}

export function useAgencyTheme(): AgencyTheme {
  return useSyncExternalStore(
    subscribe,
    () => {
      const value = document.documentElement.dataset.theme;
      return isTheme(value) ? value : DEFAULT_THEME;
    },
    () => DEFAULT_THEME,
  );
}
