'use strict';

/**
 * ============================================================
 *  recommender.solution.js — SOLUTION DE RÉFÉRENCE (formateur)
 * ============================================================
 * Ce fichier ne doit JAMAIS être distribué aux élèves (voir TRAINER.md).
 * Même interface que recommender.js : recommendMovies(user, movies, users).
 *
 * Moteur hybride, déterministe et explicable. Tous les sous-scores sont
 * ramenés sur [0, 1] avant d'être pondérés ; le score final est sur [0, 100].
 *
 *   contenu  (0.40) : mélange de
 *       - genres déclarés  (0.4) : part des genres du film qui sont des genres favoris
 *       - genres déduits   (0.6) : affinités calculées à partir des notes de l'utilisateur
 *   collaboratif (0.35) : notes des utilisateurs similaires (voir calculateSimilarity)
 *   note moyenne (0.15) : (rating - 1) / 4
 *   popularité   (0.10) : popularity / 100
 *
 * Un signal absent (null) est retiré de la formule et les poids restants sont
 * renormalisés : pas de NaN, et un utilisateur sans historique reçoit un
 * classement basé sur note moyenne + popularité (60 % / 40 %).
 */

const MAX_RECOMMENDATIONS = 5;

const WEIGHTS = { content: 0.40, collaborative: 0.35, rating: 0.15, popularity: 0.10 };
const CONTENT_MIX = { declared: 0.4, inferred: 0.6 };

const LIKE_THRESHOLD = 4;     // note >= 4 : film « apprécié »
const NEUTRAL_SCORE = 3;      // note neutre pour les affinités par genre
const AFFINITY_PRIOR = 1;     // lissage : un seul film noté ne donne pas une certitude
const MIN_COMMON_RATINGS = 3; // en dessous, la similarité est atténuée proportionnellement
const COLLAB_SHRINK = 0.3;    // lissage du signal collaboratif vers le neutre (0.5)
const REASON_THRESHOLD = 0.6; // un critère n'est cité que s'il est réellement favorable

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const toArray = (x) => (Array.isArray(x) ? x : []);

/** Notes valides d'un utilisateur sous forme de Map movieId -> score (dernière note retenue). */
function ratingMap(user) {
  const map = new Map();
  for (const r of toArray(user && user.ratings)) {
    if (r && Number.isFinite(r.movieId) && Number.isFinite(r.score)) map.set(r.movieId, r.score);
  }
  return map;
}

/** Ensemble des films « appréciés » (note >= LIKE_THRESHOLD). */
function likedSet(ratings) {
  const liked = new Set();
  for (const [movieId, score] of ratings) if (score >= LIKE_THRESHOLD) liked.add(movieId);
  return liked;
}

/**
 * Similarité entre deux utilisateurs, dans [0, 1].
 *
 * Indice de Jaccard sur les ensembles de films appréciés (note >= 4) :
 *     J = |A ∩ B| / |A ∪ B|
 * puis atténuation par la confiance :
 *     confiance = min(1, nbFilmsNotésEnCommun / MIN_COMMON_RATINGS)
 * Deux profils qui ont très peu de films notés en commun ne sont donc pas
 * jugés proches sur un hasard. Un utilisateur n'est jamais similaire à lui-même
 * (0), ce qui évite qu'il « se recommande » ses propres goûts.
 */
function calculateSimilarity(userA, userB) {
  if (!userA || !userB || userA === userB || userA.id === userB.id) return 0;
  return similarityFromMaps(ratingMap(userA), ratingMap(userB));
}

function similarityFromMaps(ratingsA, ratingsB) {
  const likedA = likedSet(ratingsA);
  const likedB = likedSet(ratingsB);
  let common = 0;
  for (const id of ratingsA.keys()) if (ratingsB.has(id)) common++;
  let inter = 0;
  for (const id of likedA) if (likedB.has(id)) inter++;
  const union = likedA.size + likedB.size - inter;
  if (union === 0 || inter === 0) return 0;
  return (inter / union) * Math.min(1, common / MIN_COMMON_RATINGS);
}

/**
 * Genres déclarés : part des genres du film présents dans favoriteGenres.
 * 1 = tous les genres du film sont favoris, 0 = aucun. null si rien n'est déclaré.
 */
function declaredGenreScore(movie, favorites) {
  if (favorites.size === 0 || movie.genres.length === 0) return null;
  let hits = 0;
  for (const g of movie.genres) if (favorites.has(g)) hits++;
  return hits / movie.genres.length;
}

/**
 * Affinités par genre déduites des notes, dans [-1, 1].
 * Pour chaque film noté, écart à la note neutre : d = (note - 3) / 2.
 * Un film à n genres répartit son effet : chaque genre reçoit un poids 1/n
 * (un film aimé n'est donc pas une préférence certaine pour chacun de ses genres).
 *     affinité(g) = Σ d·poids / (Σ poids + AFFINITY_PRIOR)
 * Le lissage ramène vers 0 les genres vus rarement. null si aucune note exploitable.
 */
function inferGenreAffinities(ratings, moviesById) {
  const sums = new Map();
  const weights = new Map();
  let used = 0;
  for (const [movieId, score] of ratings) {
    const movie = moviesById.get(movieId);
    if (!movie || movie.genres.length === 0) continue;
    used++;
    const d = (score - NEUTRAL_SCORE) / 2;
    const w = 1 / movie.genres.length;
    for (const g of movie.genres) {
      sums.set(g, (sums.get(g) || 0) + d * w);
      weights.set(g, (weights.get(g) || 0) + w);
    }
  }
  if (used === 0) return null;
  const affinities = new Map();
  for (const [g, s] of sums) affinities.set(g, s / (weights.get(g) + AFFINITY_PRIOR));
  return affinities;
}

/** Score d'un film selon les affinités déduites, dans [0, 1] (0.5 = neutre). */
function inferredGenreScore(movie, affinities) {
  if (!affinities || movie.genres.length === 0) return null;
  let total = 0;
  for (const g of movie.genres) total += affinities.get(g) || 0;
  return (total / movie.genres.length + 1) / 2;
}

/**
 * Signal collaboratif : une Map movieId -> { value, contributors }.
 *     r_v = (note_v - 1) / 4                              note normalisée dans [0, 1]
 *     valeur = 0.5 + Σ sim_v·(r_v - 0.5) / (Σ sim_v + COLLAB_SHRINK)
 * Moyenne pondérée par la similarité, ramenée vers le neutre (0.5) quand la
 * somme des similarités est faible. Chaque voisin compte une seule fois par film.
 */
function collaborativeSignals(user, users) {
  const myRatings = ratingMap(user);
  const acc = new Map();
  const seenUsers = new Set();
  for (const other of users) {
    if (!other || other.id === user.id || seenUsers.has(other.id)) continue;
    seenUsers.add(other.id);
    const theirRatings = ratingMap(other);
    const sim = similarityFromMaps(myRatings, theirRatings);
    if (sim <= 0) continue;
    for (const [movieId, score] of theirRatings) {
      const entry = acc.get(movieId) || { simSum: 0, weighted: 0, contributors: 0 };
      entry.simSum += sim;
      entry.weighted += sim * ((score - 1) / 4 - 0.5);
      entry.contributors++;
      acc.set(movieId, entry);
    }
  }
  const signals = new Map();
  for (const [movieId, e] of acc) {
    signals.set(movieId, { value: clamp01(0.5 + e.weighted / (e.simSum + COLLAB_SHRINK)), contributors: e.contributors });
  }
  return signals;
}

/** Combine content / collaboratif / note / popularité en renormalisant les poids disponibles. */
function hybridScore(signals) {
  const content = combineContent(signals.declared, signals.inferred);
  const parts = [
    { key: 'content', value: content },
    { key: 'collaborative', value: signals.collaborative },
    { key: 'rating', value: signals.rating },
    { key: 'popularity', value: signals.popularity },
  ].filter((p) => p.value !== null && p.value !== undefined && Number.isFinite(p.value));
  const totalWeight = parts.reduce((s, p) => s + WEIGHTS[p.key], 0);
  if (totalWeight === 0) return { score: 0, contributions: {} };
  const contributions = {};
  let score = 0;
  for (const p of parts) {
    contributions[p.key] = (WEIGHTS[p.key] / totalWeight) * p.value;
    score += contributions[p.key];
  }
  return { score: score * 100, contributions };
}

function combineContent(declared, inferred) {
  const parts = [];
  if (declared !== null) parts.push([CONTENT_MIX.declared, declared]);
  if (inferred !== null) parts.push([CONTENT_MIX.inferred, inferred]);
  if (parts.length === 0) return null;
  const total = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + (w / total) * v, 0);
}

/** Cite au plus deux critères favorables ayant réellement pesé dans le score. */
function buildReason(signals, contributions) {
  const candidates = [];
  if (signals.declared !== null && signals.declared > 0) {
    candidates.push({ text: 'Correspond à vos genres favoris', weight: contributions.content || 0 });
  }
  if (signals.inferred !== null && signals.inferred >= REASON_THRESHOLD) {
    candidates.push({ text: 'Proche des films que vous avez bien notés', weight: contributions.content || 0 });
  }
  if (signals.collaborative !== null && signals.collaborative >= REASON_THRESHOLD) {
    candidates.push({ text: 'Apprécié par des utilisateurs aux goûts similaires', weight: contributions.collaborative || 0 });
  }
  if (signals.rating >= 0.7) candidates.push({ text: 'Film très bien noté', weight: contributions.rating || 0 });
  if (signals.popularity >= 0.7) candidates.push({ text: 'Film populaire', weight: contributions.popularity || 0 });
  if (candidates.length === 0) return 'Suggestion du catalogue';
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates.slice(0, 2).map((c) => c.text).join(' · ');
}

function recommendMovies(user, movies, users) {
  if (!user || typeof user !== 'object') {
    throw new TypeError('recommendMovies : `user` doit être un objet');
  }
  if (!Array.isArray(movies)) {
    throw new TypeError('recommendMovies : `movies` doit être un tableau');
  }
  if (!Array.isArray(users)) {
    throw new TypeError('recommendMovies : `users` doit être un tableau');
  }

  // Index du catalogue (un seul parcours) ; identifiants dupliqués ou invalides ignorés.
  const moviesById = new Map();
  for (const m of movies) {
    if (m && Number.isFinite(m.id) && !moviesById.has(m.id)) {
      moviesById.set(m.id, { ...m, genres: toArray(m.genres) });
    }
  }

  // A. Films à exclure : visionnés, et notés (noter implique avoir vu).
  const ratings = ratingMap(user);
  const watched = new Set(toArray(user.watchedMovieIds));
  for (const id of ratings.keys()) watched.add(id);

  const favorites = new Set(toArray(user.favoriteGenres));
  const affinities = inferGenreAffinities(ratings, moviesById);
  const collaborative = collaborativeSignals(user, users);

  const scored = [];
  for (const movie of moviesById.values()) {
    if (watched.has(movie.id)) continue;
    const collab = collaborative.get(movie.id);
    const signals = {
      declared: declaredGenreScore(movie, favorites),
      inferred: inferredGenreScore(movie, affinities),
      collaborative: collab ? collab.value : null,
      rating: Number.isFinite(movie.rating) ? clamp01((movie.rating - 1) / 4) : null,
      popularity: Number.isFinite(movie.popularity) ? clamp01(movie.popularity / 100) : null,
    };
    const { score, contributions } = hybridScore(signals);
    scored.push({ movieId: movie.id, score, reason: buildReason(signals, contributions) });
  }

  // H. Tri : score décroissant, puis identifiant croissant (départage déterministe).
  scored.sort((a, b) => b.score - a.score || a.movieId - b.movieId);

  return scored.slice(0, MAX_RECOMMENDATIONS).map((r) => ({ ...r, score: Math.round(r.score * 100) / 100 }));
}

module.exports = { recommendMovies, calculateSimilarity };
