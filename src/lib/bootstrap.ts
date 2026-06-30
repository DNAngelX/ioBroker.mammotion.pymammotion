import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface BootstrapOptions {
    adapterDir: string;
    instanceDataDir: string;
    preferredPython?: string;
    bootstrapOnStart: boolean;
    log: ioBroker.Logger;
}

export interface PythonVersionInfo {
    executable: string;
    major: number;
    minor: number;
    patch: number;
    raw: string;
}

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 13;

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter((value) => Boolean(value)))];
}

function execFileAsync(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { cwd }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

export function parsePythonVersion(raw: string, executable: string): PythonVersionInfo | null {
    const match = raw.trim().match(/^Python\s+(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
        return null;
    }
    return {
        executable,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        raw: raw.trim(),
    };
}

export function isSupportedPythonVersion(version: PythonVersionInfo | null): version is PythonVersionInfo {
    return Boolean(version && version.major === MIN_PYTHON_MAJOR && version.minor >= MIN_PYTHON_MINOR && version.major < 4);
}

export function getVirtualEnvPaths(instanceDataDir: string): { root: string; python: string; stamp: string } {
    const root = path.join(instanceDataDir, "python-sidecar");
    return {
        root,
        python:
            process.platform === "win32" ? path.join(root, "Scripts", "python.exe") : path.join(root, "bin", "python"),
        stamp: path.join(root, ".requirements.sha1"),
    };
}

function getDirectoryPythonCandidates(directory: string, platform: NodeJS.Platform): string[] {
    if (platform === "win32") {
        return [path.join(directory, "python.exe"), path.join(directory, "python3.exe")];
    }

    return [
        path.join(directory, "python3.13"),
        path.join(directory, "python3.12"),
        path.join(directory, "python3"),
        path.join(directory, "python"),
        path.join(directory, "bin", "python3.13"),
        path.join(directory, "bin", "python3.12"),
        path.join(directory, "bin", "python3"),
        path.join(directory, "bin", "python"),
    ];
}

export function getPythonExecutableCandidates(
    preferredPython?: string,
    platform: NodeJS.Platform = process.platform,
): string[] {
    const candidates: string[] = [];
    const trimmedPreferred = preferredPython?.trim();

    if (trimmedPreferred) {
        candidates.push(trimmedPreferred);

        const looksLikeDirectory =
            !path.extname(trimmedPreferred) && !path.basename(trimmedPreferred).toLowerCase().startsWith("python");
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
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "python.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python312", "python.exe"),
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
                "/usr/local/opt/python@3.12/bin/python3.12",
            );
        }

        candidates.push("/usr/local/bin/python3.13", "/usr/local/bin/python3.12", "/usr/bin/python3.13", "/usr/bin/python3.12");
    }

    return uniqueStrings(candidates);
}

export async function detectPythonVersion(executable: string): Promise<PythonVersionInfo | null> {
    try {
        const { stdout, stderr } = await execFileAsync(executable, ["--version"]);
        return parsePythonVersion(stdout || stderr, executable);
    } catch {
        return null;
    }
}

async function resolvePythonExecutable(preferredPython?: string): Promise<PythonVersionInfo> {
    const candidates = getPythonExecutableCandidates(preferredPython);
    for (const candidate of candidates) {
        const version = await detectPythonVersion(candidate);
        if (isSupportedPythonVersion(version)) {
            return version;
        }
    }
    const configuredHint = preferredPython?.trim() ? ` Checked configured path "${preferredPython.trim()}" first.` : "";
    throw new Error(`Python 3.13+ not found.${configuredHint} Configure pythonExecutable or install python3.13.`);
}

async function installRequirements(venvPython: string, requirementsPath: string, log: ioBroker.Logger): Promise<void> {
    log.info("Installing PyMammotion sidecar dependencies");
    await execFileAsync(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
    await execFileAsync(venvPython, ["-m", "pip", "install", "-r", requirementsPath]);
}

export async function bootstrapPythonEnvironment(options: BootstrapOptions): Promise<string> {
    const version = await resolvePythonExecutable(options.preferredPython);
    const requirementsPath = path.join(options.adapterDir, "python-daemon", "requirements.txt");
    const requirementsContent = await fs.readFile(requirementsPath, "utf8");
    const requirementsHash = createHash("sha1").update(requirementsContent).digest("hex");
    const venvPaths = getVirtualEnvPaths(options.instanceDataDir);

    await fs.mkdir(options.instanceDataDir, { recursive: true });

    let venvExists = existsSync(venvPaths.python);
    if (venvExists) {
        const venvVersion = await detectPythonVersion(venvPaths.python);
        const venvSupported = isSupportedPythonVersion(venvVersion);
        const venvMatchesSelected =
            venvVersion &&
            venvVersion.major === version.major &&
            venvVersion.minor === version.minor;

        if (!venvSupported || !venvMatchesSelected) {
            if (!options.bootstrapOnStart) {
                throw new Error("Python sidecar virtual environment uses an incompatible Python version.");
            }
            options.log.info(
                `Recreating Python virtual environment because existing venv uses ${venvVersion?.raw ?? "unknown"} and selected interpreter is ${version.raw}`,
            );
            await fs.rm(venvPaths.root, { recursive: true, force: true });
            venvExists = false;
        }
    }

    if (!venvExists) {
        if (!options.bootstrapOnStart) {
            throw new Error("Python sidecar virtual environment is missing and bootstrapOnStart is disabled.");
        }
        options.log.info(`Creating Python virtual environment with ${version.raw}`);
        await execFileAsync(version.executable, ["-m", "venv", venvPaths.root]);
        // Ensure pip is available — some system Python packages omit it from venvs
        try {
            await execFileAsync(venvPaths.python, ["-m", "ensurepip", "--upgrade"]);
        } catch {
            options.log.debug("ensurepip not available or pip already present, continuing");
        }
    }

    const stampExists = existsSync(venvPaths.stamp);
    const installedHash = stampExists ? await fs.readFile(venvPaths.stamp, "utf8") : "";
    if (!venvExists || installedHash.trim() !== requirementsHash) {
        if (!options.bootstrapOnStart) {
            throw new Error("Python sidecar dependencies are not bootstrapped and bootstrapOnStart is disabled.");
        }
        await installRequirements(venvPaths.python, requirementsPath, options.log);
        await fs.writeFile(venvPaths.stamp, requirementsHash, "utf8");
    }

    return venvPaths.python;
}
