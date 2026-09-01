import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const assets = path.join(root, "apps", "desktop", "assets");
const source = path.join(assets, "source");
const iconSource = path.join(source, "home-robot-icon-master.png");
const splashSource = path.join(source, "splash-paper-background.png");
const iconPng = path.join(assets, "home-robot.png");
const iconIco = path.join(assets, "home-robot.ico");
const splashWebp = path.join(assets, "splash-paper-background.webp");
const installerGif = path.join(assets, "installer-loading.gif");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function encodeIco(images) {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = directorySize;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

async function metadata(filePath) {
  const bytes = await readFile(filePath);
  if (path.extname(filePath).toLowerCase() === ".ico") {
    const count = bytes.readUInt16LE(4);
    return {
      path: path.relative(root, filePath).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256(bytes),
      format: "ico",
      width: 256,
      height: 256,
      pages: count,
    };
  }
  const image = await sharp(bytes, { animated: true }).metadata();
  return {
    path: path.relative(root, filePath).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
    format: image.format,
    width: image.width,
    height: image.pageHeight ?? image.height,
    pages: image.pages ?? 1,
  };
}

await mkdir(assets, { recursive: true });
const iconSourceMetadata = await sharp(iconSource).metadata();
if (
  !iconSourceMetadata.hasAlpha ||
  iconSourceMetadata.width !== iconSourceMetadata.height ||
  (iconSourceMetadata.width ?? 0) < 1024
) {
  throw new Error("桌面图标源图必须是至少 1024px 的透明正方形 PNG");
}

const iconMaster = await sharp(iconSource)
  .resize(1024, 1024, { fit: "contain" })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer();
await writeFile(iconPng, iconMaster);

const icoImages = await Promise.all(
  iconSizes.map(async (size) => ({
    size,
    png: await sharp(iconMaster)
      .resize(size, size, { fit: "contain" })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
  })),
);
const ico = encodeIco(icoImages);
await writeFile(iconIco, ico);

const splash = await sharp(splashSource)
  .resize(960, 540, { fit: "cover" })
  .webp({ quality: 88, effort: 6 })
  .toBuffer();
await writeFile(splashWebp, splash);

const installerIcon = await sharp(iconMaster)
  .resize(58, 58, { fit: "contain" })
  .png()
  .toBuffer();
const installerOverlay = Buffer.from(`
  <svg width="268" height="167" xmlns="http://www.w3.org/2000/svg">
    <style>
      .title { font: 600 17px 'Segoe UI', 'Microsoft YaHei UI', sans-serif; fill: #282521; }
      .status { font: 12px 'Segoe UI', 'Microsoft YaHei UI', sans-serif; fill: #777168; }
    </style>
    <text x="96" y="72" class="title">Home Robot</text>
    <text x="96" y="94" class="status">正在安放到你的桌面…</text>
    <circle cx="96" cy="116" r="2.4" fill="#b44735"/>
    <circle cx="106" cy="116" r="2.4" fill="#b44735" opacity=".5"/>
    <circle cx="116" cy="116" r="2.4" fill="#b44735" opacity=".2"/>
  </svg>
`);
const installer = await sharp(splashSource)
  .resize(268, 167, { fit: "cover" })
  .composite([
    { input: installerIcon, left: 26, top: 53 },
    { input: installerOverlay, left: 0, top: 0 },
  ])
  .gif({ effort: 10, colours: 128 })
  .toBuffer();
await writeFile(installerGif, installer);

const icoHeader = await readFile(iconIco);
if (
  icoHeader.readUInt16LE(0) !== 0 ||
  icoHeader.readUInt16LE(2) !== 1 ||
  icoHeader.readUInt16LE(4) !== iconSizes.length
) {
  throw new Error("生成的 ICO 文件目录头无效");
}

const outputs = await Promise.all(
  [iconPng, iconIco, splashWebp, installerGif].map(metadata),
);
const manifest = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  iconSizes,
  outputs,
};
await writeFile(
  path.join(assets, "visual-assets.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ok: true, ...manifest }));
