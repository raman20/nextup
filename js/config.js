/**
 * Public OAuth 2.0 Web client ID (Google Cloud → APIs & Services → Credentials).
 * Enable YouTube Data API v3. Authorized JavaScript origins must include this site
 * (e.g. https://raman20.github.io and http://localhost:8080).
 * Override locally with localStorage nextup.googleClientId.
 */
export const GOOGLE_CLIENT_ID = "";

export function clientId() {
  return (localStorage.getItem("nextup.googleClientId") || GOOGLE_CLIENT_ID || "").trim();
}
