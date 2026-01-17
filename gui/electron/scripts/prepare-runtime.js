const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function normalizeArch(arch) {
  if (typeof arch === "string") return arch;
  const map = {
    0: "x64",
    1: "ia32",
    2: "armv7l",
    3: "arm64",
    4: "universal",
  };
  return map[arch] || process.arch;
}

function rewriteRuntimeExtraResources(context, projectDir, repoRoot) {
  const config = context.packager?.config;
  if (!config || !Array.isArray(config.extraResources)) return;
  const runtimeRoot = path.resolve(repoRoot, "runtime", "python");
  let archName = normalizeArch(context.arch);
  if (archName === "ia32" && process.platform === "darwin") {
    // macOS doesn't ship ia32 builds; treat it as x64 to keep runtime packing stable.
    archName = "x64";
  }
  if (archName === "universal") return;

  config.extraResources = config.extraResources.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.from) return entry;
    const fromAbs = path.resolve(projectDir, entry.from);
    if (fromAbs !== runtimeRoot) return entry;
    const fromRel = path.relative(projectDir, path.join(runtimeRoot, archName));
    const toBase = entry.to || "python";
    return {
      ...entry,
      from: fromRel,
      to: path.join(toBase, archName),
    };
  });
}

exports.default = async function prepareRuntime(context) {
  const projectDir = context.packager?.projectDir || path.resolve(__dirname, "..");
  const repoRoot = path.resolve(projectDir, "..", "..");
  const scriptPath = path.join(projectDir, "scripts", "patch_site_packages_zip.py");

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`[beforePack] patch script not found: ${scriptPath}`);
  }

  rewriteRuntimeExtraResources(context, projectDir, repoRoot);

  const candidates = ["python3", "python"];
  let lastError;
  for (const cmd of candidates) {
    try {
      console.log(`[beforePack] patching runtime zip via ${cmd}`);
      run(cmd, [scriptPath, repoRoot]);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `[beforePack] failed to run ${path.basename(scriptPath)}: ${lastError?.message || lastError}`
  );
};
