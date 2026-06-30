import * as utils from "@iobroker/adapter-core";
import fs from "node:fs/promises";
import path from "node:path";
import {
    applyDeviceSnapshot,
    ensureBaseObjects,
    ensureDeviceObjects,
    normalizeDeviceChannelId,
} from "./lib/object-model";
import { bootstrapPythonEnvironment, detectPythonVersion } from "./lib/bootstrap";
import { checkPymammotionUpdates } from "./lib/pymammotion-metadata";
import { SidecarClient } from "./lib/sidecar-client";
import { NormalizedDeviceSnapshot, Primitive, SidecarCommand, SidecarNotificationMap } from "./lib/protocol";
import { buildZonePreferences, mergeZonePreference, parseAreaSelection, serializeAreaSelection } from "./lib/zone-selection";

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const RESTART_LIMIT = 5;
const RESTART_BACKOFF_BASE_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 60_000;

class MammotionPyMammotion extends utils.Adapter {
    private sidecar: SidecarClient | null = null;
    private readonly deviceSnapshots = new Map<string, NormalizedDeviceSnapshot>();
    private readonly deviceChannels = new Map<string, string>();
    private sidecarStopRequested = false;
    private restartTimer: ioBroker.Timeout | undefined;
    private restartAttempt = 0;
    private readonly restartHistory: number[] = [];
    private bootstrappedPython = "";

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "mammotion-pymammotion",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await ensureBaseObjects(this);
        await this.resetInfoStates();
        await this.subscribeStatesAsync("devices.*.commands.*");
        await this.subscribeStatesAsync("devices.*.controls.*");
        await this.subscribeStatesAsync("devices.*.configuration.*");
        await this.subscribeStatesAsync("devices.*.configuration.limits.*");
        await this.subscribeStatesAsync("devices.*.zones.*");
        await this.subscribeStatesAsync("diagnostics.*");

        try {
            const instanceDataDir = utils.getAbsoluteInstanceDataDir(this);
            const python = await bootstrapPythonEnvironment({
                adapterDir: this.adapterDir,
                instanceDataDir,
                preferredPython: this.config.pythonExecutable || undefined,
                bootstrapOnStart: this.config.bootstrapOnStart !== false,
                log: this.log,
            });
            this.bootstrappedPython = python;
            await this.setStateChangedAsync("info.pythonReady", true, true);
            await this.updatePythonAndPymammotionInfo(python);
            await this.startSidecar();
        } catch (error) {
            await this.handleFatalError(error, "Python bootstrap failed");
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        this.sidecarStopRequested = true;
        try {
            if (this.restartTimer) {
                this.clearTimeout(this.restartTimer);
                this.restartTimer = undefined;
            }
            if (this.sidecar) {
                await this.sidecar.shutdown().catch(() => undefined);
                await this.sidecar.stop().catch(() => undefined);
                this.sidecar = null;
            }
        } finally {
            callback();
        }
    }

    private async resetInfoStates(): Promise<void> {
        await this.setStateChangedAsync("info.connection", false, true);
        await this.setStateChangedAsync("info.sidecarReady", false, true);
        await this.setStateChangedAsync("info.pythonReady", false, true);
        await this.setStateChangedAsync("info.authenticated", false, true);
        await this.setStateChangedAsync("info.lastError", "", true);
        await this.setStateChangedAsync("info.lastSync", "", true);
        await this.setStateChangedAsync("info.pythonVersion", "", true);
        await this.setStateChangedAsync("info.pymammotionVersion", "", true);
        await this.setStateChangedAsync("info.pymammotionLatestVersion", "", true);
        await this.setStateChangedAsync("info.pymammotionLatestCompatibleVersion", "", true);
        await this.setStateChangedAsync("info.pymammotionLatestRequiresPython", "", true);
        await this.setStateChangedAsync("info.pymammotionPinnedRequiresPython", "", true);
        await this.setStateChangedAsync("info.pymammotionUpdateAvailable", false, true);
        await this.setStateChangedAsync("info.pythonUpgradeRequired", false, true);
        await this.setStateChangedAsync("info.lastLoginCode", 0, true);
        await this.setStateChangedAsync("info.lastLoginMessage", "", true);
    }

    private async updatePythonAndPymammotionInfo(pythonExecutable: string): Promise<void> {
        const pythonVersionInfo = await detectPythonVersion(pythonExecutable);
        const pythonVersion = pythonVersionInfo ? `${pythonVersionInfo.major}.${pythonVersionInfo.minor}.${pythonVersionInfo.patch}` : "";
        await this.setStateChangedAsync("info.pythonVersion", pythonVersion, true);

        if (!pythonVersion) {
            return;
        }

        try {
            const metadata = await checkPymammotionUpdates(this.adapterDir, `${pythonVersionInfo?.major}.${pythonVersionInfo?.minor}`);
            await this.setStateChangedAsync("info.pymammotionVersion", metadata.pinnedVersion, true);
            await this.setStateChangedAsync("info.pymammotionLatestVersion", metadata.latestVersion, true);
            await this.setStateChangedAsync("info.pymammotionLatestCompatibleVersion", metadata.latestCompatibleVersion, true);
            await this.setStateChangedAsync("info.pymammotionLatestRequiresPython", metadata.latestRequiresPython, true);
            await this.setStateChangedAsync("info.pymammotionPinnedRequiresPython", metadata.pinnedRequiresPython, true);
            await this.setStateChangedAsync("info.pymammotionUpdateAvailable", metadata.updateAvailable, true);
            await this.setStateChangedAsync("info.pythonUpgradeRequired", metadata.pythonUpgradeRequired, true);

            if (metadata.updateAvailable) {
                this.log.info(
                    `PyMammotion update info: pinned=${metadata.pinnedVersion}, latest=${metadata.latestVersion}, latestCompatible=${metadata.latestCompatibleVersion}`,
                );
            }
            if (metadata.pythonUpgradeRequired) {
                this.log.warn(
                    `Latest PyMammotion ${metadata.latestVersion} requires Python ${metadata.latestRequiresPython}; current Python is ${metadata.pythonVersion}`,
                );
            }
        } catch (error) {
            this.log.debug(`PyMammotion metadata check failed: ${String(error)}`);
        }
    }

    private async startSidecar(): Promise<void> {
        const sidecar = new SidecarClient({
            pythonExecutable: this.bootstrappedPython,
            scriptPath: path.join(this.adapterDir, "python-daemon", "sidecar.py"),
            workingDirectory: this.adapterDir,
            namespace: this.namespace,
            log: this.log,
        });
        this.sidecar = sidecar;
        this.sidecarStopRequested = false;
        this.attachSidecarHandlers(sidecar);

        await sidecar.start();
        await sidecar.health();
        await sidecar.bootstrap({
            instance_data_dir: utils.getAbsoluteInstanceDataDir(this),
            sidecar_log_level: this.config.sidecarLogLevel || "info",
            adapter_version: this.version || "0.0.0",
        });
        await this.setStateChangedAsync("info.sidecarReady", true, true);

        if (!this.config.email || !this.config.password) {
            const message = "Missing Mammotion credentials in adapter configuration";
            this.log.warn(message);
            await this.setStateChangedAsync("info.authenticated", false, true);
            await this.setStateChangedAsync("info.connection", false, true);
            await this.setStateChangedAsync("info.lastError", message, true);
            this.restartAttempt = 0;
            return;
        }

        const cachePath = path.join(utils.getAbsoluteInstanceDataDir(this), "pymammotion-cache.json");
        const loginResult = await sidecar.loginOrRestore({
            account: this.config.email,
            password: this.config.password,
            cache_path: cachePath,
            sidecar_log_level: this.config.sidecarLogLevel || "info",
        });
        await this.setStateChangedAsync("info.authenticated", Boolean(loginResult.authenticated), true);
        await this.refreshDeviceList();
        this.restartAttempt = 0;
        await this.setStateChangedAsync("info.lastError", "", true);
    }

    private attachSidecarHandlers(sidecar: SidecarClient): void {
        sidecar.on("notification", (message) => {
            void this.handleNotification(message.method, message.params).catch((error) => {
                this.log.warn(`Failed to process sidecar notification ${message.method}: ${String(error)}`);
            });
        });
        sidecar.on("stderr", (line) => {
            this.log.debug(`[sidecar-stderr] ${line}`);
        });
        sidecar.on("exit", ({ code, signal }) => {
            void this.handleSidecarExit(code, signal);
        });
    }

    private async handleSidecarExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
        await this.setStateChangedAsync("info.sidecarReady", false, true);
        await this.setStateChangedAsync("info.connection", false, true);
        if (this.sidecarStopRequested) {
            return;
        }

        const now = Date.now();
        this.restartHistory.push(now);
        while (this.restartHistory.length && now - this.restartHistory[0] > RESTART_WINDOW_MS) {
            this.restartHistory.shift();
        }
        if (this.restartHistory.length >= RESTART_LIMIT) {
            await this.handleFatalError(
                new Error(`Sidecar crashed too often (code=${code ?? "null"}, signal=${signal ?? "null"})`),
                "Sidecar restart limit reached",
            );
            return;
        }

        const delay = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** this.restartAttempt, RESTART_BACKOFF_MAX_MS);
        this.restartAttempt += 1;
        this.log.warn(`Sidecar exited unexpectedly. Restarting in ${delay} ms.`);
        this.restartTimer = this.setTimeout(() => {
            this.restartTimer = undefined;
            void this.restartSidecar();
        }, delay);
    }

    private async restartSidecar(): Promise<void> {
        if (this.sidecarStopRequested) {
            return;
        }
        try {
            if (this.sidecar) {
                await this.sidecar.stop().catch(() => undefined);
                this.sidecar = null;
            }
            await this.startSidecar();
        } catch (error) {
            await this.handleFatalError(error, "Sidecar restart failed");
        }
    }

    private async refreshDeviceList(): Promise<void> {
        if (!this.sidecar) {
            return;
        }
        const devices = await this.sidecar.listDevices();
        for (const deviceId of devices.devices) {
            const snapshotResult = await this.sidecar.getSnapshot({ device_id: deviceId });
            if (snapshotResult.snapshot) {
                await this.applySnapshot(snapshotResult.snapshot);
            }
        }
    }

    private async handleNotification(method: string, params: unknown): Promise<void> {
        switch (method) {
            case "ready": {
                await this.setStateChangedAsync("info.sidecarReady", true, true);
                break;
            }
            case "auth_state": {
                const payload = params as SidecarNotificationMap["auth_state"];
                await this.setStateChangedAsync("info.authenticated", payload.authenticated, true);
                if (!payload.authenticated && payload.message) {
                    await this.setStateChangedAsync("info.lastError", payload.message, true);
                }
                break;
            }
            case "device_discovered": {
                const payload = params as SidecarNotificationMap["device_discovered"];
                await this.ensureDeviceRegistration(payload.device_id, payload.name || payload.device_id);
                break;
            }
            case "device_snapshot": {
                const payload = params as SidecarNotificationMap["device_snapshot"];
                await this.applySnapshot(payload.snapshot);
                break;
            }
            case "device_online": {
                const payload = params as SidecarNotificationMap["device_online"];
                await this.updateDeviceConnection(payload.device_id, payload.online);
                break;
            }
            case "command_result": {
                const payload = params as SidecarNotificationMap["command_result"];
                if (!payload.ok && payload.message) {
                    await this.setStateChangedAsync("info.lastError", payload.message, true);
                }
                break;
            }
            case "log": {
                const payload = params as SidecarNotificationMap["log"];
                this.forwardSidecarLog(payload.level, payload.message);
                break;
            }
            case "error": {
                const payload = params as SidecarNotificationMap["error"];
                await this.setStateChangedAsync("info.lastError", payload.message, true);
                this.log.warn(`[sidecar-error] ${payload.message}`);
                break;
            }
        }
    }

    private forwardSidecarLog(level: string, message: string): void {
        switch (level) {
            case "debug":
                this.log.debug(`[sidecar] ${message}`);
                break;
            case "warning":
                this.log.warn(`[sidecar] ${message}`);
                break;
            case "error":
                this.log.error(`[sidecar] ${message}`);
                break;
            default:
                this.log.info(`[sidecar] ${message}`);
                break;
        }
    }

    private async ensureDeviceRegistration(deviceId: string, name: string): Promise<void> {
        const channelId = normalizeDeviceChannelId(deviceId);
        this.deviceChannels.set(channelId, deviceId);
        await ensureDeviceObjects(this, {
            id: deviceId,
            channelId,
            name,
        });
    }

    private async applySnapshot(snapshot: NormalizedDeviceSnapshot): Promise<void> {
        const previous = this.deviceSnapshots.get(snapshot.id);
        await this.ensureDeviceRegistration(snapshot.id, snapshot.name);
        await applyDeviceSnapshot(this, snapshot, previous);
        this.deviceSnapshots.set(snapshot.id, snapshot);
        await this.syncZoneConfiguration(snapshot);
        await this.setStateChangedAsync("info.lastSync", new Date().toISOString(), true);
        await this.updateConnectionState();
    }

    private async updateDeviceConnection(deviceId: string, online: boolean): Promise<void> {
        const snapshot = this.deviceSnapshots.get(deviceId);
        if (!snapshot) {
            return;
        }
        const updated: NormalizedDeviceSnapshot = {
            ...snapshot,
            status: {
                ...snapshot.status,
                online,
            },
        };
        await this.applySnapshot(updated);
    }

    private async updateConnectionState(): Promise<void> {
        const anyOnline = [...this.deviceSnapshots.values()].some((snapshot) => snapshot.status.online);
        await this.setStateChangedAsync("info.connection", anyOnline, true);
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack !== false) {
            return;
        }
        if (id === `${this.namespace}.diagnostics.testLogin`) {
            void this.runDiagnosticLogin("diagnostics.testLogin");
            return;
        }
        if (id === `${this.namespace}.diagnostics.clearCache`) {
            void this.clearSessionCache("diagnostics.clearCache");
            return;
        }
        const parsedConfiguration = this.parseConfigurationId(id);
        if (parsedConfiguration) {
            void this.executeConfigurationWrite(parsedConfiguration.deviceId, parsedConfiguration.key, state, parsedConfiguration.stateId);
            return;
        }
        const parsedZoneAction = this.parseZoneActionId(id);
        if (parsedZoneAction) {
            void this.executeZoneAction(parsedZoneAction.deviceId, parsedZoneAction.action, parsedZoneAction.stateId);
            return;
        }
        const parsedZoneValue = this.parseZoneValueId(id);
        if (parsedZoneValue) {
            void this.executeZoneValueWrite(parsedZoneValue.deviceId, parsedZoneValue.field, state, parsedZoneValue.stateId);
            return;
        }
        const parsedZoneConfig = this.parseZoneConfigId(id);
        if (parsedZoneConfig) {
            void this.executeZoneConfigWrite(
                parsedZoneConfig.deviceId,
                parsedZoneConfig.zoneHash,
                parsedZoneConfig.field,
                state,
                parsedZoneConfig.stateId,
            );
            return;
        }
        const parsed = this.parseCommandId(id);
        if (!parsed) {
            return;
        }
        if (state.val !== true) {
            void this.setStateChangedAsync(parsed.stateId, false, true);
            return;
        }
        void this.executeCommand(parsed.deviceId, parsed.command, parsed.stateId);
    }

    private parseConfigurationId(id: string): { deviceId: string; key: string; stateId: string } | null {
        const localId = id.replace(`${this.namespace}.`, "");
        const match = localId.match(/^devices\.([^.]+)\.configuration\.(?!limits\.)([^.]+)$/);
        if (!match) {
            return null;
        }
        return {
            deviceId: this.deviceChannels.get(match[1]) ?? match[1],
            key: match[2],
            stateId: localId,
        };
    }

    private parseZoneActionId(
        id: string,
    ): { deviceId: string; action: "startSelected" | "startAll" | "syncMap" | "syncAreaNames" | "syncPlans"; stateId: string } | null {
        const localId = id.replace(`${this.namespace}.`, "");
        const match = localId.match(/^devices\.([^.]+)\.zones\.(startSelected|startAll|syncMap|syncAreaNames|syncPlans)$/);
        if (!match) {
            return null;
        }
        return {
            deviceId: this.deviceChannels.get(match[1]) ?? match[1],
            action: match[2] as "startSelected" | "startAll" | "syncMap" | "syncAreaNames" | "syncPlans",
            stateId: localId,
        };
    }

    private parseZoneValueId(id: string): { deviceId: string; field: "selectedAreas" | "startPayload"; stateId: string } | null {
        const localId = id.replace(`${this.namespace}.`, "");
        const match = localId.match(/^devices\.([^.]+)\.zones\.(selectedAreas|startPayload)$/);
        if (!match) {
            return null;
        }
        return {
            deviceId: this.deviceChannels.get(match[1]) ?? match[1],
            field: match[2] as "selectedAreas" | "startPayload",
            stateId: localId,
        };
    }

    private parseZoneConfigId(
        id: string,
    ): { deviceId: string; zoneHash: number; field: "selected" | "order"; stateId: string } | null {
        const localId = id.replace(`${this.namespace}.`, "");
        const match = localId.match(/^devices\.([^.]+)\.zones\.zone_(\d+)\.config\.(selected|order)$/);
        if (!match) {
            return null;
        }
        return {
            deviceId: this.deviceChannels.get(match[1]) ?? match[1],
            zoneHash: Number(match[2]),
            field: match[3] as "selected" | "order",
            stateId: localId,
        };
    }

    private parseCommandId(id: string): { deviceId: string; command: SidecarCommand; stateId: string } | null {
        const localId = id.replace(`${this.namespace}.`, "");
        const match = localId.match(
            /^devices\.([^.]+)\.(commands|controls)\.(start|pause|stop|dock|refresh|leaveDock|cancelTask|nudgeForward|nudgeBack|nudgeLeft|nudgeRight|bladeOn|bladeOff)$/,
        );
        if (!match) {
            return null;
        }
        const deviceId = this.deviceChannels.get(match[1]) ?? match[1];
        return {
            deviceId,
            command: match[3] as SidecarCommand,
            stateId: localId,
        };
    }

    private async executeCommand(deviceId: string, command: SidecarCommand, stateId: string): Promise<void> {
        try {
            if (!this.sidecar) {
                throw new Error("Sidecar is not running");
            }
            await this.sidecar.sendCommand({ device_id: deviceId, command });
            if (command === "refresh") {
                const snapshotResult = await this.sidecar.getSnapshot({ device_id: deviceId });
                if (snapshotResult.snapshot) {
                    await this.applySnapshot(snapshotResult.snapshot);
                }
            }
        } catch (error) {
            await this.setStateChangedAsync("info.lastError", String(error), true);
            this.log.warn(`Command ${command} failed for ${deviceId}: ${String(error)}`);
        } finally {
            await this.setStateChangedAsync(stateId, false, true);
        }
    }

    private async executeConfigurationWrite(
        deviceId: string,
        key: string,
        state: ioBroker.State,
        stateId: string,
    ): Promise<void> {
        try {
            if (!this.sidecar) {
                throw new Error("Sidecar is not running");
            }
            await this.sidecar.setSetting({
                device_id: deviceId,
                key,
                value: (state.val as Primitive) ?? null,
            });
            await this.setStateChangedAsync(stateId, state.val as ioBroker.StateValue, true);
            const snapshotResult = await this.sidecar.getSnapshot({ device_id: deviceId });
            if (snapshotResult.snapshot) {
                await this.applySnapshot(snapshotResult.snapshot);
            }
        } catch (error) {
            await this.setStateChangedAsync("info.lastError", String(error), true);
            this.log.warn(`Configuration write ${key} failed for ${deviceId}: ${String(error)}`);
        }
    }

    private async executeZoneAction(
        deviceId: string,
        action: "startSelected" | "startAll" | "syncMap" | "syncAreaNames" | "syncPlans",
        stateId: string,
    ): Promise<void> {
        try {
            if (!this.sidecar) {
                throw new Error("Sidecar is not running");
            }

            if (action === "syncMap" || action === "syncAreaNames" || action === "syncPlans") {
                await this.sidecar.zoneAction({
                    device_id: deviceId,
                    action,
                });
            } else {
                const channelId = normalizeDeviceChannelId(deviceId);
                const selectedState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
                const payloadState = await this.getStateAsync(`devices.${channelId}.zones.startPayload`);
                const payload = this.parseZoneStartPayload(payloadState?.val);
                const selectedAreas =
                    action === "startAll"
                        ? []
                        : parseAreaSelection(payload?.areas ?? selectedState?.val);
                const overrides = payload ? this.extractZoneOverrides(payload) : undefined;
                const startImmediately =
                    typeof payload?.startImmediately === "boolean" ? Boolean(payload.startImmediately) : true;

                await this.sidecar.startAreas({
                    device_id: deviceId,
                    area_hashes: selectedAreas,
                    overrides,
                    start_immediately: startImmediately,
                });
            }

            const snapshotResult = await this.sidecar.getSnapshot({ device_id: deviceId });
            if (snapshotResult.snapshot) {
                await this.applySnapshot(snapshotResult.snapshot);
            }
        } catch (error) {
            await this.setStateChangedAsync("info.lastError", String(error), true);
            this.log.warn(`Zone action ${action} failed for ${deviceId}: ${String(error)}`);
        } finally {
            await this.setStateChangedAsync(stateId, false, true);
        }
    }

    private parseZoneStartPayload(
        value: unknown,
    ): { areas?: unknown; startImmediately?: unknown; [key: string]: unknown } | null {
        const text = String(value ?? "").trim();
        if (!text) {
            return null;
        }
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as { areas?: unknown; startImmediately?: unknown; [key: string]: unknown };
            }
        } catch (error) {
            this.log.debug(`Ignoring invalid zone payload JSON: ${String(error)}`);
        }
        return null;
    }

    private extractZoneOverrides(payload: Record<string, unknown>): Record<string, Primitive> | undefined {
        const overrides: Record<string, Primitive> = {};
        for (const [key, value] of Object.entries(payload)) {
            if (key === "areas" || key === "startImmediately") {
                continue;
            }
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
                overrides[key] = value;
            }
        }
        return Object.keys(overrides).length ? overrides : undefined;
    }

    private async executeZoneValueWrite(
        deviceId: string,
        field: "selectedAreas" | "startPayload",
        state: ioBroker.State,
        stateId: string,
    ): Promise<void> {
        try {
            if (field === "selectedAreas") {
                const snapshot = this.deviceSnapshots.get(deviceId);
                const knownZoneHashes = snapshot?.zones.map((zone) => zone.hash) ?? [];
                let selectedAreas = parseAreaSelection(state.val);
                if (knownZoneHashes.length) {
                    selectedAreas = selectedAreas.filter((hash) => knownZoneHashes.includes(hash));
                }
                const serialized = serializeAreaSelection(selectedAreas);
                await this.setStateChangedAsync(stateId, serialized, true);
                await this.syncConfiguredZonesForDevice(deviceId, selectedAreas);
                return;
            }

            await this.setStateChangedAsync(stateId, state.val as ioBroker.StateValue, true);
        } catch (error) {
            await this.setStateChangedAsync("info.lastError", String(error), true);
            this.log.warn(`Zone value write ${field} failed for ${deviceId}: ${String(error)}`);
        }
    }

    private async executeZoneConfigWrite(
        deviceId: string,
        zoneHash: number,
        field: "selected" | "order",
        state: ioBroker.State,
        stateId: string,
    ): Promise<void> {
        try {
            const channelId = normalizeDeviceChannelId(deviceId);
            const selectedAreasState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
            let selectedAreas = parseAreaSelection(selectedAreasState?.val);

            if (field === "selected") {
                const orderState = await this.getStateAsync(`devices.${channelId}.zones.zone_${zoneHash}.config.order`);
                selectedAreas = mergeZonePreference(selectedAreas, zoneHash, Boolean(state.val), Number(orderState?.val ?? 0));
                await this.setStateChangedAsync(stateId, Boolean(state.val), true);
            } else {
                const preferredOrder = Number(state.val ?? 0);
                const selectedState = await this.getStateAsync(`devices.${channelId}.zones.zone_${zoneHash}.config.selected`);
                const selected = preferredOrder > 0 ? true : Boolean(selectedState?.val);
                selectedAreas = mergeZonePreference(selectedAreas, zoneHash, selected, preferredOrder);
                await this.setStateChangedAsync(stateId, preferredOrder > 0 ? Math.trunc(preferredOrder) : 0, true);
            }

            const serialized = serializeAreaSelection(selectedAreas);
            await this.setStateChangedAsync(`devices.${channelId}.zones.selectedAreas`, serialized, true);
            await this.syncConfiguredZonesForDevice(deviceId, selectedAreas);
        } catch (error) {
            await this.setStateChangedAsync("info.lastError", String(error), true);
            this.log.warn(`Zone config write ${field} failed for ${deviceId}/${zoneHash}: ${String(error)}`);
        }
    }

    private async syncZoneConfiguration(snapshot: NormalizedDeviceSnapshot): Promise<void> {
        const channelId = normalizeDeviceChannelId(snapshot.id);
        const selectedAreasState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
        const knownZoneHashes = snapshot.zones.map((zone) => zone.hash);

        let configuredAreas = parseAreaSelection(selectedAreasState?.val).filter((hash) => knownZoneHashes.includes(hash));
        if (!configuredAreas.length && knownZoneHashes.length) {
            configuredAreas = [...knownZoneHashes];
            await this.setStateChangedAsync(`devices.${channelId}.zones.selectedAreas`, serializeAreaSelection(configuredAreas), true);
        }

        await this.syncConfiguredZonesForDevice(snapshot.id, configuredAreas);
    }

    private async syncConfiguredZonesForDevice(deviceId: string, configuredAreas: number[]): Promise<void> {
        const snapshot = this.deviceSnapshots.get(deviceId);
        if (!snapshot) {
            return;
        }
        const channelId = normalizeDeviceChannelId(deviceId);
        const preferences = buildZonePreferences(
            snapshot.zones.map((zone) => zone.hash),
            configuredAreas,
        );
        for (const entry of preferences) {
            await this.setStateChangedAsync(
                `devices.${channelId}.zones.zone_${entry.hash}.config.selected`,
                entry.selected,
                true,
            );
            await this.setStateChangedAsync(
                `devices.${channelId}.zones.zone_${entry.hash}.config.order`,
                entry.order,
                true,
            );
        }
    }

    private async runDiagnosticLogin(stateId: string): Promise<void> {
        try {
            if (!this.sidecar) {
                throw new Error("Sidecar is not running");
            }
            if (!this.config.email || !this.config.password) {
                throw new Error("Missing Mammotion credentials in adapter configuration");
            }
            const result = await this.sidecar.diagnosticLogin({
                account: this.config.email,
                password: this.config.password,
            });
            await this.setStateChangedAsync("info.lastLoginCode", result.code, true);
            await this.setStateChangedAsync("info.lastLoginMessage", result.message, true);
            if (!result.ok) {
                await this.setStateChangedAsync("info.lastError", `Diagnostic login failed: ${result.message}`, true);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.setStateChangedAsync("info.lastLoginMessage", message, true);
            await this.setStateChangedAsync("info.lastError", `Diagnostic login failed: ${message}`, true);
        } finally {
            await this.setStateChangedAsync(stateId, false, true);
        }
    }

    private async clearSessionCache(stateId: string): Promise<void> {
        try {
            const cachePath = path.join(utils.getAbsoluteInstanceDataDir(this), "pymammotion-cache.json");
            await fs.rm(cachePath, { force: true });
            await this.setStateChangedAsync("info.lastError", "", true);
            await this.setStateChangedAsync("info.lastLoginMessage", "Session cache cleared", true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.setStateChangedAsync("info.lastError", `Clear cache failed: ${message}`, true);
        } finally {
            await this.setStateChangedAsync(stateId, false, true);
        }
    }

    private async handleFatalError(error: unknown, prefix: string): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`${prefix}: ${message}`);
        await this.setStateChangedAsync("info.lastError", `${prefix}: ${message}`, true);
        await this.setStateChangedAsync("info.connection", false, true);
        await this.setStateChangedAsync("info.sidecarReady", false, true);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new MammotionPyMammotion(options);
} else {
    (() => new MammotionPyMammotion())();
}
