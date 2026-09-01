const { access, readdir, unlink } = require("node:fs/promises");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

const retainedElectronLocales = new Set(["en-US.pak", "zh-CN.pak"]);
const forgeTempPath = path.join(__dirname, ".squirrel-temp");

function removeUnusedElectronLocales(
  buildPath,
  _version,
  platform,
  _arch,
  done,
) {
  if (platform !== "win32") {
    done();
    return;
  }

  (async () => {
    const localesPath = path.join(buildPath, "locales");
    const entries = await readdir(localesPath, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".pak") &&
            !retainedElectronLocales.has(entry.name),
        )
        .map((entry) => unlink(path.join(localesPath, entry.name))),
    );
    await Promise.all(
      [...retainedElectronLocales].map((name) =>
        access(path.join(localesPath, name)),
      ),
    );
  })().then(() => done(), done);
}

module.exports = {
  packagerConfig: {
    asar: false,
    ignore: [/^\/\.(?:forge|squirrel)-temp(?:\/|$)/],
    afterComplete: [removeUnusedElectronLocales],
    electronZipDir: process.env.HOME_ROBOT_ELECTRON_ZIP_DIR || undefined,
    executableName: "Home Robot",
    icon: path.join(__dirname, "assets", "home-robot.ico"),
    name: "Home Robot",
    win32metadata: {
      CompanyName: "Home Robot",
      FileDescription: "Home Robot 私人陪伴桌面应用",
      OriginalFilename: "Home Robot.exe",
      ProductName: "Home Robot",
    },
  },
  rebuildConfig: {},
  hooks: {
    preMake: async () => {
      if (process.platform !== "win32") return;

      // Squirrel's bundled rcedit cannot open paths containing non-ASCII
      // characters. Change TEMP only after Electron packaging has completed.
      mkdirSync(forgeTempPath, { recursive: true });
      process.env.TEMP = forgeTempPath;
      process.env.TMP = forgeTempPath;
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "home_robot",
        authors: "Home Robot",
        description: "Home Robot 私人陪伴桌面应用",
        setupExe: "Home-Robot-Setup.exe",
        setupIcon: path.join(__dirname, "assets", "home-robot.ico"),
        loadingGif: path.join(__dirname, "assets", "installer-loading.gif"),
        noMsi: true,
      },
    },
  ],
};
