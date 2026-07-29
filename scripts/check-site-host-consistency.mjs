import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const primaryOrigin = "https://www.gptc.cc";
const analyticsGuard = "/^(?:www\\.)?gptc\\.cc$/i.test(window.location.hostname)";
const nonIndexablePages = new Set(["activate/index.html"]);

function walkHtmlFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkHtmlFiles(fullPath));
    } else if (entry.name.endsWith(".html")) {
      files.push(fullPath);
    }
  }
  return files;
}

const htmlFiles = [
  path.join(repoRoot, "index.html"),
  path.join(repoRoot, "activate", "index.html"),
  path.join(repoRoot, "gpt-chongzhi", "index.html"),
  ...walkHtmlFiles(path.join(repoRoot, "blog")),
].sort();

const failures = [];

for (const file of htmlFiles) {
  const relativePath = path.relative(repoRoot, file);
  const html = fs.readFileSync(file, "utf8");
  const canonical = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["'][^>]*>/i)?.[1];
  const robotsMeta = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["'][^>]*>/i)?.[1] || "";

  if (nonIndexablePages.has(relativePath)) {
    if (canonical) {
      failures.push(`${relativePath}: non-indexable page must not declare a canonical URL`);
    }
    if (!robotsMeta.split(",").map(value => value.trim().toLowerCase()).includes("noindex")) {
      failures.push(`${relativePath}: non-indexable page is missing robots noindex`);
    }
  } else if (!canonical) {
    failures.push(`${relativePath}: missing canonical URL`);
  } else if (!canonical.startsWith(`${primaryOrigin}/`)) {
    failures.push(`${relativePath}: canonical must use ${primaryOrigin}, got ${canonical}`);
  }

  if (html.includes("https://hm.baidu.com/hm.js") && !html.includes(analyticsGuard)) {
    failures.push(`${relativePath}: Baidu Analytics loader is missing the production-host guard`);
  }
}

const sitemap = fs.readFileSync(path.join(repoRoot, "sitemap.xml"), "utf8");
for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  if (!match[1].startsWith(`${primaryOrigin}/`)) {
    failures.push(`sitemap.xml: non-primary URL ${match[1]}`);
  }
  if (match[1].startsWith(`${primaryOrigin}/activate`)) {
    failures.push(`sitemap.xml: non-indexable activation URL must not be listed: ${match[1]}`);
  }
}

const robots = fs.readFileSync(path.join(repoRoot, "robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${primaryOrigin}/sitemap.xml`)) {
  failures.push("robots.txt: sitemap URL must use the primary www host");
}
if (!robots.includes("Disallow: /activate/")) {
  failures.push("robots.txt: activation flow must be blocked from crawler access");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Checked ${htmlFiles.length} HTML files: canonical host and analytics guard are consistent.`);
