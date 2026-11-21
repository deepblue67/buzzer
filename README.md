# 🔔 BUZZ! — le buzzer de soirée

Chaque téléphone devient un buzzer. Le maître du jeu pose ses questions, les joueurs buzzent, et c’est **vraiment le plus rapide qui gagne**, quelle que soit la qualité de son réseau.

- **Maître du jeu** (`host.html`) : sur le téléphone de l’animateur. Il crée la salle, affiche le QR code et valide les réponses dans l’ordre d’arrivée : ✅ bonne réponse = +1 point, ❌ mauvaise réponse = on passe au joueur suivant.
- **Joueur** (`play.html`) : un énorme buzzer, la file d’arrivée en direct et le classement.
- **Écran TV** (`tv.html`, optionnel) : le QR code, le premier qui a buzzé en très grand, la file, le classement et le podium.

Il n’y a rien à installer : c’est une appli web statique, et Supabase Realtime transporte les messages en temps réel.

---

## 🚀 Mise en ligne

### 1. Supabase

> ✅ **Déjà fait** : `js/config.js` utilise le même projet Supabase que *Undercover famille*. Les étapes ci-dessous ne servent que si tu veux un projet séparé.

1. Sur <https://supabase.com>, crée un projet gratuit. Choisis la région **West EU (Paris)** pour avoir la latence la plus faible.
2. Va dans **Project Settings → API** (ou utilise le bouton **Connect**) et copie :
   - la **Project URL** (`https://xxxx.supabase.co`) ;
   - la clé publique **anon** ou **publishable** (`eyJ…` ou `sb_publishable_…`).
3. Colle ces deux valeurs dans `js/config.js`.
4. Dans **Realtime → Settings**, vérifie que l’option **« Allow public access »** est activée. Elle l’est par défaut ; l’appli utilise des canaux publics.

👉 **Aucune table ni aucun script SQL n’est nécessaire.** L’appli n’utilise que les canaux *Broadcast* et *Presence* de Supabase Realtime. La clé « anon/publishable » est faite pour être publique. Ne mets jamais la clé `service_role` / `secret` dans le code.

### 2. GitHub Pages

1. Pousse le contenu de ce dossier à la racine du dépôt.
2. Va dans **Settings → Pages → Build and deployment**, puis choisis **Deploy from a branch**, la branche `main` et le dossier `/ (root)`.
3. Domaine personnalisé : le fichier `CNAME` contient `buzzer.cdesmottes.fr`. Chez ton registrar DNS, crée un enregistrement **CNAME** `buzzer` → `<ton-pseudo-github>.github.io`, puis coche **Enforce HTTPS** dans GitHub Pages.
   Si tu préfères l’adresse `https://<pseudo>.github.io/<depot>/`, supprime simplement le fichier `CNAME`. Tous les liens de l’appli sont relatifs.

> Le **HTTPS** est indispensable : sans lui, pas de maintien de l’écran allumé ni de son fiable sur mobile. GitHub Pages le fournit.

---

## 🎮 Jouer

1. Le maître du jeu ouvre le site, puis **Créer une partie**. Un code de 4 lettres et un QR code s’affichent.
2. *(Optionnel)* Sur la TV ou un PC, ouvre **📺 Écran TV**, tape le code, puis clique sur **Lancer l’écran**. Ce clic active le son.
3. Les joueurs scannent le QR code, puis choisissent un prénom, un avatar, une couleur et un son de buzzer.
4. **▶ Première question**. Le maître du jeu lit sa question, les joueurs buzzent.
5. Le premier de la file est « au micro » : ✅ **Bonne** (+1 point, question close) ou ❌ **Fausse** (le joueur est bloqué pour cette question, au suivant !).
6. **▶ Question suivante**, et ainsi de suite. **🏁 Fin de partie** affiche le podium et les trophées sur tous les écrans.

**Réglages ⚙️** (chez le maître du jeu) :

- **Ouverture des buzzers** : trois modes au choix. Ouverture immédiate dès « Question suivante », ouverture quand tu appuies sur « TOP ! » (pratique pour lire la question tranquillement), ou « TOP ! » suivi d’un compte à rebours 3-2-1.
- **−1 point pour une mauvaise réponse** : désactivé par défaut.
- **Faux départ** : un buzz pendant « écoutez la question » ou pendant le compte à rebours bloque le buzzer 1 s 🐢.
- **Écran TV** : lien à ouvrir sur la télé.
- **Scores à zéro** (les joueurs restent inscrits) et **Nouvelle salle**.

**Autres commandes** :

- **↩️ Annuler** : annule la dernière action (validation, point, exclusion…).
- Dans le classement, les boutons **− / +** corrigent un score et **✕** exclut un joueur.
- Raccourcis clavier si tu animes depuis un PC : `Entrée` = question suivante ou TOP, `B` = bonne, `M` = mauvaise, `U` = annuler.

**Solidité** :

- Un joueur qui recharge sa page ou dont le téléphone se met en veille retrouve sa place et ses points.
- Si le maître du jeu recharge sa page, la partie est restaurée depuis la mémoire de son navigateur.
- Le maître du jeu doit garder son téléphone allumé : c’est lui l’arbitre. L’appli empêche la mise en veille quand le navigateur le permet.

---

## ⚖️ Comment l’ordre reste équitable

Si on classait les buzz selon l’ordre d’arrivée des messages, le joueur avec le meilleur réseau gagnerait. L’appli s’y prend donc en trois temps :

1. **Synchronisation des horloges.** Le téléphone du maître du jeu sert d’horloge de référence. Chaque joueur fait 8 allers-retours rapides en arrivant, puis 3 toutes les 20 s et au retour de veille. Le décalage d’horloge est calculé à partir des allers-retours les plus rapides, qui sont les plus fiables.
2. **Horodatage de l’appui.** L’heure est prise dès que le doigt touche l’écran, à partir de l’horodatage précis de l’événement tactile, puis convertie à l’heure du maître du jeu. La file est triée sur cette heure, et pas sur l’heure d’arrivée du message.
3. **Fenêtre de grâce.** Après le premier buzz reçu, on attend 0,3 à 0,8 s, selon la latence mesurée des joueurs, avant de figer la 1re place. Un buzz plus ancien mais arrivé plus tard prend donc sa vraie place. Une fois le premier figé, personne ne peut plus le doubler.

**Garde-fou anti-triche** : l’heure d’appui annoncée par un téléphone est bornée par son heure d’arrivée et sa latence connue. Impossible de « remonter le temps » pour passer devant tout le monde.

**Précision** : quelques centièmes de seconde, ce qui suffit largement pour départager des humains. Limite connue : aucune synchro d’horloge ne peut détecter un réseau très asymétrique (envoi bien plus lent que la réception). Dans ce cas, l’ordre reste quand même meilleur que l’ordre d’arrivée (voir la simulation plus bas).

---

## 🧪 Tester sans Supabase (mode local)

Tant que `js/config.js` n’est pas rempli, ou si tu ajoutes `?local=1` à l’adresse, les onglets d’un **même navigateur** jouent entre eux :

```bash
python -m http.server 8000
# puis http://localhost:8000/?local=1
```

Paramètres de test utilisables sur `play.html` :

- `&lat=300` : simule jusqu’à 300 ms de latence ;
- `&skew=5000` : simule une horloge décalée de 5 s.

Exemple : ouvre un joueur avec `lat=350` et un autre avec `lat=20`. Celui qui appuie en premier reste premier.

Tests automatiques (Node 18 ou plus) :

```bash
node --test tests/game.test.mjs      # règles du jeu
node tests/fairness-sim.mjs          # simulation d'équité (latences asymétriques, horloges décalées)
```

Résultats de la simulation (8 joueurs, horloges décalées de ±30 s) :

| Scénario | Bon gagnant (écart ≥ 30 ms) | Ordre naïf « 1er arrivé » |
|---|---|---|
| Soirée réaliste (Wi-Fi + 4G, 10–150 ms) | **≈ 99,5 %** | ≈ 86 % |
| Cas extrême (très asymétrique, jusqu’à 300 ms) | ≈ 77 % | ≈ 65 % |

---

## 🗂️ Fichiers

```
index.html        accueil (rejoindre / créer / écran TV)
host.html         maître du jeu
play.html         joueur (buzzer)
tv.html           écran du salon
css/style.css     tout le style
js/config.js      ⚙️ URL + clé Supabase (à remplir)
js/game.js        règles : file équitable, fenêtre de grâce, points, trophées (pur, testé)
js/clock.js       synchronisation d'horloge (pur, testé)
js/transport.js   Supabase Realtime (Broadcast + Presence) ou mode local
js/fx.js          sons synthétisés, vibrations, confettis
js/ui.js          rendu partagé (file, classement, podium)
js/host.js · play.js · tv.js · home.js   logique de chaque page
js/vendor/        supabase-js 2.119.2 et qrcode-generator 1.4.4 (licence MIT)
tests/            tests des règles et simulation d'équité
```

**Limites assumées** :

- Il faut une connexion internet (Wi-Fi ou 4G) : c’est le prix du temps réel.
- L’iPhone ne permet pas la vibration depuis un site web.
- Les messages ne sont pas signés : un joueur très bricoleur qui connaît le code de la salle pourrait envoyer de faux messages. C’est acceptable pour un jeu en famille ou entre amis.
- L’offre gratuite de Supabase (200 connexions simultanées) suffit très largement.
