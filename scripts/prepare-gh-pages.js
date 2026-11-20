import fs from "fs";
import path from "path";

const publicDir = path.resolve(".output/public");
const assetsDir = path.join(publicDir, "assets");

if (!fs.existsSync(publicDir)) {
  console.error(".output/public directory does not exist. Run npm run build first.");
  process.exit(1);
}

// 1. Create .nojekyll to prevent GitHub Pages from ignoring files starting with _
fs.writeFileSync(path.join(publicDir, ".nojekyll"), "");

// 2. Find the client entry JS and CSS files
const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
const mainJs = files.find((f) => f.startsWith("index-") && f.endsWith(".js")) || files.find((f) => f.endsWith(".js"));
const mainCss = files.find((f) => f.endsWith(".css"));

console.log("Client assets detected:", { mainJs, mainCss });

// Dynamic repository subpath for GitHub Pages
const repoName = process.env.REPO_NAME || (process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split("/")[1] : "SwasthyaLekh");
const base = `/${repoName}/`;

// 3. SPA index.html supporting subpath hosting
const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SwasthyaLekh</title>
    <meta name="description" content="AI-assisted patient triage for rural health workers" />
    <base href="${base}" />
    <link rel="icon" type="image/png" href="${base}favicon.png" />
    ${mainCss ? `<link rel="stylesheet" href="${base}assets/${mainCss}" />` : ""}
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
    </script>
  </head>
  <body>
    <div id="root"></div>
    ${mainJs ? `<script type="module" src="${base}assets/${mainJs}"></script>` : ""}
  </body>
</html>
`;

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

fs.writeFileSync(path.join(publicDir, "index.html"), indexHtml);
fs.writeFileSync(path.join(publicDir, "404.html"), redirect404Html);

console.log(`✅ index.html, 404.html (SPA router base: ${base}), and .nojekyll generated in .output/public`);
