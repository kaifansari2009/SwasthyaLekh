import fs from "fs";
import path from "path";

const publicDir = path.resolve(".output/public");
const repoName = process.env.REPO_NAME || (process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split("/")[1] : "SwasthyaLekh");
const base = `/${repoName}/`;

if (!fs.existsSync(publicDir)) {
  console.error(".output/public directory does not exist. Run npm run build first.");
  process.exit(1);
}

// 1. Create .nojekyll to prevent GitHub Pages from ignoring files starting with _
fs.writeFileSync(path.join(publicDir, ".nojekyll"), "");

// 2. SPA route restorer script to inject into HTML <head>
const spaRestorerScript = `
    <script type="text/javascript">
      // SPA route restorer from 404.html
      (function(l) {
        if (l.search[1] === '/' ) {
          var decoded = l.search.slice(1).split('&').map(function(s) { 
            return s.replace(/~and~/g, '&')
          }).join('?');
          window.history.replaceState(null, null,
              l.pathname.slice(0, -1) + decoded + l.hash
          );
        }
      }(window.location));
    </script>`;

// 3. Load SSR renderer and pre-render routes
async function prerender() {
  console.log(`Prerendering SSR routes for base: ${base}...`);
  await import("../.output/server/index.mjs");
  const ssr = globalThis.__nitro_vite_envs__?.["ssr"];

  if (!ssr) {
    console.error("SSR renderer not found in globalThis.__nitro_vite_envs__");
    process.exit(1);
  }

  async function getHtml(routePath) {
    const url = `http://localhost${routePath}`;
    const res = await ssr.fetch(new Request(url));
    if (res.status !== 200) {
      console.warn(`Warning: ${routePath} returned status ${res.status}`);
      return null;
    }
    let html = await res.text();
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>${spaRestorerScript}`);
    }
    return html;
  }

  // Pre-render home
  const homeHtml = await getHtml(base);
  if (homeHtml) {
    fs.writeFileSync(path.join(publicDir, "index.html"), homeHtml);
    console.log(`✅ Pre-rendered index.html (${homeHtml.length} bytes)`);
  } else {
    console.error("Failed to pre-render home page");
    process.exit(1);
  }

  // Pre-render intake
  const intakeHtml = await getHtml(`${base}intake`);
  if (intakeHtml) {
    const intakeDir = path.join(publicDir, "intake");
    if (!fs.existsSync(intakeDir)) fs.mkdirSync(intakeDir, { recursive: true });
    fs.writeFileSync(path.join(intakeDir, "index.html"), intakeHtml);
    console.log(`✅ Pre-rendered intake/index.html (${intakeHtml.length} bytes)`);
  }

  // Pre-render auth
  const authHtml = await getHtml(`${base}auth`);
  if (authHtml) {
    const authDir = path.join(publicDir, "auth");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "index.html"), authHtml);
    console.log(`✅ Pre-rendered auth/index.html (${authHtml.length} bytes)`);
  }

  // 4. SPA 404.html for GitHub Pages subpath routing
  const redirect404Html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>SwasthyaLekh</title>
    <script type="text/javascript">
      var pathSegmentsToKeep = 1;
      var l = window.location;
      l.replace(
        l.protocol + '//' + l.hostname + (l.port ? ':' + l.port : '') +
        l.pathname.split('/').slice(0, 1 + pathSegmentsToKeep).join('/') + '/?/' +
        l.pathname.slice(1).split('/').slice(pathSegmentsToKeep).join('/').replace(/&/g, '~and~') +
        (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') +
        l.hash
      );
    </script>
  </head>
  <body>
  </body>
</html>
`;
  fs.writeFileSync(path.join(publicDir, "404.html"), redirect404Html);
  console.log(`✅ Generated 404.html and .nojekyll in .output/public`);
}

prerender().catch((err) => {
  console.error("Error during prerender:", err);
  process.exit(1);
});
