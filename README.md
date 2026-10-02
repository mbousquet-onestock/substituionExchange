# Extension OneStock `bo.orders.action` – articles de la commande

Pop-up ouverte depuis la liste des commandes du back-office OneStock. Elle affiche
les articles de chaque commande sélectionnée (image, nom, prix | couleur | taille,
référence, état, quantité). Elle est déployée sur **Vercel**.

## Architecture

```
public/index.html   pop-up (parcours de substitution)
public/i18n.js      traductions (fr, en, es, it, de)
public/config.html  page d'administration : configuration par site + journal des appels API
public/context.html affichage brut du contexte reçu de OneStock (debug)
api/orders/[id].js  GET  /api/orders/{id} : proxy dédié vers GET /v3/orders/{id}
api/proxy.js        POST /api/proxy  : proxy générique (fiches articles /v2/items)
api/settings.js     GET  /api/settings : langue par défaut du site (pour la pop-up)
api/admin/config.js POST /api/admin/config : configuration par site (clé admin)
api/admin/logs.js   POST /api/admin/logs   : journal des appels API OneStock (clé admin)
lib/                base de données, client OneStock, signature
scripts/dev-server.js  serveur local qui reproduit Vercel
```

1. La pop-up envoie `extension_ready` et reçoit `onestock_data` : le numéro de commande est lu dans
   `order_id` (ou `order_ids`, séparés par des virgules), puis dans les paramètres d'URL du même nom.
2. Tous les appels aux API OneStock passent par un proxy Vercel : **`GET /api/orders/{id}`** pour la
   commande, **`POST /api/proxy`** pour les fiches articles. Le proxy :
   - vérifie la signature de l'extension ;
   - n'autorise que des routes en lecture (`GET /vX/orders/{id}`, `GET /vX/items`, `GET /vX/line_item_groups`) ;
   - ajoute `site_id` et le **token du site stocké en base** au body, et appelle la **route de l'API du site** ;
   - appelle OneStock (méthode `XGET`, ou `POST` + `X-HTTP-Method-Override: GET`) ;
   - **journalise l'appel en base** (URL, requête avec token masqué, statut, durée, réponse ou erreur).
3. Appels effectués :
   - `GET /v3/orders/{id}` : `order_items.*`, `line_item_groups.*` ;
   - `GET /v2/items` avec `item_ids` (sans `lang` ni `features` → toutes les langues) : fiche article.
     L'URL de l'image est lue dans la feature **`image`** (à défaut `Image URL` ; noms comparés sans casse
     ni séparateurs) dans la langue du contexte, sinon en **fr**.
     Nom, couleur et taille absents de la commande sont complétés de la même façon.

## Parcours de substitution (pop-up)

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

## Traductions

Les textes des pages sont dans `public/i18n.js` (fr, en, es, it, de ; libellés des états OneStock inclus).
- **Pop-up** : langue du contexte OneStock (paramètre d'URL `lang`, sinon `locale`, sinon navigateur).
- **Page de configuration** : `?lang=` si fourni, sinon langue du navigateur.
- Langue non traduite → anglais ; clé absente d'une langue → anglais puis français.
- Les erreurs du serveur portent un `code` (ex. `token_missing`) traduit côté page.
- Les prix sont formatés selon la locale du contexte.

## Page de configuration (`/config.html`)

La pop-up n'a plus d'onglet de configuration : tout se règle dans `/config.html`
(lien direct possible : `/config.html?site_id=c00`), protégée par la clé `ADMIN_KEY` (en-tête `X-Admin-Key`).

Paramètres stockés **par site** dans la table `settings` (`site_id`, `key`, `value`) :

| Paramètre | Clé | Défaut |
|---|---|---|
| Route de l'API | `onestock_api_root` | `https://api-qualif.onestock-retail.com` (`ONESTOCK_API_ROOT`) |
| Langue par défaut (repli des fiches articles) | `default_lang` | `fr` (`DEFAULT_LANG`) |
| Token API OneStock | `onestock_token` | — |

Un site sans valeur propre utilise la **valeur commune** (`site_id` vide), puis la valeur par défaut.
La page indique la provenance de chaque valeur (propre au site / commune / par défaut).
Le token n'est jamais renvoyé au navigateur. L'ancienne table `settings` (sans `site_id`) est migrée
automatiquement : ses valeurs deviennent les valeurs communes.

Le journal des appels API (500 derniers, avec le `site_id`) est consultable par site ou pour tous les sites.

## Base de données (Vercel)

Vercel → projet → **Storage** → créer une base **Postgres (Neon)** et la connecter au projet :
la variable `POSTGRES_URL` (ou `DATABASE_URL`) est ajoutée automatiquement.
Les tables `settings` et `api_logs` sont créées au premier appel.

## Variables d'environnement

| Variable | Description |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | connexion Postgres (fournie par Vercel Storage) |
| `ONESTOCK_SITE_ID` | ex. `c00`. Si absent, le `site_id` transmis par OneStock dans l'URL est utilisé |
| `ONESTOCK_API_ROOT` | route de l'API par défaut (défaut `https://api-qualif.onestock-retail.com`) ; la valeur configurée pour le site est prioritaire |
| `ONESTOCK_GET_TRANSPORT` | `xget` (défaut) ou `override` (`POST` + `X-HTTP-Method-Override: GET`) |
| `ADMIN_KEY` | clé d'accès à `/config.html` (**obligatoire sur Vercel**, sinon la page est refusée) |
| `DEFAULT_LANG` | langue par défaut si non configurée (défaut `fr`) |
| `EXTENSION_SECRET_KEYS` | clés secrètes de l'extension, séparées par des virgules. Si vide, la signature n'est **pas** vérifiée |

Les noms des features produit (`name`, `image`, `color`, `size`, `substitution`) sont en tête du script de `public/index.html`.

## Développement local

```bash
npm install
POSTGRES_URL=postgres://user@localhost:5432/db npm run dev
```
