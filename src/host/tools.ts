// Pinned, checksum-verified kind/kubectl binaries in ~/.folie/bin.
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BIN } from "./env";

const ARCH = ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[
  process.arch
];
if (process.platform !== "linux" || !ARCH)
  throw new Error(`unsupported platform ${process.platform}/${process.arch}`);

const TOOLS = {
  kind: {
    url: `https://kind.sigs.k8s.io/dl/v0.33.0/kind-linux-${ARCH}`,
    checksum: ".sha256sum",
  },
  kubectl: {
    url: `https://dl.k8s.io/release/v1.37.2/bin/linux/${ARCH}/kubectl`,
    checksum: ".sha256",
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const ALL_TOOLS = Object.keys(TOOLS) as ToolName[];

async function ok(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return res;
}

export async function ensureTool(name: ToolName) {
  const path = join(BIN, name);
  if (await Bun.file(path).exists()) return;
  console.log(`==> downloading ${name}`);
  const { url, checksum } = TOOLS[name];
  const [bin, sum] = await Promise.all([
    fetch(url)
      .then((r) => ok(r, url))
      .then((r) => r.arrayBuffer()),
    fetch(url + checksum)
      .then((r) => ok(r, `${name} checksum`))
      .then((r) => r.text()),
  ]);
  if (
    createHash("sha256").update(new Uint8Array(bin)).digest("hex") !==
    sum.trim().split(/\s+/)[0]
  )
    throw new Error(`${name}: sha256 mismatch`);
  await mkdir(BIN, { recursive: true });
  await Bun.write(path, bin);
  await chmod(path, 0o755);
}
