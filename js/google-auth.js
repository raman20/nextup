let tokenClient = null;
let accessToken = null;
let expiresAt = 0;
let onChange = () => {};

export function hasGis() {
  return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
}

export function initGoogle(clientId, cb) {
  onChange = cb || onChange;
  if (!clientId || !hasGis()) return false;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/youtube.force-ssl",
    callback: (resp) => {
      if (resp.error) {
        onChange(false, resp.error);
        return;
      }
      accessToken = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 90) * 1000;
      onChange(true);
    },
  });
  return true;
}

export function signIn(prompt) {
  if (!tokenClient) throw new Error("Google Sign-In is not ready");
  tokenClient.requestAccessToken({ prompt: prompt == null ? (accessToken ? "" : "consent") : prompt });
}

export function getToken() {
  if (!accessToken) return null;
  if (Date.now() >= expiresAt) return null;
  return accessToken;
}

export function signedIn() {
  return !!getToken();
}

export function signOut() {
  const t = accessToken;
  accessToken = null;
  expiresAt = 0;
  if (t && hasGis() && window.google.accounts.oauth2.revoke) {
    try {
      window.google.accounts.oauth2.revoke(t);
    } catch {}
  }
  onChange(false);
}
