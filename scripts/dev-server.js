"use strict";

// Serveur de développement local : reproduit Vercel (public/ en statique + fonctions api/*.js).
// Usage : POSTGRES_URL=postgres://... node scripts/dev-server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const { send } = require("../lib/http");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const API = {
  "/api/proxy": require("../api/proxy"),
  "/api/settings": require("../api/settings"),
  "/api/substitutions": require("../api/substitutions"),
  "/api/admin/config": require("../api/admin/config"),
  "/api/admin/logs": require("../api/admin/logs"),
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: "Interdit" });
  fs.readFile(file, (err, content) => {
    if (err) return send(res, 404, { error: "Introuvable" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

const orderHandler = require("../api/orders/[id]");

const port = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  // Route dynamique Vercel api/orders/[id].js
  const order = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (order) {
    req.query = { ...Object.fromEntries(new URL(req.url, "http://x").searchParams), id: decodeURIComponent(order[1]) };
    return orderHandler(req, res);
  }
  const handler = API[pathname];
  if (handler) return handler(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, { error: "Méthode non autorisée" });
}).listen(port, () => console.log(`Extension disponible sur http://localhost:${port}`));
