// Tests des règles : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/game.js';

function setup(n = 3, settings = {}) {
  let s = G.newGame('TEST', 0, settings);
  for (let i = 1; i <= n; i++) s = G.upsertPlayer(s, { id: 'p' + i, name: 'P' + i }, i);
  return s;
}

test('file triée par heure d’appui, pas par heure d’arrivée', () => {
  let s = G.nextQuestion(setup(), 1000); // ouverture immédiate à t=1000
  // p2 appuie à 1300 mais son message arrive après celui de p1 (appui 1350)
  let r = G.applyBuzz(s, { id: 'p1', t: 1350, rtt: 40, qn: 1 }, 1380, { graceMs: 300 });
  assert.ok(r.ok && r.startGrace);
  s = r.state;
  r = G.applyBuzz(s, { id: 'p2', t: 1300, rtt: 300, qn: 1 }, 1500, { graceMs: 300 });
  s = r.state;
  assert.deepEqual(s.q.queue.map((e) => e.id), ['p2', 'p1']);
  assert.equal(s.q.queue[0].rt, 300);
  assert.equal(G.isHeadFrozen(s.q), false);
  s = G.freeze(s, 1680);
  assert.equal(G.isHeadFrozen(s.q), true);
  // Un buzz encore plus tôt arrivant après le gel ne peut plus doubler le premier
  r = G.applyBuzz(s, { id: 'p3', t: 1290, rtt: 900, qn: 1 }, 1700, { graceMs: 300 });
  assert.deepEqual(r.state.q.queue.map((e) => e.id), ['p2', 'p3', 'p1']);
});

test('mauvaise réponse : joueur bloqué, on passe au suivant ; bonne réponse : +1', () => {
  let s = G.nextQuestion(setup(), 0);
  s = G.applyBuzz(s, { id: 'p1', t: 100, rtt: 50, qn: 1 }, 130).state;
  s = G.applyBuzz(s, { id: 'p2', t: 200, rtt: 50, qn: 1 }, 230).state;
  s = G.freeze(s, 1000);
  s = G.judge(s, false, 1100);
  assert.deepEqual(s.q.locked, ['p1']);
  assert.equal(G.isHeadFrozen(s.q), true, 'le suivant est jugeable tout de suite');
  assert.equal(s.q.queue[G.headIndex(s.q)].id, 'p2');
  // p1 ne peut plus buzzer
  assert.equal(G.applyBuzz(s, { id: 'p1', t: 1200, rtt: 50, qn: 1 }, 1230).ok, false);
  s = G.judge(s, true, 1300);
  assert.equal(s.players.p2.score, 1);
  assert.equal(s.players.p1.score, 0);
  assert.equal(s.q.phase, 'resolved');
  assert.equal(s.q.winner, 'p2');
  // buzz refusé quand la question est close
  assert.equal(G.applyBuzz(s, { id: 'p3', t: 1400, rtt: 50, qn: 1 }, 1430).ok, false);
  // question suivante : tout le monde peut rebuzzer
  s = G.nextQuestion(s, 2000);
  assert.equal(G.applyBuzz(s, { id: 'p1', t: 2100, rtt: 50, qn: 2 }, 2130).ok, true);
});

test('malus optionnel', () => {
  let s = G.nextQuestion(setup(2, { malus: true }), 0);
  s = G.freeze(G.applyBuzz(s, { id: 'p1', t: 100, rtt: 50, qn: 1 }, 130).state, 1000);
  s = G.judge(s, false, 1100);
  assert.equal(s.players.p1.score, -1);
});

test('file vidée par les erreurs : un nouveau buzz relance une fenêtre de grâce', () => {
  let s = G.nextQuestion(setup(), 0);
  s = G.freeze(G.applyBuzz(s, { id: 'p1', t: 100, rtt: 50, qn: 1 }, 130).state, 1000);
  s = G.judge(s, false, 1100);
  assert.equal(G.headIndex(s.q), -1);
  const r = G.applyBuzz(s, { id: 'p2', t: 3000, rtt: 50, qn: 1 }, 3030);
  assert.ok(r.startGrace);
  assert.equal(G.isHeadFrozen(r.state.q), false);
});

test('garde-fou : impossible d’annoncer un appui très antérieur à l’arrivée', () => {
  let s = G.nextQuestion(setup(), 0);
  const r = G.applyBuzz(s, { id: 'p1', t: 5, rtt: 50, qn: 1 }, 5000);
  assert.equal(r.entry.t, 5000 - 450);
});

test('doublons, question périmée, mode manuel et compte à rebours', () => {
  let s = setup(2, { openMode: 'countdown' });
  s = G.nextQuestion(s, 0);
  assert.equal(s.q.phase, 'ready');
  assert.equal(G.applyBuzz(s, { id: 'p1', t: 10, rtt: 50, qn: 1 }, 20).ok, false);
  s = G.top(s, 100);
  assert.equal(s.q.phase, 'countdown');
  assert.equal(G.openIfDue(s, 2000).q.phase, 'countdown');
  s = G.openIfDue(s, 3100);
  assert.equal(s.q.phase, 'open');
  assert.equal(s.q.openedAt, 3100);
  s = G.applyBuzz(s, { id: 'p1', t: 3500, rtt: 50, qn: 1 }, 3530).state;
  assert.equal(G.applyBuzz(s, { id: 'p1', t: 3600, rtt: 50, qn: 1 }, 3630).reason, 'dup');
  assert.equal(G.applyBuzz(s, { id: 'p2', t: 3600, rtt: 50, qn: 0 }, 3630).reason, 'stale');
});

test('exclusion, retour, classement ex aequo et trophées', () => {
  let s = setup(3);
  s = G.kick(s, 'p3');
  assert.equal(s.players.p3, undefined);
  assert.equal(G.upsertPlayer(s, { id: 'p3', name: 'P3' }, 10), null);
  s = G.upsertPlayer(s, { id: 'p3', name: 'P3' }, 10, { rejoin: true });
  assert.ok(s.players.p3);
  s = G.adjustScore(G.adjustScore(s, 'p1', 2), 'p2', 2);
  const rk = G.ranking(s);
  assert.equal(rk[0].rank, 1);
  assert.equal(rk[1].rank, 1);
  assert.equal(rk[2].rank, 3);
  assert.ok(G.awards(s).some((a) => a.icon === '🏆'));
});

test('l’état d’origine n’est jamais modifié', () => {
  const s = G.nextQuestion(setup(), 0);
  const copy = JSON.stringify(s);
  G.applyBuzz(s, { id: 'p1', t: 100, rtt: 50, qn: 1 }, 130);
  assert.equal(JSON.stringify(s), copy);
});
