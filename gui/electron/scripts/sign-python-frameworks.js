const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

const disableTimestamp = /^(1|true|yes)$/i.test(
  process.env.CSC_DISABLE_TIMESTAMP || ""
);

function isMachO(filePath) {
  try {
    const output = execFileSync("/usr/bin/file", ["-b", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return output.includes("Mach-O");
  } catch {
    return false;
  }
}

function walkFiles(root, onFile) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      onFile(current);
    }
  }
}

function signFile(filePath, identity) {
  const args = ["--force", "--options", "runtime", "--sign", identity];
  if (!disableTimestamp) {
    args.push("--timestamp");
  }
  args.push(filePath);
  run("/usr/bin/codesign", args);
}

function signBundle(bundlePath, identity, entitlementsPath, deep = false) {
  const args = ["--force", "--options", "runtime", "--sign", identity];
  if (!disableTimestamp) {
    args.push("--timestamp");
  }
  if (entitlementsPath) {
    args.push("--entitlements", entitlementsPath);
  }
  if (deep) {
    args.push("--deep");
  }
  args.push(bundlePath);
  run("/usr/bin/codesign", args);
}

function resolveIdentity() {
  const envIdentity = (process.env.CSC_NAME || process.env.CSC_IDENTITY || "")
    .trim()
    .replace(/^"+|"+$/g, "");
  if (/^[0-9A-F]{40}$/i.test(envIdentity)) {
    return envIdentity;
  }
  if (envIdentity.startsWith("Developer ID Application:")) {
    return envIdentity;
  }

  const teamId = (process.env.APPLE_TEAM_ID || "").trim();
  let output = "";
  try {
    output = execFileSync("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]).toString();
  } catch {
    output = "";
  }

  const lines = output.split("\n").filter((line) =>
    line.includes("Developer ID Application:")
  );
  if (lines.length === 0) {
    return envIdentity || "";
  }
  const pickLine = teamId
    ? lines.find((line) => line.includes(`(${teamId})`))
    : lines[0];
  if (!pickLine) {
    return envIdentity || "";
  }
  const match = pickLine.match(/\)\s+([0-9A-F]{40})\s+\"/i);
  if (match) {
    return match[1];
  }
  return envIdentity || "";
}

exports.default = async function signPythonFrameworks(context) {
  if (
    /^(1|true|yes)$/i.test(process.env.MAGIC_PASTE_SKIP_SIGNING || "") ||
    String(process.env.CSC_IDENTITY_AUTO_DISCOVERY || "").toLowerCase() ===
      "false"
  ) {
    console.log("[afterSign] signing skipped by environment");
    return;
  }
  const identity = resolveIdentity();
  if (!identity) {
    throw new Error(
      "Signing identity not found. Set CSC_NAME or APPLE_TEAM_ID."
    );
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const entitlementsPath = path.join(
    context.packager.projectDir,
    "build/entitlements.mac.plist"
  );

  const runtimeRoots = [
    path.join(appPath, "Contents/Resources/python/arm64"),
    path.join(appPath, "Contents/Resources/python/x64"),
  ];

  console.log(`[afterSign] using identity: ${identity}`);

  for (const runtimeRoot of runtimeRoots) {
    if (!fs.existsSync(runtimeRoot)) continue;

    // 1) Sign leaf Mach-O files first (bin/python3, .so, .dylib, etc.).
    walkFiles(runtimeRoot, (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const base = path.basename(filePath);
      const isCandidate =
        ext === ".so" ||
        ext === ".dylib" ||
        ext === ".bundle" ||
        base === "Python" ||
        base === "python3.11" ||
        base === "python3";
      if (!isCandidate) return;
      if (!isMachO(filePath)) return;
      signFile(filePath, identity);
    });
  }

  // 3) Re-sign the app to include updated bundle signatures.
  if (fs.existsSync(appPath)) {
    signBundle(appPath, identity, entitlementsPath);
  }
};
