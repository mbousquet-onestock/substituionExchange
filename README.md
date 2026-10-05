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
api/proxy.js        POST /api/proxy  : proxy générique en lecture (fiches articles /v2/items)
api/substitutions.js POST /api/substitutions : confirmation (sous-commande + statut des lignes)
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
   « Valider la substitution » appelle `POST /api/substitutions` (une fois par commande d'origine). Le serveur :
   1. relit la commande d'origine complète (`GET /v3/orders/{id}`, avec la liste complète des `fields`,
      `parent_order_id` compris). Deux formats de réponse sont acceptés (`lib/order-format.js`) :
      `order_items` / `line_item_groups` (doc) ou `line_items` unitaires + `payment` (format observé) ; dans ce
      second cas, les unités sont regroupées par article / statut / point de stock et leurs `index_ranges`
      reconstruits, `payment` donne l'adresse de facturation, la devise et les frais de port, et le transporteur
      est repris des lignes ou des colis. La pop-up utilise la même normalisation ;
   2. contrôle que chaque ligne appartient à la commande, que son statut est dans `substitution_states`
      et que `substituted_state` est configuré ;
   3. crée la **sous-commande** par `POST /v3/orders`, identifiant `{commande}-S1` (puis `-S2`… si elle existe déjà) :
      - reprise des données de la commande d'origine acceptées par `POST /orders` (client, livraison et
        transporteur, adresse de facturation, devise, types, canal de vente, `information`, `ordering`, ruleset…),
        sauf `id`, `date`, `payment_information` et une `delivery_promise` incomplète ;
      - articles de substitution avec la quantité de la ligne d'origine et **tous les montants à 0** ;
      - **frais de port repris à 0** (sans taxes ni remises), total de la commande à 0 ;
      - **`parent_order_id` (« Parent number ») repris de la commande d'origine** et envoyé dans
        `order.parent_order_id`. Ce champ n'étant pas documenté dans les `fields` de `GET /orders`, il est cherché
        (à tout niveau de la réponse) par lectures successives, arrêtées dès qu'il est trouvé :
        `GET /v3/orders/{id}` avec `fields: ["parent_order_id"]`, puis sans filtre, puis les mêmes en `/v4`.
        La réponse de `/api/substitutions` indique la lecture qui l'a fourni (`parent_lookup`) ; s'il est introuvable,
        la sous-commande est créée sans numéro parent et la pop-up l'affiche en avertissement ;
      - `information.original_order_id` et `information.substitution` (commande, lignes, articles d'origine)
        pour le lien avec la commande d'origine ;
   4. passe chaque ligne substituée de son statut actuel au statut `substituted_state`
      (`PATCH /v3/line_item_groups` avec ses `index_ranges` et son `endpoint_id`).

   La pop-up affiche la sous-commande créée et, le cas échéant, les lignes dont le statut n'a pas pu changer.
   Elle envoie aussi à la page parente un `postMessage` `{ type: "substitution_validated", substitutions, results }`.
   Ces deux écritures ne sont possibles que côté serveur : le proxy `/api/proxy` reste en lecture seule.

   **Fermer** en fin de traitement (au moins une sous-commande créée) recharge la page OneStock d'origine :
   OneStock ne propose pas de message de rafraîchissement, la fenêtre principale est donc renvoyée vers
   `parent_url` (navigation autorisée par le navigateur car déclenchée par le clic), puis `extension_close`
   est envoyé (avec `refresh: true`, option non documentée sans effet si ignorée). Sans substitution réalisée,
   « Fermer » ferme simplement la fenêtre.

## Traductions

Les textes **statiques** des pages sont dans `public/i18n.js` (fr, en, es, it, de). Les données récupérées
de OneStock (états des lignes, noms, couleurs…) sont affichées telles quelles, sans traduction.
- **Pop-up** : langue du contexte OneStock (paramètre d'URL `lang`, sinon `locale`, sinon navigateur).
- **Page de configuration** : `?lang=` si fourni, sinon langue du navigateur.
- Langue non traduite → anglais ; clé absente d'une langue → anglais puis français.
- Les erreurs du serveur portent un `code` (ex. `token_missing`) traduit côté page.
- Les prix sont formatés selon la locale du contexte.

## Page de configuration (`/config.html`)

La pop-up n'a pas d'onglet de configuration : tout se règle dans `/config.html`
(lien direct : `/config.html?env=qualif&site_id=c00`), protégée par la clé `ADMIN_KEY` (en-tête `X-Admin-Key`).

### Table `settings` (partagée entre applicatifs)

| Colonne | Rôle |
|---|---|
| `extension_id` | id de l'extension (`substitution`, variable `EXTENSION_ID`) ou `*` pour un paramètre **global** à toutes les extensions |
| `environment` | environnement OneStock (`qualif`, `prod`…) |
| `site_id` | site OneStock, ou vide pour la valeur **commune** à tous les sites de l'environnement |
| `key` / `value` | paramètre et valeur |
| `scope` | colonne calculée : `global` (`extension_id = '*'`) ou `extension` |

Clé primaire : (`extension_id`, `environment`, `site_id`, `key`).

Résolution d'un paramètre, du plus précis au plus général :
extension + site → global + site → extension + commun → global + commun → valeur par défaut.

| Paramètre | Clé | Portée par défaut | Défaut |
|---|---|---|---|
| Route de l'API | `onestock_api_root` | global | qualif : `https://api-qualif.onestock-retail.com`, prod : `https://api.onestock-retail.com` |
| Langue par défaut (repli des fiches articles) | `default_lang` | global | `fr` (`DEFAULT_LANG`) |
| Statuts des lignes éligibles à la substitution | `substitution_states` | extension | `*` = tous (`DEFAULT_SUBSTITUTION_STATES`) |
| Statut des lignes substituées | `substituted_state` | extension | `substituted` (`DEFAULT_SUBSTITUTED_STATE`) |
| Token API OneStock | `onestock_token` | global | — |

Dans `/config.html`, chaque paramètre a un sélecteur de portée : **Global (toutes les extensions)** ou
**Spécifique à substitution**. Passer un paramètre en global supprime la valeur spécifique de l'extension
(qui la masquerait) ; une valeur spécifique laisse la valeur globale en place pour les autres extensions.
La provenance de chaque valeur est affichée (global / spécifique · site / commun, ou par défaut).

La route, la langue, les statuts éligibles et le statut des lignes substituées sont créés automatiquement,
au niveau commun de l'environnement (`site_id` vide) puis pour chaque site (première utilisation ou
ouverture dans `/config.html`). Le token n'est stocké que s'il est saisi. Les anciennes lignes sont migrées
automatiquement : elles deviennent globales, dans l'environnement `ONESTOCK_ENV`.

### Environnement de la pop-up

La pop-up lit l'environnement dans le paramètre `env` de l'URL de l'extension (ex. déclarer
`https://<app>/?env=prod` dans le back-office de production), sinon `ONESTOCK_ENV` (défaut `qualif`).
Environnements acceptés : `ONESTOCK_ENVIRONMENTS` (défaut `qualif,prod`).

### Statuts permettant la substitution

À l'étape **Articles**, seules les lignes dont le statut figure dans `substitution_states` sont sélectionnables ;
les autres sont grisées avec le motif « Substitution impossible pour le statut … ».

Le journal des appels API (500 derniers) enregistre l'extension, l'environnement et le site.

### Diagnostic

Le bouton **Lancer le diagnostic** de `/config.html` crée les paramètres manquants du site, puis affiche :
le déploiement Vercel (commit, branche, environnement), la base réellement utilisée (hôte, nom),
la structure et la clé primaire de `settings`, les lignes de l'environnement / du site (token masqué)
et le nombre de lignes par paramètre. Utile si les lignes n'apparaissent pas dans la base consultée
(ex. base de preview Neon différente de la base de production).

## Base de données (Vercel)

Vercel → projet → **Storage** → créer une base **Postgres (Neon)** et la connecter au projet :
la variable `POSTGRES_URL` (ou `DATABASE_URL`) est ajoutée automatiquement.
Les tables `settings` et `api_logs` sont créées au premier appel.

## Variables d'environnement

| Variable | Description |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | connexion Postgres (fournie par Vercel Storage) |
| `ONESTOCK_SITE_ID` | ex. `c00`. Si absent, le `site_id` transmis par OneStock dans l'URL est utilisé |
| `ONESTOCK_API_ROOT` | force la route de l'API par défaut pour tous les environnements ; la valeur configurée pour le site est prioritaire |
| `ONESTOCK_GET_TRANSPORT` | `xget` (défaut) ou `override` (`POST` + `X-HTTP-Method-Override: GET`) |
| `EXTENSION_ID` | id de l'extension dans `settings` (défaut `substitution`) |
| `ONESTOCK_ENV` / `ONESTOCK_ENVIRONMENTS` | environnement par défaut (défaut `qualif`) / environnements acceptés (défaut `qualif,prod`) |
| `DEFAULT_SUBSTITUTION_STATES` | statuts éligibles si non configurés (défaut `*`) |
| `DEFAULT_SUBSTITUTED_STATE` | statut des lignes substituées si non configuré (défaut `substituted`) |
| `ADMIN_KEY` | clé d'accès à `/config.html` (**obligatoire sur Vercel**, sinon la page est refusée) |
| `DEFAULT_LANG` | langue par défaut si non configurée (défaut `fr`) |
| `EXTENSION_SECRET_KEYS` | clés secrètes de l'extension, séparées par des virgules. Si vide, la signature n'est **pas** vérifiée |

Les noms des features produit (`name`, `image`, `color`, `size`, `substitution`) sont en tête du script de `public/index.html`.

## Développement local

```bash
npm install
POSTGRES_URL=postgres://user@localhost:5432/db npm run dev
```
