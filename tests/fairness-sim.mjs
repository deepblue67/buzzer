// Simulation d'équité : latences réseau asymétriques + horloges décalées.
// Compare l'ordre obtenu par l'appli à l'ordre RÉEL des appuis,
// et à l'ordre naïf "premier message arrivé".   node tests/fairness-sim.mjs
import * as G from '../js/game.js';
import { makeSample, estimate } from '../js/clock.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const expo = (mean) => -Math.log(1 - Math.random()) * mean;

// Chaque appareil a une latence de base vers le serveur Supabase (Wi-Fi rapide
// ou 4G lente), une asymétrie montée/descente et de la gigue.
// Trajet joueur→hôte = montée du joueur + descente de l'hôte (et inversement).
function makeNet(scn) {
  const base = rnd(scn.base[0], scn.base[1]);
  const asym = base * rnd(-scn.asym, scn.asym);
  return { up: base + asym, down: base - asym, jitter: rnd(2, scn.jitter) };
}
const lat = (base, j) => base + expo(j);

function run(trials, nPlayers, scn) {
  const H = rnd(-5000, 5000); // horloge de l'hôte
  const host = makeNet(scn);
  let fairFirst = 0, naiveFirst = 0, clear = 0, pairsOk = 0, pairs = 0, naivePairsOk = 0;
  const offErr = [];
  for (let k = 0; k < trials; k++) {
    const players = Array.from({ length: nPlayers }, (_, i) => ({ id: 'p' + i, S: rnd(-30000, 30000), net: makeNet(scn) }));
    // 1) synchro d'horloge : 8 allers-retours
    for (const p of players) {
      const samples = [];
      for (let i = 0; i < 8; i++) {
        const T = i * 130;
        const up = lat(p.net.up + host.down, p.net.jitter), down = lat(host.up + p.net.down, p.net.jitter);
        samples.push(makeSample(T + p.S, T + up + H, T + up + down + p.S));
      }
      const e = estimate(samples);
      p.offset = e.offset;
      p.rtt = e.rtt;
      offErr.push(Math.abs(p.S + p.offset - H)); // erreur = local+offset vs heure hôte
    }
    // 2) une question : ouverture à T0, appuis humains
    const T0 = 100000;
    let s = G.newGame('SIM', 0);
    for (const p of players) s = G.upsertPlayer(s, { id: p.id, name: p.id }, 0);
    s = G.nextQuestion(s, T0 + H);
    const events = players.map((p) => {
      const press = T0 + rnd(250, 900); // réflexes serrés : tout le monde dans ~0,65 s
      const arrive = press + lat(p.net.up + host.down, p.net.jitter);
      return { p, press, arrive, t: press + p.S + p.offset };
    });
    const grace = G.graceMsFor(players.map((p) => p.rtt));
    const byArrival = [...events].sort((a, b) => a.arrive - b.arrive);
    // traitement chez l'hôte dans l'ordre d'arrivée, avec gel de la tête à la fin de la grâce
    for (const ev of byArrival) {
      if (s.q.graceUntil != null && ev.arrive + H >= s.q.graceUntil) s = G.freeze(s, s.q.graceUntil);
      s = G.applyBuzz(s, { id: ev.p.id, t: ev.t, rtt: ev.p.rtt, qn: 1 }, ev.arrive + H, { graceMs: grace }).state;
    }
    const got = s.q.queue.map((e) => e.id);
    const truth = [...events].sort((a, b) => a.press - b.press);
    if (truth[1].press - truth[0].press >= 30) {
      clear++;
      if (got[0] === truth[0].p.id) fairFirst++;
      if (byArrival[0].p.id === truth[0].p.id) naiveFirst++;
    }
    // paires séparées de plus de 40 ms : sont-elles dans le bon ordre ?
    const pos = Object.fromEntries(got.map((id, i) => [id, i]));
    const npos = Object.fromEntries(byArrival.map((e, i) => [e.p.id, i]));
    for (let i = 0; i < truth.length; i++)
      for (let j = i + 1; j < truth.length; j++) {
        if (truth[j].press - truth[i].press < 40) continue;
        pairs++;
        if (pos[truth[i].p.id] < pos[truth[j].p.id]) pairsOk++;
        if (npos[truth[i].p.id] < npos[truth[j].p.id]) naivePairsOk++;
      }
  }
  offErr.sort((a, b) => a - b);
  const pct = (x, n) => ((100 * x) / n).toFixed(1) + ' %';
  return {
    'Bon gagnant si écart ≥ 30 ms (appli)': pct(fairFirst, clear),
    'Bon gagnant si écart ≥ 30 ms (naïf)': pct(naiveFirst, clear),
    'Paires >40 ms bien ordonnées (appli)': pct(pairsOk, pairs),
    'Paires >40 ms bien ordonnées (naïf)': pct(naivePairsOk, pairs),
    'Erreur d’horloge médiane': offErr[Math.floor(offErr.length / 2)].toFixed(1) + ' ms',
    'Erreur d’horloge 95e centile': offErr[Math.floor(offErr.length * 0.95)].toFixed(1) + ' ms',
  };
}

const SCENARIOS = [
  { name: 'Soirée réaliste : Wi-Fi et 4G mélangés (10–150 ms), asymétrie ±20 %', base: [10, 150], asym: 0.2, jitter: 25, check: true },
  { name: 'Cas extrême : réseau très asymétrique (±60 %) et lent (jusqu’à 300 ms)', base: [20, 300], asym: 0.6, jitter: 60 },
];
let ok = true;
for (const scn of SCENARIOS) {
  const res = run(3000, 8, scn);
  console.log(`\n▶ ${scn.name}\n  8 joueurs, horloges décalées de ±30 s, 3000 questions`);
  for (const [k, v] of Object.entries(res)) console.log('  ' + k.padEnd(40), v);
  if (scn.check) ok = parseFloat(res['Paires >40 ms bien ordonnées (appli)']) >= 99 && parseFloat(res['Bon gagnant si écart ≥ 30 ms (appli)']) >= 98;
}
console.log(ok ? '\n✅ Ordre équitable dans le scénario réaliste' : '\n❌ Ordre insuffisamment fiable');
process.exit(ok ? 0 : 1);
