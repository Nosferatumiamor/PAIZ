// Verrou du serveur local : seule l'interface de PAIZ (et les programmes de la machine) peuvent piloter l'API.
// Sans lui, n'importe quel site ouvert dans le navigateur pourrait appeler http://127.0.0.1:<port>/api/… : lire le catalogue
// et la mémoire, effacer des modèles, lancer des tâches ou piloter OpenCode (qui a un terminal).
//  - Hôte : 127.0.0.1, localhost ou [::1] sur le port du serveur (bloque le « DNS rebinding ») ;
//  - Origine : celle de l'interface (ou de la fenêtre Tauri) ; une requête sans en-tête Origin vient d'un programme local (curl, OpenCode…) ;
//  - Sec-Fetch-Site : une requête « cross-site » d'un navigateur est refusée.
// /v1 (discussion compatible OpenAI) reste ouvert aux autres origines : des interfaces de chat dans le navigateur s'en servent,
// et il ne fait que produire du texte.

const TAURI = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

export function allowedHosts(port) { return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]); }

/** null si la requête est acceptée, sinon la raison du refus. */
export function checkLocal(req, pathname) {
  const port = req.socket?.localPort;
  const host = String(req.headers.host || '').toLowerCase();
  if (port && !allowedHosts(port).has(host)) return `hôte refusé (${host || 'absent'})`;
  if (pathname.startsWith('/v1/')) return null;
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !TAURI.has(origin) && !allowedHosts(port).has(origin.replace(/^https?:\/\//, '').toLowerCase())) return `origine refusée (${origin})`;
  if (origin === 'null') return 'origine refusée (null)';
  const site = req.headers['sec-fetch-site'];
  // ouvrir une page de l'interface (l'écran de démarrage de l'exe y bascule, un lien peut y mener) est sans danger : seules l'API et OpenCode sont fermés
  const page = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && !pathname.startsWith('/api/') && !pathname.startsWith('/oc/');
  if (site === 'cross-site' && !page) return 'requête venue d’un autre site';
  return null;
}
