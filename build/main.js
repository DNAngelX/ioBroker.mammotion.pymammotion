"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var utils = __toESM(require("@iobroker/adapter-core"));
var import_promises = __toESM(require("node:fs/promises"));
var import_node_path = __toESM(require("node:path"));
var import_object_model = require("./lib/object-model");
var import_bootstrap = require("./lib/bootstrap");
var import_pymammotion_metadata = require("./lib/pymammotion-metadata");
var import_sidecar_client = require("./lib/sidecar-client");
var import_zone_selection = require("./lib/zone-selection");
const RESTART_WINDOW_MS = 10 * 60 * 1e3;
const RESTART_LIMIT = 5;
const RESTART_BACKOFF_BASE_MS = 2e3;
const RESTART_BACKOFF_MAX_MS = 6e4;
const SESSION_WATCHDOG_INTERVAL_MS = 6e4;
const SESSION_WATCHDOG_FAILURE_LIMIT = 2;
const SESSION_WATCHDOG_OFFLINE_LIMIT = 3;
const SESSION_RECOVERY_COOLDOWN_MS = 9e4;
class MammotionPyMammotion extends utils.Adapter {
  sidecar = null;
  deviceSnapshots = /* @__PURE__ */ new Map();
  deviceChannels = /* @__PURE__ */ new Map();
  sidecarStopRequested = false;
  controlledSidecarExit = false;
  restartTimer;
  watchdogTimer;
  restartAttempt = 0;
  restartHistory = [];
  bootstrappedPython = "";
  sessionValidationFailures = 0;
  sessionOfflineChecks = 0;
  sessionRecoveryInProgress = false;
  lastSessionRecoveryAt = 0;
  constructor(options = {}) {
    super({
      ...options,
      name: "mammotion-pymammotion"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await (0, import_object_model.ensureBaseObjects)(this);
    await this.resetInfoStates();
    await this.subscribeStatesAsync("devices.*.commands.*");
    await this.subscribeStatesAsync("devices.*.controls.*");
    await this.subscribeStatesAsync("devices.*.configuration.*");
    await this.subscribeStatesAsync("devices.*.configuration.limits.*");
    await this.subscribeStatesAsync("devices.*.zones.*");
    await this.subscribeStatesAsync("diagnostics.*");
    try {
      const instanceDataDir = utils.getAbsoluteInstanceDataDir(this);
      const python = await (0, import_bootstrap.bootstrapPythonEnvironment)({
        adapterDir: this.adapterDir,
        instanceDataDir,
        preferredPython: this.config.pythonExecutable || void 0,
        bootstrapOnStart: this.config.bootstrapOnStart !== false,
        log: this.log
      });
      this.bootstrappedPython = python;
      await this.setStateChangedAsync("info.pythonReady", true, true);
      await this.updatePythonAndPymammotionInfo(python);
      await this.startSidecar();
    } catch (error) {
      await this.handleFatalError(error, "Python bootstrap failed");
    }
  }
  async onUnload(callback) {
    this.sidecarStopRequested = true;
    try {
      if (this.restartTimer) {
        this.clearTimeout(this.restartTimer);
        this.restartTimer = void 0;
      }
      this.stopSessionWatchdog();
      if (this.sidecar) {
        await this.sidecar.shutdown().catch(() => void 0);
        await this.sidecar.stop().catch(() => void 0);
        this.sidecar = null;
      }
    } finally {
      callback();
    }
  }
  async resetInfoStates() {
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
  async updatePythonAndPymammotionInfo(pythonExecutable) {
    const pythonVersionInfo = await (0, import_bootstrap.detectPythonVersion)(pythonExecutable);
    const pythonVersion = pythonVersionInfo ? `${pythonVersionInfo.major}.${pythonVersionInfo.minor}.${pythonVersionInfo.patch}` : "";
    await this.setStateChangedAsync("info.pythonVersion", pythonVersion, true);
    if (!pythonVersion) {
      return;
    }
    try {
      const metadata = await (0, import_pymammotion_metadata.checkPymammotionUpdates)(this.adapterDir, `${pythonVersionInfo == null ? void 0 : pythonVersionInfo.major}.${pythonVersionInfo == null ? void 0 : pythonVersionInfo.minor}`);
      await this.setStateChangedAsync("info.pymammotionVersion", metadata.pinnedVersion, true);
      await this.setStateChangedAsync("info.pymammotionLatestVersion", metadata.latestVersion, true);
      await this.setStateChangedAsync("info.pymammotionLatestCompatibleVersion", metadata.latestCompatibleVersion, true);
      await this.setStateChangedAsync("info.pymammotionLatestRequiresPython", metadata.latestRequiresPython, true);
      await this.setStateChangedAsync("info.pymammotionPinnedRequiresPython", metadata.pinnedRequiresPython, true);
      await this.setStateChangedAsync("info.pymammotionUpdateAvailable", metadata.updateAvailable, true);
      await this.setStateChangedAsync("info.pythonUpgradeRequired", metadata.pythonUpgradeRequired, true);
      if (metadata.updateAvailable) {
        this.log.info(
          `PyMammotion update info: pinned=${metadata.pinnedVersion}, latest=${metadata.latestVersion}, latestCompatible=${metadata.latestCompatibleVersion}`
        );
      }
      if (metadata.pythonUpgradeRequired) {
        this.log.warn(
          `Latest PyMammotion ${metadata.latestVersion} requires Python ${metadata.latestRequiresPython}; current Python is ${metadata.pythonVersion}`
        );
      }
    } catch (error) {
      this.log.debug(`PyMammotion metadata check failed: ${String(error)}`);
    }
  }
  async startSidecar() {
    const sidecar = new import_sidecar_client.SidecarClient({
      pythonExecutable: this.bootstrappedPython,
      scriptPath: import_node_path.default.join(this.adapterDir, "python-daemon", "sidecar.py"),
      workingDirectory: this.adapterDir,
      namespace: this.namespace,
      log: this.log
    });
    this.sidecar = sidecar;
    this.sidecarStopRequested = false;
    this.attachSidecarHandlers(sidecar);
    await sidecar.start();
    await sidecar.health();
    await sidecar.bootstrap({
      instance_data_dir: utils.getAbsoluteInstanceDataDir(this),
      sidecar_log_level: this.config.sidecarLogLevel || "info",
      adapter_version: this.version || "0.0.0"
    });
    await this.setStateChangedAsync("info.sidecarReady", true, true);
    if (!this.config.email || !this.config.password) {
      const message = "Missing Mammotion credentials in adapter configuration";
      this.log.warn(message);
      await this.setStateChangedAsync("info.authenticated", false, true);
      await this.setStateChangedAsync("info.connection", false, true);
      await this.setStateChangedAsync("info.lastError", message, true);
      this.restartAttempt = 0;
      this.stopSessionWatchdog();
      return;
    }
    const cachePath = import_node_path.default.join(utils.getAbsoluteInstanceDataDir(this), "pymammotion-cache.json");
    const loginResult = await sidecar.loginOrRestore({
      account: this.config.email,
      password: this.config.password,
      cache_path: cachePath,
      sidecar_log_level: this.config.sidecarLogLevel || "info"
    });
    await this.setStateChangedAsync("info.authenticated", Boolean(loginResult.authenticated), true);
    await this.refreshDeviceList();
    this.restartAttempt = 0;
    this.sessionValidationFailures = 0;
    this.sessionOfflineChecks = 0;
    await this.setStateChangedAsync("info.lastError", "", true);
    this.ensureSessionWatchdog();
  }
  attachSidecarHandlers(sidecar) {
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
  async handleSidecarExit(code, signal) {
    await this.setStateChangedAsync("info.sidecarReady", false, true);
    await this.setStateChangedAsync("info.connection", false, true);
    this.stopSessionWatchdog();
    if (this.controlledSidecarExit) {
      this.controlledSidecarExit = false;
      return;
    }
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
        new Error(`Sidecar crashed too often (code=${code != null ? code : "null"}, signal=${signal != null ? signal : "null"})`),
        "Sidecar restart limit reached"
      );
      return;
    }
    const delay = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** this.restartAttempt, RESTART_BACKOFF_MAX_MS);
    this.restartAttempt += 1;
    this.log.warn(`Sidecar exited unexpectedly. Restarting in ${delay} ms.`);
    this.restartTimer = this.setTimeout(() => {
      this.restartTimer = void 0;
      void this.restartSidecar();
    }, delay);
  }
  async restartSidecar() {
    if (this.sidecarStopRequested) {
      return;
    }
    try {
      if (this.sidecar) {
        await this.sidecar.stop().catch(() => void 0);
        this.sidecar = null;
      }
      await this.startSidecar();
    } catch (error) {
      await this.handleFatalError(error, "Sidecar restart failed");
    }
  }
  ensureSessionWatchdog() {
    if (this.watchdogTimer) {
      return;
    }
    this.watchdogTimer = this.setInterval(() => {
      void this.runSessionWatchdog();
    }, SESSION_WATCHDOG_INTERVAL_MS);
  }
  stopSessionWatchdog() {
    if (!this.watchdogTimer) {
      return;
    }
    this.clearInterval(this.watchdogTimer);
    this.watchdogTimer = void 0;
  }
  async runSessionWatchdog() {
    if (!this.sidecar || this.sidecarStopRequested || this.sessionRecoveryInProgress || !this.config.email || !this.config.password) {
      return;
    }
    try {
      const validation = await this.sidecar.validateConnection({ probe: true });
      if (!validation.authenticated) {
        throw new Error(validation.message || "Sidecar is not authenticated");
      }
      this.sessionValidationFailures = 0;
      if (validation.device_count > 0 && validation.online_devices === 0) {
        this.sessionOfflineChecks += 1;
        this.log.debug(
          `Session watchdog: no online devices (${this.sessionOfflineChecks}/${SESSION_WATCHDOG_OFFLINE_LIMIT}), probe=${validation.probe}, lastSnapshotAge=${validation.last_snapshot_age_sec}s`
        );
        if (this.sessionOfflineChecks >= SESSION_WATCHDOG_OFFLINE_LIMIT) {
          await this.triggerSessionRecovery("all devices remained offline");
        }
        return;
      }
      this.sessionOfflineChecks = 0;
    } catch (error) {
      this.sessionValidationFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.setStateChangedAsync("info.lastError", `Session watchdog: ${message}`, true);
      this.log.warn(
        `Session watchdog validation failed (${this.sessionValidationFailures}/${SESSION_WATCHDOG_FAILURE_LIMIT}): ${message}`
      );
      if (this.sessionValidationFailures >= SESSION_WATCHDOG_FAILURE_LIMIT) {
        await this.triggerSessionRecovery(`watchdog validation failed: ${message}`);
      }
    }
  }
  async triggerSessionRecovery(reason) {
    if (this.sessionRecoveryInProgress || this.sidecarStopRequested) {
      return;
    }
    const now = Date.now();
    if (now - this.lastSessionRecoveryAt < SESSION_RECOVERY_COOLDOWN_MS) {
      this.log.debug(`Skipping session recovery during cooldown: ${reason}`);
      return;
    }
    this.sessionRecoveryInProgress = true;
    this.lastSessionRecoveryAt = now;
    this.stopSessionWatchdog();
    this.log.warn(`Recovering Mammotion session: ${reason}`);
    await this.setStateChangedAsync("info.connection", false, true);
    await this.setStateChangedAsync("info.authenticated", false, true);
    try {
      if (this.sidecar) {
        this.controlledSidecarExit = true;
        await this.sidecar.shutdown().catch(() => void 0);
        await this.sidecar.stop().catch(() => void 0);
        this.sidecar = null;
      }
      await this.startSidecar();
    } catch (error) {
      await this.handleFatalError(error, `Session recovery failed (${reason})`);
    } finally {
      this.sessionValidationFailures = 0;
      this.sessionOfflineChecks = 0;
      this.sessionRecoveryInProgress = false;
    }
  }
  async refreshDeviceList() {
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
  async handleNotification(method, params) {
    switch (method) {
      case "ready": {
        await this.setStateChangedAsync("info.sidecarReady", true, true);
        break;
      }
      case "auth_state": {
        const payload = params;
        await this.setStateChangedAsync("info.authenticated", payload.authenticated, true);
        if (!payload.authenticated && payload.message) {
          await this.setStateChangedAsync("info.lastError", payload.message, true);
          void this.triggerSessionRecovery(`sidecar authentication lost: ${payload.message}`);
        }
        break;
      }
      case "device_discovered": {
        const payload = params;
        await this.ensureDeviceRegistration(payload.device_id, payload.name || payload.device_id);
        break;
      }
      case "device_snapshot": {
        const payload = params;
        await this.applySnapshot(payload.snapshot);
        break;
      }
      case "device_online": {
        const payload = params;
        await this.updateDeviceConnection(payload.device_id, payload.online);
        break;
      }
      case "command_result": {
        const payload = params;
        if (!payload.ok && payload.message) {
          await this.setStateChangedAsync("info.lastError", payload.message, true);
        }
        break;
      }
      case "log": {
        const payload = params;
        this.forwardSidecarLog(payload.level, payload.message);
        break;
      }
      case "error": {
        const payload = params;
        await this.setStateChangedAsync("info.lastError", payload.message, true);
        this.log.warn(`[sidecar-error] ${payload.message}`);
        break;
      }
    }
  }
  forwardSidecarLog(level, message) {
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
  async ensureDeviceRegistration(deviceId, name) {
    const channelId = (0, import_object_model.normalizeDeviceChannelId)(deviceId);
    this.deviceChannels.set(channelId, deviceId);
    await (0, import_object_model.ensureDeviceObjects)(this, {
      id: deviceId,
      channelId,
      name
    });
  }
  async applySnapshot(snapshot) {
    const previous = this.deviceSnapshots.get(snapshot.id);
    await this.ensureDeviceRegistration(snapshot.id, snapshot.name);
    await (0, import_object_model.applyDeviceSnapshot)(this, snapshot, previous);
    this.deviceSnapshots.set(snapshot.id, snapshot);
    await this.syncZoneConfiguration(snapshot);
    await this.setStateChangedAsync("info.lastSync", (/* @__PURE__ */ new Date()).toISOString(), true);
    await this.updateConnectionState();
  }
  async updateDeviceConnection(deviceId, online) {
    const snapshot = this.deviceSnapshots.get(deviceId);
    if (!snapshot) {
      return;
    }
    const updated = {
      ...snapshot,
      status: {
        ...snapshot.status,
        online
      }
    };
    await this.applySnapshot(updated);
  }
  async updateConnectionState() {
    const anyOnline = [...this.deviceSnapshots.values()].some((snapshot) => snapshot.status.online);
    await this.setStateChangedAsync("info.connection", anyOnline, true);
  }
  onStateChange(id, state) {
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
        parsedZoneConfig.stateId
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
  parseConfigurationId(id) {
    var _a;
    const localId = id.replace(`${this.namespace}.`, "");
    const match = localId.match(/^devices\.([^.]+)\.configuration\.(?!limits\.)([^.]+)$/);
    if (!match) {
      return null;
    }
    return {
      deviceId: (_a = this.deviceChannels.get(match[1])) != null ? _a : match[1],
      key: match[2],
      stateId: localId
    };
  }
  parseZoneActionId(id) {
    var _a;
    const localId = id.replace(`${this.namespace}.`, "");
    const match = localId.match(/^devices\.([^.]+)\.zones\.(startSelected|startAll|syncMap|syncAreaNames|syncPlans)$/);
    if (!match) {
      return null;
    }
    return {
      deviceId: (_a = this.deviceChannels.get(match[1])) != null ? _a : match[1],
      action: match[2],
      stateId: localId
    };
  }
  parseZoneValueId(id) {
    var _a;
    const localId = id.replace(`${this.namespace}.`, "");
    const match = localId.match(/^devices\.([^.]+)\.zones\.(selectedAreas|startPayload)$/);
    if (!match) {
      return null;
    }
    return {
      deviceId: (_a = this.deviceChannels.get(match[1])) != null ? _a : match[1],
      field: match[2],
      stateId: localId
    };
  }
  parseZoneConfigId(id) {
    var _a;
    const localId = id.replace(`${this.namespace}.`, "");
    const match = localId.match(/^devices\.([^.]+)\.zones\.zone_(\d+)\.config\.(selected|order)$/);
    if (!match) {
      return null;
    }
    return {
      deviceId: (_a = this.deviceChannels.get(match[1])) != null ? _a : match[1],
      zoneHash: Number(match[2]),
      field: match[3],
      stateId: localId
    };
  }
  parseCommandId(id) {
    var _a;
    const localId = id.replace(`${this.namespace}.`, "");
    const match = localId.match(
      /^devices\.([^.]+)\.(commands|controls)\.(start|pause|stop|dock|refresh|leaveDock|cancelTask|nudgeForward|nudgeBack|nudgeLeft|nudgeRight|bladeOn|bladeOff)$/
    );
    if (!match) {
      return null;
    }
    const deviceId = (_a = this.deviceChannels.get(match[1])) != null ? _a : match[1];
    return {
      deviceId,
      command: match[3],
      stateId: localId
    };
  }
  async executeCommand(deviceId, command, stateId) {
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
  async executeConfigurationWrite(deviceId, key, state, stateId) {
    var _a;
    try {
      if (!this.sidecar) {
        throw new Error("Sidecar is not running");
      }
      await this.sidecar.setSetting({
        device_id: deviceId,
        key,
        value: (_a = state.val) != null ? _a : null
      });
      await this.setStateChangedAsync(stateId, state.val, true);
      const snapshotResult = await this.sidecar.getSnapshot({ device_id: deviceId });
      if (snapshotResult.snapshot) {
        await this.applySnapshot(snapshotResult.snapshot);
      }
    } catch (error) {
      await this.setStateChangedAsync("info.lastError", String(error), true);
      this.log.warn(`Configuration write ${key} failed for ${deviceId}: ${String(error)}`);
    }
  }
  async executeZoneAction(deviceId, action, stateId) {
    var _a;
    try {
      if (!this.sidecar) {
        throw new Error("Sidecar is not running");
      }
      if (action === "syncMap" || action === "syncAreaNames" || action === "syncPlans") {
        await this.sidecar.zoneAction({
          device_id: deviceId,
          action
        });
      } else {
        const channelId = (0, import_object_model.normalizeDeviceChannelId)(deviceId);
        const selectedState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
        const payloadState = await this.getStateAsync(`devices.${channelId}.zones.startPayload`);
        const payload = this.parseZoneStartPayload(payloadState == null ? void 0 : payloadState.val);
        const selectedAreas = action === "startAll" ? [] : (0, import_zone_selection.parseAreaSelection)((_a = payload == null ? void 0 : payload.areas) != null ? _a : selectedState == null ? void 0 : selectedState.val);
        const overrides = payload ? this.extractZoneOverrides(payload) : void 0;
        const startImmediately = typeof (payload == null ? void 0 : payload.startImmediately) === "boolean" ? Boolean(payload.startImmediately) : true;
        await this.sidecar.startAreas({
          device_id: deviceId,
          area_hashes: selectedAreas,
          overrides,
          start_immediately: startImmediately
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
  parseZoneStartPayload(value) {
    const text = String(value != null ? value : "").trim();
    if (!text) {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      this.log.debug(`Ignoring invalid zone payload JSON: ${String(error)}`);
    }
    return null;
  }
  extractZoneOverrides(payload) {
    const overrides = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === "areas" || key === "startImmediately") {
        continue;
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        overrides[key] = value;
      }
    }
    return Object.keys(overrides).length ? overrides : void 0;
  }
  async executeZoneValueWrite(deviceId, field, state, stateId) {
    var _a;
    try {
      if (field === "selectedAreas") {
        const snapshot = this.deviceSnapshots.get(deviceId);
        const knownZoneHashes = (_a = snapshot == null ? void 0 : snapshot.zones.map((zone) => zone.hash)) != null ? _a : [];
        let selectedAreas = (0, import_zone_selection.parseAreaSelection)(state.val);
        if (knownZoneHashes.length) {
          selectedAreas = selectedAreas.filter((hash) => knownZoneHashes.includes(hash));
        }
        const serialized = (0, import_zone_selection.serializeAreaSelection)(selectedAreas);
        await this.setStateChangedAsync(stateId, serialized, true);
        await this.syncConfiguredZonesForDevice(deviceId, selectedAreas);
        return;
      }
      await this.setStateChangedAsync(stateId, state.val, true);
    } catch (error) {
      await this.setStateChangedAsync("info.lastError", String(error), true);
      this.log.warn(`Zone value write ${field} failed for ${deviceId}: ${String(error)}`);
    }
  }
  async executeZoneConfigWrite(deviceId, zoneHash, field, state, stateId) {
    var _a, _b;
    try {
      const channelId = (0, import_object_model.normalizeDeviceChannelId)(deviceId);
      const selectedAreasState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
      let selectedAreas = (0, import_zone_selection.parseAreaSelection)(selectedAreasState == null ? void 0 : selectedAreasState.val);
      if (field === "selected") {
        const orderState = await this.getStateAsync(`devices.${channelId}.zones.zone_${zoneHash}.config.order`);
        selectedAreas = (0, import_zone_selection.mergeZonePreference)(selectedAreas, zoneHash, Boolean(state.val), Number((_a = orderState == null ? void 0 : orderState.val) != null ? _a : 0));
        await this.setStateChangedAsync(stateId, Boolean(state.val), true);
      } else {
        const preferredOrder = Number((_b = state.val) != null ? _b : 0);
        const selectedState = await this.getStateAsync(`devices.${channelId}.zones.zone_${zoneHash}.config.selected`);
        const selected = preferredOrder > 0 ? true : Boolean(selectedState == null ? void 0 : selectedState.val);
        selectedAreas = (0, import_zone_selection.mergeZonePreference)(selectedAreas, zoneHash, selected, preferredOrder);
        await this.setStateChangedAsync(stateId, preferredOrder > 0 ? Math.trunc(preferredOrder) : 0, true);
      }
      const serialized = (0, import_zone_selection.serializeAreaSelection)(selectedAreas);
      await this.setStateChangedAsync(`devices.${channelId}.zones.selectedAreas`, serialized, true);
      await this.syncConfiguredZonesForDevice(deviceId, selectedAreas);
    } catch (error) {
      await this.setStateChangedAsync("info.lastError", String(error), true);
      this.log.warn(`Zone config write ${field} failed for ${deviceId}/${zoneHash}: ${String(error)}`);
    }
  }
  async syncZoneConfiguration(snapshot) {
    const channelId = (0, import_object_model.normalizeDeviceChannelId)(snapshot.id);
    const selectedAreasState = await this.getStateAsync(`devices.${channelId}.zones.selectedAreas`);
    const knownZoneHashes = snapshot.zones.map((zone) => zone.hash);
    let configuredAreas = (0, import_zone_selection.parseAreaSelection)(selectedAreasState == null ? void 0 : selectedAreasState.val).filter((hash) => knownZoneHashes.includes(hash));
    if (!configuredAreas.length && knownZoneHashes.length) {
      configuredAreas = [...knownZoneHashes];
      await this.setStateChangedAsync(`devices.${channelId}.zones.selectedAreas`, (0, import_zone_selection.serializeAreaSelection)(configuredAreas), true);
    }
    await this.syncConfiguredZonesForDevice(snapshot.id, configuredAreas);
  }
  async syncConfiguredZonesForDevice(deviceId, configuredAreas) {
    const snapshot = this.deviceSnapshots.get(deviceId);
    if (!snapshot) {
      return;
    }
    const channelId = (0, import_object_model.normalizeDeviceChannelId)(deviceId);
    const preferences = (0, import_zone_selection.buildZonePreferences)(
      snapshot.zones.map((zone) => zone.hash),
      configuredAreas
    );
    for (const entry of preferences) {
      await this.setStateChangedAsync(
        `devices.${channelId}.zones.zone_${entry.hash}.config.selected`,
        entry.selected,
        true
      );
      await this.setStateChangedAsync(
        `devices.${channelId}.zones.zone_${entry.hash}.config.order`,
        entry.order,
        true
      );
    }
  }
  async runDiagnosticLogin(stateId) {
    try {
      if (!this.sidecar) {
        throw new Error("Sidecar is not running");
      }
      if (!this.config.email || !this.config.password) {
        throw new Error("Missing Mammotion credentials in adapter configuration");
      }
      const result = await this.sidecar.diagnosticLogin({
        account: this.config.email,
        password: this.config.password
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
  async clearSessionCache(stateId) {
    try {
      const cachePath = import_node_path.default.join(utils.getAbsoluteInstanceDataDir(this), "pymammotion-cache.json");
      await import_promises.default.rm(cachePath, { force: true });
      await this.setStateChangedAsync("info.lastError", "", true);
      await this.setStateChangedAsync("info.lastLoginMessage", "Session cache cleared", true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.setStateChangedAsync("info.lastError", `Clear cache failed: ${message}`, true);
    } finally {
      await this.setStateChangedAsync(stateId, false, true);
    }
  }
  async handleFatalError(error, prefix) {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error(`${prefix}: ${message}`);
    this.stopSessionWatchdog();
    await this.setStateChangedAsync("info.lastError", `${prefix}: ${message}`, true);
    await this.setStateChangedAsync("info.connection", false, true);
    await this.setStateChangedAsync("info.sidecarReady", false, true);
    await this.setStateChangedAsync("info.authenticated", false, true);
  }
}
if (require.main !== module) {
  module.exports = (options) => new MammotionPyMammotion(options);
} else {
  (() => new MammotionPyMammotion())();
}
//# sourceMappingURL=main.js.map
