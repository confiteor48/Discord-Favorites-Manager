import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname);
const portArg = process.argv.find((arg) => /^\d+$/.test(arg));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node server.mjs [port]");
  console.log("Environment: HOST=127.0.0.1 PORT=8765");
  process.exit(0);
}

const port = Number(process.env.PORT || portArg || 8765);
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://${host}:${port}`).pathname);
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  const filePath = resolve(root, relative || "index.html");
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return "";
  return filePath;
}

const server = createServer(async (request, response) => {
  try {
    let filePath = resolveRequestPath(request.url || "/");
    if (!filePath) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, "index.html");
    const fileInfo = await stat(filePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": fileInfo.size,
      "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(500);
    response.end(error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, host, () => {
  console.log(`Discord Favorite Manager: http://${host}:${port}/index.html`);
});
