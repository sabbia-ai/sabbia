// Development tooling is cached outside the repository; the application needs no packages.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const cache = join(tmpdir(), "sabbia-typecheck-v1");
mkdirSync(cache, { recursive: true });
async function typePackage(name: string, version: string, folder: string) {
  const destination = join(cache, folder);
  if (await Bun.file(join(destination, "package.json")).exists()) return;
  console.log(`Caching development declarations: ${name}@${version}`);
  const metadata = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (!metadata.ok) throw new Error(`Cannot resolve ${name}: HTTP ${metadata.status}`);
  const manifest = await metadata.json() as { dist: { tarball: string; integrity: string } };
  const response = await fetch(manifest.dist.tarball);
  if (!response.ok) throw new Error(`Cannot download ${name}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const [algorithm, expected] = manifest.dist.integrity.split("-");
  if (algorithm !== "sha512" || new Bun.CryptoHasher("sha512").update(archive).digest("base64") !== expected) throw new Error("Declaration archive integrity check failed");
  const tar = gunzipSync(archive);
  for (let p = 0; p + 512 <= tar.length;) {
    const name = tar.subarray(p, p + 100).toString().replace(/\0.*$/, ""); if (!name) break;
    const size = parseInt(tar.subarray(p + 124, p + 136).toString().replace(/\0.*$/, "").trim() || "0", 8), kind = tar[p + 156];
    const relative = name.split("/").slice(1).join("/");
    if ((kind === 0 || kind === 48) && relative && !relative.split("/").some(part => part === "..") && !relative.startsWith("/")) await Bun.write(join(destination, relative), tar.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
}
await Promise.all([typePackage("bun-types", "1.3.11", "bun-types"), typePackage("@types/node", "22.18.6", "node")]);
const child = Bun.spawn([process.execPath, "x", "--package", "typescript@5.9.3", "tsc", "--noEmit", "--typeRoots", cache], { stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
