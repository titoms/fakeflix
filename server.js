'use strict';

// Serveur HTTP CinéMatch — Node.js natif, aucune dépendance.
// Les données sont chargées en mémoire au démarrage : toute modification
// (notes, films vus) est perdue au redémarrage.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Mode formateur : false = algorithme des élèves (recommender.js),
// true = solution de référence (recommender.solution.js). Pris en compte au redémarrage.
const USE_CORRECTION = true;

const { recommendMovies } = require(USE_CORRECTION ? './recommender.solution' : './recommender');
// const { recommendMovies } = require('./recommender');

const PORT = Number(process.env.PORT) || 3000;
const MAX_RECOMMENDATIONS = 5;
const MAX_BODY_BYTES = 10 * 1024;

const readData = (file) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
const movies = readData('movies.json');
const users = readData('users.json');
const moviesById = new Map(movies.map((m) => [m.id, m]));

// Seuls ces fichiers sont servis : rien d'autre n'est accessible par URL.
const PUBLIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/css/style.css': { file: 'css/style.css', type: 'text/css; charset=utf-8' },
  '/js/app.js': { file: 'js/app.js', type: 'text/javascript; charset=utf-8' },
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('not an object');
        }
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Le corps de la requête doit être un objet JSON valide'));
      }
    });
    req.on('error', reject);
  });
}

function findUser(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(400, `Identifiant utilisateur invalide : "${rawId}"`);
  }
  const user = users.find((u) => u.id === id);
  if (!user) throw new HttpError(404, `Utilisateur ${id} introuvable`);
  return user;
}

function requireMovie(movieId) {
  if (!Number.isInteger(movieId) || movieId < 1) {
    throw new HttpError(400, '`movieId` doit être un entier positif');
  }
  if (!moviesById.has(movieId)) throw new HttpError(404, `Film ${movieId} introuvable`);
}

function markWatched(user, movieId) {
  if (!user.watchedMovieIds.includes(movieId)) user.watchedMovieIds.push(movieId);
}

// Vérifie le contrat de sortie de recommendMovies() et explique l'erreur.
function validateRecommendations(result) {
  const problems = [];
  if (!Array.isArray(result)) {
    return ['recommendMovies() doit retourner un tableau'];
  }
  if (result.length > MAX_RECOMMENDATIONS) {
    problems.push(`${result.length} recommandations retournées (maximum ${MAX_RECOMMENDATIONS})`);
  }
  const seen = new Set();
  result.forEach((rec, i) => {
    const where = `recommandation #${i}`;
    if (rec === null || typeof rec !== 'object') {
      problems.push(`${where} : doit être un objet { movieId, score, reason }`);
      return;
    }
    if (!moviesById.has(rec.movieId)) problems.push(`${where} : movieId ${rec.movieId} inexistant`);
    else if (seen.has(rec.movieId)) problems.push(`${where} : movieId ${rec.movieId} en doublon`);
    seen.add(rec.movieId);
    if (typeof rec.score !== 'number' || !Number.isFinite(rec.score)) {
      problems.push(`${where} : score doit être un nombre fini`);
    }
    if (typeof rec.reason !== 'string' || rec.reason.trim() === '') {
      problems.push(`${where} : reason doit être une chaîne non vide`);
    }
  });
  return problems;
}

function getRecommendations(user) {
  let result;
  try {
    // Copies profondes : l'implémentation des élèves ne peut pas corrompre les données du serveur.
    result = recommendMovies(structuredClone(user), structuredClone(movies), structuredClone(users));
  } catch (err) {
    throw new HttpError(500, 'recommendMovies() a levé une erreur', String(err && err.message));
  }
  const problems = validateRecommendations(result);
  if (problems.length > 0) {
    throw new HttpError(500, 'Résultat invalide retourné par recommendMovies()', problems);
  }
  return result.map(({ movieId, score, reason }) => ({
    movieId, score, reason, movie: moviesById.get(movieId),
  }));
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, rawId, action] = parts;
  const method = req.method;

  if (resource === 'movies' && parts.length === 2) {
    if (method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
    return sendJson(res, 200, movies);
  }

  if (resource === 'users' && parts.length === 2) {
    if (method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
    return sendJson(res, 200, users);
  }

  if (resource === 'users' && parts.length === 3) {
    if (method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
    return sendJson(res, 200, findUser(rawId));
  }

  if (resource === 'users' && parts.length === 4 && action === 'ratings') {
    if (method !== 'POST') throw new HttpError(405, 'Méthode non autorisée');
    const user = findUser(rawId);
    const { movieId, score } = await readJsonBody(req);
    requireMovie(movieId);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new HttpError(400, '`score` doit être un entier entre 1 et 5');
    }
    const existing = user.ratings.find((r) => r.movieId === movieId);
    if (existing) existing.score = score;
    else user.ratings.push({ movieId, score });
    markWatched(user, movieId); // noter un film implique de l'avoir vu
    return sendJson(res, 200, user);
  }

  if (resource === 'users' && parts.length === 4 && action === 'watched') {
    if (method !== 'POST') throw new HttpError(405, 'Méthode non autorisée');
    const user = findUser(rawId);
    const { movieId } = await readJsonBody(req);
    requireMovie(movieId);
    markWatched(user, movieId);
    return sendJson(res, 200, user);
  }

  if (resource === 'recommendations' && parts.length === 3) {
    if (method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
    const user = findUser(rawId);
    return sendJson(res, 200, { userId: user.id, recommendations: getRecommendations(user) });
  }

  throw new HttpError(404, 'Route API inconnue');
}

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  const entry = Object.hasOwn(PUBLIC_FILES, pathname) ? PUBLIC_FILES[pathname] : null;
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — Introuvable');
  }
  fs.readFile(path.join(__dirname, entry.file), (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Erreur de lecture du fichier');
    }
    res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, ...(err.details && { details: err.details }) });
    } else {
      console.error(err);
      sendJson(res, 500, { error: 'Erreur interne du serveur' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`CinéMatch démarré : http://localhost:${PORT}`);
  if (USE_CORRECTION) console.log('⚠ Mode formateur : la correction (recommender.solution.js) est active.');
  console.log('Données en mémoire : les modifications sont perdues au redémarrage.');
});
