"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var bootstrap_exports = {};
__export(bootstrap_exports, {
  bootstrapPythonEnvironment: () => bootstrapPythonEnvironment,
  detectPythonVersion: () => detectPythonVersion,
  getPythonExecutableCandidates: () => getPythonExecutableCandidates,
  getVirtualEnvPaths: () => getVirtualEnvPaths,
  isSupportedPythonVersion: () => isSupportedPythonVersion,
  parsePythonVersion: () => parsePythonVersion
});
module.exports = __toCommonJS(bootstrap_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 13;
function uniqueStrings(values) {
  return [...new Set(values.filter((value) => Boolean(value)))];
}
function execFileAsync(command, args, cwd) {
  return new Promise((resolve, reject) => {
    (0, import_node_child_process.execFile)(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
function parsePythonVersion(raw, executable) {
  const match = raw.trim().match(/^Python\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    executable,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: raw.trim()
  };
}
function isSupportedPythonVersion(version) {
  return Boolean(version && version.major === MIN_PYTHON_MAJOR && version.minor >= MIN_PYTHON_MINOR && version.major < 4);
}
function getVirtualEnvPaths(instanceDataDir) {
  const root = import_node_path.default.join(instanceDataDir, "python-sidecar");
  return {
    root,
    python: process.platform === "win32" ? import_node_path.default.join(root, "Scripts", "python.exe") : import_node_path.default.join(root, "bin", "python"),
    stamp: import_node_path.default.join(root, ".requirements.sha1")
  };
}
function getDirectoryPythonCandidates(directory, platform) {
  if (platform === "win32") {
    return [import_node_path.default.join(directory, "python.exe"), import_node_path.default.join(directory, "python3.exe")];
  }
  return [
    import_node_path.default.join(directory, "python3.13"),
    import_node_path.default.join(directory, "python3.12"),
    import_node_path.default.join(directory, "python3"),
    import_node_path.default.join(directory, "python"),
    import_node_path.default.join(directory, "bin", "python3.13"),
    import_node_path.default.join(directory, "bin", "python3.12"),
    import_node_path.default.join(directory, "bin", "python3"),
    import_node_path.default.join(directory, "bin", "python")
  ];
}
function getPythonExecutableCandidates(preferredPython, platform = process.platform) {
  const candidates = [];
  const trimmedPreferred = preferredPython == null ? void 0 : preferredPython.trim();
  if (trimmedPreferred) {
    candidates.push(trimmedPreferred);
    const looksLikeDirectory = !import_node_path.default.extname(trimmedPreferred) && !import_node_path.default.basename(trimmedPreferred).toLowerCase().startsWith("python");
    if (looksLikeDirectory) {
      candidates.push(...getDirectoryPythonCandidates(trimmedPreferred, platform));
    }
  }
  if (platform === "win32") {
    candidates.push(
      "python3.13.exe",
      "python3.12.exe",
      "python3.exe",
      "python.exe",
      "python3.13",
      "python3.12",
      "python3",
      "python",
      "C:\\Python313\\python.exe",
      "C:\\Python312\\python.exe",
      import_node_path.default.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "python.exe"),
      import_node_path.default.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe")
    );
  } else {
    candidates.push("python3.13", "python3.12", "python3", "python");
    if (platform === "darwin") {
      candidates.push(
        "/opt/homebrew/bin/python3.13",
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/opt/python@3.13/bin/python3.13",
        "/opt/homebrew/opt/python@3.12/bin/python3.12",
        "/usr/local/bin/python3.13",
        "/usr/local/bin/python3.12",
        "/usr/local/opt/python@3.13/bin/python3.13",
        "/usr/local/opt/python@3.12/bin/python3.12"
      );
    }
    candidates.push("/usr/local/bin/python3.13", "/usr/local/bin/python3.12", "/usr/bin/python3.13", "/usr/bin/python3.12");
  }
  return uniqueStrings(candidates);
}
async function detectPythonVersion(executable) {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"]);
    return parsePythonVersion(stdout || stderr, executable);
  } catch {
    return null;
  }
}
async function resolvePythonExecutable(preferredPython) {
  const candidates = getPythonExecutableCandidates(preferredPython);
  for (const candidate of candidates) {
    const version = await detectPythonVersion(candidate);
    if (isSupportedPythonVersion(version)) {
      return version;
    }
  }
  const configuredHint = (preferredPython == null ? void 0 : preferredPython.trim()) ? ` Checked configured path "${preferredPython.trim()}" first.` : "";
  throw new Error(`Python 3.13+ not found.${configuredHint} Configure pythonExecutable or install python3.13.`);
}
async function installRequirements(venvPython, requirementsPath, log) {
  log.info("Installing PyMammotion sidecar dependencies");
  await execFileAsync(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  await execFileAsync(venvPython, ["-m", "pip", "install", "-r", requirementsPath]);
}
async function bootstrapPythonEnvironment(options) {
  var _a;
  const version = await resolvePythonExecutable(options.preferredPython);
  const requirementsPath = import_node_path.default.join(options.adapterDir, "python-daemon", "requirements.txt");
  const requirementsContent = await import_promises.default.readFile(requirementsPath, "utf8");
  const requirementsHash = (0, import_node_crypto.createHash)("sha1").update(requirementsContent).digest("hex");
  const venvPaths = getVirtualEnvPaths(options.instanceDataDir);
  await import_promises.default.mkdir(options.instanceDataDir, { recursive: true });
  let venvExists = (0, import_node_fs.existsSync)(venvPaths.python);
  if (venvExists) {
    const venvVersion = await detectPythonVersion(venvPaths.python);
    const venvSupported = isSupportedPythonVersion(venvVersion);
    const venvMatchesSelected = venvVersion && venvVersion.major === version.major && venvVersion.minor === version.minor;
    if (!venvSupported || !venvMatchesSelected) {
      if (!options.bootstrapOnStart) {
        throw new Error("Python sidecar virtual environment uses an incompatible Python version.");
      }
      options.log.info(
        `Recreating Python virtual environment because existing venv uses ${(_a = venvVersion == null ? void 0 : venvVersion.raw) != null ? _a : "unknown"} and selected interpreter is ${version.raw}`
      );
      await import_promises.default.rm(venvPaths.root, { recursive: true, force: true });
      venvExists = false;
    }
  }
  if (!venvExists) {
    if (!options.bootstrapOnStart) {
      throw new Error("Python sidecar virtual environment is missing and bootstrapOnStart is disabled.");
    }
    options.log.info(`Creating Python virtual environment with ${version.raw}`);
    await execFileAsync(version.executable, ["-m", "venv", venvPaths.root]);
    try {
      await execFileAsync(venvPaths.python, ["-m", "ensurepip", "--upgrade"]);
    } catch {
      options.log.debug("ensurepip not available or pip already present, continuing");
    }
  }
  const stampExists = (0, import_node_fs.existsSync)(venvPaths.stamp);
  const installedHash = stampExists ? await import_promises.default.readFile(venvPaths.stamp, "utf8") : "";
  if (!venvExists || installedHash.trim() !== requirementsHash) {
    if (!options.bootstrapOnStart) {
      throw new Error("Python sidecar dependencies are not bootstrapped and bootstrapOnStart is disabled.");
    }
    await installRequirements(venvPaths.python, requirementsPath, options.log);
    await import_promises.default.writeFile(venvPaths.stamp, requirementsHash, "utf8");
  }
  return venvPaths.python;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bootstrapPythonEnvironment,
  detectPythonVersion,
  getPythonExecutableCandidates,
  getVirtualEnvPaths,
  isSupportedPythonVersion,
  parsePythonVersion
});
//# sourceMappingURL=bootstrap.js.map
