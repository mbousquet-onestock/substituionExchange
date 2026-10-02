# Extension OneStock `bo.orders.action` – articles de la commande

Pop-up ouverte depuis la liste des commandes du back-office OneStock. Elle reçoit
le contexte (`order_ids`, `extension_signature`…) par `postMessage`, puis affiche
les articles de chaque commande (image, nom, prix | couleur | taille, référence,
état du line item group, quantité).

## Fonctionnement

1. `public/index.html` envoie `extension_ready`, reçoit `onestock_data`.
2. Elle appelle `POST /api/orders/items` sur ce serveur avec les `order_ids`,
   `extension_id`, `user_id` (paramètres d'URL) et `extension_signature`.
3. `server.js` vérifie la signature (HMAC-SHA256, clés courante/précédentes), puis
   (via `POST` + `X-HTTP-Method-Override: GET`) :
   - `GET /v3/orders/{id}` : `order_items.*`, `line_item_groups.*` (quantité, état, prix, nom/couleur/taille) ;
   - `GET /v2/items` avec `item_ids` : fiche article, d'où vient **l'URL de l'image**
     (et nom/couleur/taille en repli s'ils manquent sur la commande).

## Token / onglet Config masqué

La pop-up contient un onglet **Config** caché, affiché par **Ctrl+Shift+K**
(cliquer d'abord dans la pop-up) ou par **5 clics rapides dans la zone vide à gauche du bouton Close**.
On y saisit le token API OneStock (obtenu via `POST /login`) ; il est stocké dans le
`localStorage` du navigateur et envoyé au serveur à chaque chargement.

- Token saisi → utilisé tel quel (erreur « Token invalide ou expiré » si 401).
- Pas de token → le serveur se connecte avec `ONESTOCK_USER` / `ONESTOCK_PASSWORD` s'ils sont définis.

`public/context.html` affiche le contexte brut reçu de OneStock (debug).

## Configuration (variables d'environnement)

| Variable | Description |
|---|---|
| `ONESTOCK_SITE_ID` | ex. `c00`. Si absent, le `site_id` transmis par OneStock dans l'URL est utilisé |
| `ONESTOCK_USER` / `ONESTOCK_PASSWORD` | identifiants API (optionnels si le token est saisi dans l'onglet Config) |
| `ONESTOCK_ENV` | `qualif` (défaut) ou `prod` |
| `ONESTOCK_API_ROOT` | racine de l'API sans version, remplace l'URL calculée (`https://{site_id}.api.[qualif.]onestock-retail.com`) |
| `EXTENSION_SECRET_KEYS` | clés secrètes de l'extension, séparées par des virgules. Si vide, la signature n'est **pas** vérifiée (dev uniquement) |
| `FEATURE_NAME`, `FEATURE_IMAGE`, `FEATURE_COLOR`, `FEATURE_SIZE` | noms des features produit (défauts `name`, `image_url`, `color`, `size`) |
| `PORT` | défaut `3000` |
| `ONESTOCK_MOCK=1` | renvoie des données factices sans appeler OneStock |

## Lancer

```bash
npm run mock           # données factices
EXTENSION_SECRET_KEYS=... npm start                       # token saisi dans l'onglet Config
ONESTOCK_SITE_ID=c00 ONESTOCK_USER=... ONESTOCK_PASSWORD=... EXTENSION_SECRET_KEYS=... npm start
```

Déployer derrière une URL HTTPS publique et déclarer cette URL comme extension
sur le point d'injection `bo.orders.action`.
