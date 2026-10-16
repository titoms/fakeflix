'use strict';

// Tests de la solution de référence (FORMATEUR UNIQUEMENT — ne pas distribuer aux élèves).
// 1. contrat (partagé avec les élèves)  2. qualité de la correction  3. benchmark.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const { recommendMovies, calculateSimilarity } = require('../recommender.solution');
const { defineContractTests } = require('./contract');
const movies = require('../data/movies.json');
const users = require('../data/users.json');

const clone = (x) => structuredClone(x);

// ============================================================
//  1. Contrat
// ============================================================
defineContractTests('Contrat de recommendMovies() — solution', recommendMovies);

// ============================================================
//  2. Qualité — petites fixtures, un seul critère modifié à la fois
// ============================================================
const film = (id, genres, rating = 3, popularity = 50) => ({ id, title: `F${id}`, genres, year: 2000, rating, popularity });
const person = (id, { fav = [], ratings = [], watched } = {}) => ({
  id, name: `U${id}`, favoriteGenres: fav,
  ratings: ratings.map(([movieId, score]) => ({ movieId, score })),
  watchedMovieIds: watched || ratings.map(([movieId]) => movieId),
});
const ids = (recs) => recs.map((r) => r.movieId);
const rank = (recs, id) => ids(recs).indexOf(id);

describe('Qualité de la solution', () => {
  test('aucun film déjà visionné ou noté n’est recommandé (jeu complet)', () => {
    for (const u of users) {
      const seen = new Set([...u.watchedMovieIds, ...u.ratings.map((r) => r.movieId)]);
      for (const r of recommendMovies(clone(u), clone(movies), clone(users))) {
        assert.ok(!seen.has(r.movieId), `${u.name} a déjà vu ${r.movieId}`);
      }
    }
  });

  test('deux profils aux goûts différents obtiennent des classements différents', () => {
    const catalog = [film(1, ['SF']), film(2, ['SF']), film(3, ['Romance']), film(4, ['Romance'])];
    const a = person(10, { fav: ['SF'] });
    const b = person(11, { fav: ['Romance'] });
    const ra = ids(recommendMovies(a, catalog, [a, b]));
    const rb = ids(recommendMovies(b, catalog, [a, b]));
    assert.notDeepStrictEqual(ra, rb);
    assert.ok([1, 2].includes(ra[0]));
    assert.ok([3, 4].includes(rb[0]));
  });

  test('jeu complet : Alice (SF) et Hugo reçoivent des recommandations différentes', () => {
    const get = (name) => users.find((u) => u.name === name);
    const a = ids(recommendMovies(clone(get('Alice')), clone(movies), clone(users))).sort();
    const h = ids(recommendMovies(clone(get('Hugo')), clone(movies), clone(users))).sort();
    assert.notDeepStrictEqual(a, h);
  });

  test('un genre favori favorise le film, toutes choses égales par ailleurs', () => {
    // Le film 1 (id plus petit) gagnerait le départage : le film 2 doit passer devant grâce au genre.
    const catalog = [film(1, ['Drame']), film(2, ['Comédie'])];
    const u = person(10, { fav: ['Comédie'] });
    assert.strictEqual(recommendMovies(u, catalog, [u])[0].movieId, 2);
    const noFav = person(10);
    assert.strictEqual(recommendMovies(noFav, catalog, [noFav])[0].movieId, 1);
  });

  test('modifier les notes de l’utilisateur change les résultats', () => {
    const catalog = [film(1, ['Horreur']), film(2, ['Drame']), film(3, ['Horreur']), film(4, ['Drame'])];
    const top = (score) => {
      const u = person(10, { ratings: [[1, score]] }); // le film 1 (Horreur) est vu
      return recommendMovies(u, catalog, [u])[0].movieId;
    };
    assert.strictEqual(top(5), 3); // Horreur aimée -> film 3
    assert.strictEqual(top(1), 2); // Horreur détestée -> film Drame
  });

  test('modifier la note moyenne d’un film change son classement', () => {
    const base = (r2) => [film(1, ['X'], 3), film(2, ['X'], r2)];
    const u = person(10);
    assert.strictEqual(recommendMovies(u, base(3), [u])[0].movieId, 1); // égalité -> id
    assert.strictEqual(recommendMovies(u, base(4.5), [u])[0].movieId, 2);
    assert.strictEqual(recommendMovies(u, base(1.5), [u])[0].movieId, 1);
  });

  test('la popularité sert de critère secondaire', () => {
    const u = person(10);
    const catalog = [film(1, ['X'], 3, 10), film(2, ['X'], 3, 90)];
    assert.strictEqual(recommendMovies(u, catalog, [u])[0].movieId, 2);
  });

  test('modifier les notes d’un utilisateur similaire change les recommandations collaboratives', () => {
    const catalog = [film(1, ['X']), film(2, ['X']), film(3, ['X']), film(4, ['Y']), film(5, ['Y'])];
    const me = person(10, { ratings: [[1, 5], [2, 5], [3, 5]] });
    const neighbor = (s4, s5) => person(11, { ratings: [[1, 5], [2, 5], [3, 5], [4, s4], [5, s5]] });
    const top = (n) => ids(recommendMovies(me, catalog, [me, n]))[0];
    assert.strictEqual(top(neighbor(5, 1)), 4);
    assert.strictEqual(top(neighbor(1, 5)), 5);
  });

  test('la raison collaborative n’apparaît que si un signal collaboratif existe', () => {
    const catalog = [film(1, ['X']), film(2, ['X']), film(3, ['X']), film(4, ['Y'], 3, 50)];
    const me = person(10, { ratings: [[1, 5], [2, 5], [3, 5]] });
    const twin = person(11, { ratings: [[1, 5], [2, 5], [3, 5], [4, 5]] });
    const withNeighbor = recommendMovies(me, catalog, [me, twin]);
    assert.match(withNeighbor[0].reason, /similaires/);
    const alone = recommendMovies(me, catalog, [me]);
    assert.ok(alone.every((r) => !/similaires/.test(r.reason)));
    // un utilisateur sans aucun film en commun n'est pas un voisin
    const stranger = person(12, { ratings: [[4, 5], [5, 5]] });
    const noOverlap = recommendMovies(me, [...catalog, film(5, ['Z'])], [me, stranger]);
    assert.ok(noOverlap.every((r) => !/similaires/.test(r.reason)));
  });

  test('calculateSimilarity : 0 avec soi-même, symétrique, atténuée si peu de films en commun', () => {
    const a = person(1, { ratings: [[1, 5], [2, 5], [3, 5], [4, 5]] });
    const b = person(2, { ratings: [[1, 5], [2, 5], [3, 5], [4, 5]] });
    const c = person(3, { ratings: [[1, 5], [9, 5], [8, 5], [7, 5]] }); // 1 seul film en commun
    assert.strictEqual(calculateSimilarity(a, a), 0);
    assert.strictEqual(calculateSimilarity(a, { ...a }), 0);
    assert.strictEqual(calculateSimilarity(a, b), calculateSimilarity(b, a));
    assert.strictEqual(calculateSimilarity(a, b), 1);
    assert.ok(calculateSimilarity(a, c) < calculateSimilarity(a, b) / 3);
    assert.strictEqual(calculateSimilarity(a, person(4)), 0);
  });

  test('utilisateur sans historique : résultat cohérent (note + popularité, jamais de NaN)', () => {
    const cold = users.find((u) => u.watchedMovieIds.length === 0);
    const recs = recommendMovies(clone(cold), clone(movies), clone(users));
    assert.strictEqual(recs.length, 5);
    for (const r of recs) {
      assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 100);
      assert.ok(!/similaires|bien notés|favoris/.test(r.reason), r.reason);
    }
  });

  test('profil sans voisin pertinent : recommandations valides basées sur le contenu', () => {
    const loner = person(99, { fav: ['Drame'], ratings: [[1, 5]] });
    const recs = recommendMovies(loner, clone(movies), [loner, ...clone(users)].map((u, i) => (i ? { ...u, ratings: [] } : u)));
    assert.strictEqual(recs.length, 5);
    assert.ok(recs.every((r) => Number.isFinite(r.score) && !/similaires/.test(r.reason)));
  });

  test('données dégradées : champs manquants, doublons de catalogue et de notes', () => {
    const catalog = [film(1, ['X']), film(1, ['Y']), { id: 2 }, film(3, ['X'], undefined, undefined)];
    const odd = { id: 10, name: 'Odd', ratings: [{ movieId: 3, score: 5 }, { movieId: 3, score: 4 }] };
    const recs = recommendMovies(odd, catalog, [odd, null, odd]);
    assert.ok(recs.every((r) => Number.isFinite(r.score) && r.reason));
    assert.strictEqual(new Set(ids(recs)).size, recs.length);
  });

  test('résultats déterministes et départage par identifiant', () => {
    const u = users[0];
    const first = recommendMovies(clone(u), clone(movies), clone(users));
    assert.deepStrictEqual(recommendMovies(clone(u), clone(movies), clone(users)), first);
    const twins = [film(7, ['X']), film(3, ['X']), film(5, ['X'])];
    const p = person(10);
    assert.deepStrictEqual(ids(recommendMovies(p, twins, [p])), [3, 5, 7]);
  });

  test('chaque raison correspond à un critère réel (jeu complet)', () => {
    for (const u of users) {
      for (const r of recommendMovies(clone(u), clone(movies), clone(users))) {
        if (/genres favoris/.test(r.reason)) {
          const m = movies.find((x) => x.id === r.movieId);
          assert.ok(m.genres.some((g) => u.favoriteGenres.includes(g)), `${u.name}/${r.movieId}`);
        }
      }
    }
  });
});

// ============================================================
//  3. Benchmark simple (performance.now)
// ============================================================
describe('Benchmark', () => {
  test('5000 films et 200 utilisateurs en moins de 500 ms', () => {
    const bigMovies = Array.from({ length: 5000 }, (_, i) => ({ ...movies[i % movies.length], id: i + 1 }));
    const bigUsers = Array.from({ length: 200 }, (_, i) => {
      const base = users[i % 11]; // 11 profils avec historique
      return { ...clone(base), id: i + 1, ratings: base.ratings.map((r) => ({ ...r })) };
    });
    const start = performance.now();
    const recs = recommendMovies(clone(bigUsers[0]), bigMovies, bigUsers);
    const elapsed = performance.now() - start;
    console.log(`  benchmark : ${bigMovies.length} films, ${bigUsers.length} utilisateurs -> ${elapsed.toFixed(1)} ms`);
    assert.strictEqual(recs.length, 5);
    assert.ok(elapsed < 500, `trop lent : ${elapsed.toFixed(1)} ms`);
  });
});
