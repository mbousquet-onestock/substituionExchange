# Extension OneStock `bo.orders.action` – articles de la commande

Pop-up ouverte depuis la liste des commandes du back-office OneStock. Elle affiche
les articles de chaque commande sélectionnée (image, nom, prix | couleur | taille,
référence, état, quantité). Elle est déployée sur **Vercel**.

## Architecture

```
public/index.html   pop-up (onglets Articles / Config)
public/context.html affichage brut du contexte reçu de OneStock (debug)
api/orders/[id].js  GET  /api/orders/{id} : proxy dédié vers GET /v3/orders/{id}
api/proxy.js        POST /api/proxy  : proxy générique (fiches articles /v2/items)
api/config.js       POST /api/config : lecture / enregistrement du token
api/logs.js         POST /api/logs   : journal des appels API OneStock
lib/                base de données, client OneStock, signature
scripts/dev-server.js  serveur local qui reproduit Vercel
```

1. La pop-up envoie `extension_ready` et reçoit `onestock_data` : le numéro de commande est lu dans
   `order_id` (ou `order_ids`, séparés par des virgules), puis dans les paramètres d'URL du même nom.
2. Tous les appels aux API OneStock passent par un proxy Vercel : **`GET /api/orders/{id}`** pour la
   commande, **`POST /api/proxy`** pour les fiches articles. Le proxy :
   - vérifie la signature de l'extension ;
   - n'autorise que des routes en lecture (`GET /vX/orders/{id}`, `GET /vX/items`, `GET /vX/line_item_groups`) ;
   - ajoute `site_id` et le **token stocké en base** au body ;
   - appelle OneStock (méthode `XGET`, ou `POST` + `X-HTTP-Method-Override: GET`) ;
   - **journalise l'appel en base** (URL, requête avec token masqué, statut, durée, réponse ou erreur).
3. Appels effectués :
   - `GET /v3/orders/{id}` : `order_items.*`, `line_item_groups.*` ;
   - `GET /v2/items` avec `item_ids` (sans `lang` ni `features` → toutes les langues) : fiche article.
     L'URL de l'image est lue dans la feature **`image`** (à défaut `Image URL` ; noms comparés sans casse
     ni séparateurs) dans la langue du contexte, sinon en **fr**.
     Nom, couleur et taille absents de la commande sont complétés de la même façon.

## Parcours de substitution (onglet Articles)

1. **Articles** : les articles de la commande sont affichés en cartes ; on coche un ou plusieurs articles à substituer.
2. **Substitution** : pour chaque article coché,
   - les **articles de substitution** sont lus dans la feature `substitution` de la fiche article
     (identifiants d'articles, liste ou valeurs séparées par `,` / `;`), puis leurs fiches sont chargées via `GET /v2/items` ;
   - sinon (ou en complément) une **recherche** permet de trouver un autre article pour l'échange :
     `GET /v2/items` par nom (`pattern` sur `name`) et par référence exacte (`item_ids`) ; les fiches trouvées
     sont rechargées dans toutes les langues pour compléter les champs vides (descriptif, image) avec `fr`.
3. **Validation** : récapitulatif article d'origine → article de remplacement (même quantité).
   « Valider la substitution » envoie à la page parente un `postMessage`
   `{ type: "substitution_validated", substitutions: [{ order_id, line_item_group_id, item_id, quantity, substitute_item_id }] }`.
   Aucune modification n'est encore envoyée à OneStock.

## Onglet Config

- **Route de l'API** : racine des appels, par défaut `https://api-qualif.onestock-retail.com`
  (ex. `https://api.onestock-retail.com` en production). Stockée en base ; seules les URL https
  en `*.onestock-retail.com` sont acceptées (le token y est envoyé). Bouton « Par défaut » pour revenir à la valeur initiale.
- **Token API OneStock** : saisi une fois, stocké en base (table `settings`), utilisé
  pour tous les appels. Il n'est jamais renvoyé au navigateur (seul un aperçu `abcd…wxyz` est affiché).
- **Appels API OneStock** : les 100 derniers appels (500 conservés en base), avec
  le détail requête / réponse au clic. Boutons Rafraîchir et Vider.

Si le token manque ou est refusé (401), la pop-up bascule sur l'onglet Config.

## Base de données (Vercel)

Vercel → projet → **Storage** → créer une base **Postgres (Neon)** et la connecter au projet :
la variable `POSTGRES_URL` (ou `DATABASE_URL`) est ajoutée automatiquement.
Les tables `settings` et `api_logs` sont créées au premier appel.

## Variables d'environnement

| Variable | Description |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | connexion Postgres (fournie par Vercel Storage) |
| `ONESTOCK_SITE_ID` | ex. `c00`. Si absent, le `site_id` transmis par OneStock dans l'URL est utilisé |
| `ONESTOCK_API_ROOT` | route de l'API par défaut (défaut `https://api-qualif.onestock-retail.com`) ; la valeur saisie dans l'onglet Config est prioritaire |
| `ONESTOCK_GET_TRANSPORT` | `xget` (défaut) ou `override` (`POST` + `X-HTTP-Method-Override: GET`) |
| `EXTENSION_SECRET_KEYS` | clés secrètes de l'extension, séparées par des virgules. Si vide, la signature n'est **pas** vérifiée |

Les noms des features produit (`name`, `image`, `color`, `size`) et la langue de repli (`fr`) sont en tête du script de `public/index.html`.

## Développement local

```bash
npm install
POSTGRES_URL=postgres://user@localhost:5432/db npm run dev
```
