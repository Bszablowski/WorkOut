// Kopiuje pliki aplikacji do public/ przed wdrożeniem (te same co w Dockerfile).
const fs = require("fs");
const path = require("path");

const FILES = ["index.html", "sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
const out = path.join(__dirname, "public");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of FILES) fs.copyFileSync(path.join(__dirname, "..", f), path.join(out, f));
console.log("Skopiowano " + FILES.length + " plików do public/");
