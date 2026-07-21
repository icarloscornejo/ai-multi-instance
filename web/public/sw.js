// Deliberately does no caching. The app is useless offline (everything is a local
// REST/WebSocket call), and precaching would fight the existing self-update flow
// (git pull + rebuild): a cached shell would keep serving stale assets after an update.
// This file exists only so Chrome/Android consider the app installable.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler: every request falls through to the network untouched.
