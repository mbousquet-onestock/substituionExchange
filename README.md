# Extension OneStock `bo.orders.action` – articles de la commande

Pop-up ouverte depuis la liste des commandes du back-office OneStock. Elle reçoit
le contexte (`order_ids`, `extension_signature`…) par `postMessage`, puis affiche
les articles de chaque commande (image, nom, prix | couleur | taille, référence,
état du line item group, quantité).

## Fonctionnement

1. `public/index.html` envoie `extension_ready`, reçoit `onestock_data`.
2. Elle appelle `POST /api/orders/items` sur ce serveur avec les `order_ids`,
   `extension_id`, `user_id` (paramètres d'URL) et `extension_signature`.
3. `server.js` vérifie la signature (HMAC-SHA256, clés courante/précédentes),
   se connecte à l'API OneStock (`POST /login`, token mis en cache) et appelle
   `GET /orders/{id}` (via `POST` + `X-HTTP-Method-Override: GET`) avec les
   champs `order_items.*` et `line_item_groups.*` et les features produit.

Les identifiants API restent côté serveur.

`public/context.html` affiche le contexte brut reçu de OneStock (debug).

## Configuration (variables d'environnement)

| Variable | Description |
|---|---|
| `ONESTOCK_SITE_ID` | ex. `c00` |
| `ONESTOCK_USER` / `ONESTOCK_PASSWORD` | identifiants API OneStock |
| `ONESTOCK_API_BASE` | défaut `https://{site_id}.api.qualif.onestock-retail.com/v3` (prod : `https://{site_id}.api.onestock-retail.com/v3`) |
| `EXTENSION_SECRET_KEYS` | clés secrètes de l'extension, séparées par des virgules. Si vide, la signature n'est **pas** vérifiée (dev uniquement) |
| `FEATURE_NAME`, `FEATURE_IMAGE`, `FEATURE_COLOR`, `FEATURE_SIZE` | noms des features produit (défauts `name`, `image_url`, `color`, `size`) |
| `PORT` | défaut `3000` |
| `ONESTOCK_MOCK=1` | renvoie des données factices sans appeler OneStock |

## Lancer

```bash
npm run mock           # données factices
ONESTOCK_SITE_ID=c00 ONESTOCK_USER=... ONESTOCK_PASSWORD=... EXTENSION_SECRET_KEYS=... npm start
```

Déployer derrière une URL HTTPS publique et déclarer cette URL comme extension
sur le point d'injection `bo.orders.action`.
