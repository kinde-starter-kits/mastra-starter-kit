/**
 * Frontend configuration. Vite only exposes VITE_-prefixed variables to the
 * browser, so nothing secret can leak through here.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in — see the README "Configure Kinde" section.`
    );
  }
  return value;
}

export const env = {
  kindeDomain: required('VITE_KINDE_DOMAIN', import.meta.env.VITE_KINDE_DOMAIN),
  kindeClientId: required('VITE_KINDE_CLIENT_ID', import.meta.env.VITE_KINDE_CLIENT_ID),
  redirectUri: import.meta.env.VITE_KINDE_REDIRECT_URI ?? window.location.origin,
  logoutUri: import.meta.env.VITE_KINDE_LOGOUT_URI ?? window.location.origin,
  // Optional: only set once an API is registered in Kinde.
  audience: import.meta.env.VITE_KINDE_AUDIENCE || undefined,
  mastraUrl: import.meta.env.VITE_MASTRA_URL ?? 'http://localhost:4111'
};
