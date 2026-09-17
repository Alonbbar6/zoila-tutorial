// Public settings. Safe to commit: there are no secrets here.
// The room link (#sala=...) and the admin token are never stored in the repo.
export const CONFIG = {
  // Paste your Apps Script Web App URL here (it ends with /exec). See README.md, step 3.
  apiUrl: "https://script.google.com/macros/s/PASTE_YOUR_DEPLOYMENT_ID/exec",
  // How often open pages check for news, in seconds.
  pollSeconds: 8,
};

// On localhost the dev server (node dev/server.mjs) answers at /api.
export function apiUrl() {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "/api";
  return CONFIG.apiUrl;
}

export function isConfigured() {
  return apiUrl() === "/api" || !CONFIG.apiUrl.includes("PASTE_YOUR_DEPLOYMENT_ID");
}
