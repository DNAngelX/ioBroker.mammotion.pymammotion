import { NormalizedDevicePlan, NormalizedDeviceSnapshot, Primitive } from "./protocol";

export interface DeviceRegistration {
    id: string;
    channelId: string;
    name: string;
}

function inferType(value: Primitive): ioBroker.CommonType {
    if (typeof value === "boolean") {
        return "boolean";
    }
    if (typeof value === "number") {
        return "number";
    }
    return "string";
}

function normalizeValue(value: Primitive): string | number | boolean {
    if (value === null) {
        return "";
    }
    return value;
}

export function normalizeDeviceChannelId(deviceId: string): string {
    return deviceId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function toTelemetryStateId(key: string): string {
    return key.replace(/[^A-Za-z0-9_]/g, "_");
}

function toDynamicStateId(key: string): string {
    return key.replace(/[^A-Za-z0-9_]/g, "_");
}

function toZoneChannelId(hash: number): string {
    return `zone_${String(hash).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function toPlanChannelId(planId: string): string {
    return `plan_${String(planId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const ZONE_START_CONFIGURATION_FIELDS = [
    { stateKey: "bladeHeight", snapshotKey: "bladeHeight", label: "Cutting height" },
    { stateKey: "workingSpeed", snapshotKey: "workingSpeed", label: "Working speed" },
    { stateKey: "pathSpacing", snapshotKey: "pathSpacing", label: "Path spacing" },
    { stateKey: "pathOrder", snapshotKey: "jobMode", label: "Path order" },
    { stateKey: "cuttingPathMode", snapshotKey: "channelMode", label: "Cutting path mode" },
    { stateKey: "obstacleDetectionMode", snapshotKey: "ultraWave", label: "Obstacle detection mode" },
    { stateKey: "cuttingPathAngle", snapshotKey: "toward", label: "Cutting path angle" },
    { stateKey: "cuttingPathAngleMode", snapshotKey: "towardMode", label: "Cutting path angle mode" },
    { stateKey: "crossingAngle", snapshotKey: "towardIncludedAngle", label: "Crossing angle" },
    { stateKey: "boundaryLaps", snapshotKey: "borderMode", label: "Boundary laps" },
    { stateKey: "noGoZoneLaps", snapshotKey: "obstacleLaps", label: "No-go zone laps" },
    { stateKey: "perimeterLaps", snapshotKey: "mowingLaps", label: "Perimeter mowing laps" },
    { stateKey: "startProgress", snapshotKey: "startProgress", label: "Start progress" },
    { stateKey: "collectGrassFrequency", snapshotKey: "collectGrassFrequency", label: "Collect grass frequency" },
    { stateKey: "startImmediately", snapshotKey: null, label: "Start immediately" },
] as const;

function isWritableConfigurationKey(key: string): boolean {
    return [
        "bladeHeight",
        "workingSpeed",
        "rainDetection",
        "traversalMode",
        "turningMode",
        "sideLight",
        "manualLight",
        "nightLight",
        "cutterMode",
    ].includes(key);
}

function getConfigurationLimitBindings(
    key: string,
): {
    minKey?: string;
    maxKey?: string;
} {
    switch (key) {
        case "bladeHeight":
            return { minKey: "bladeHeightMin", maxKey: "bladeHeightMax" };
        case "workingSpeed":
            return { minKey: "workingSpeedMin", maxKey: "workingSpeedMax" };
        case "pathSpacing":
            return { minKey: "pathSpacingMin", maxKey: "pathSpacingMax" };
        default:
            return {};
    }
}

function getConfigurationStateLabels(key: string): Record<string, string> | undefined {
    switch (key) {
        case "jobMode":
        case "pathOrder":
            return {
                "0": "border-first",
                "1": "grid-first",
                "4": "auto",
            };
        case "channelMode":
        case "cuttingPathMode":
            return {
                "0": "single-grid",
                "1": "double-grid",
                "2": "segment-grid",
                "3": "no-grid",
            };
        case "ultraWave":
        case "obstacleDetectionMode":
            return {
                "0": "direct-touch",
                "1": "slow-touch",
                "2": "less-touch",
                "10": "no-touch",
                "11": "sensitive",
            };
        case "cutterMode":
            return {
                "0": "standard",
                "1": "economic",
                "2": "performance",
            };
        case "borderMode":
        case "boundaryLaps":
        case "edgeMode":
        case "obstacleLaps":
        case "noGoZoneLaps":
        case "perimeterLaps":
            return {
                "0": "none",
                "1": "one",
                "2": "two",
                "3": "three",
                "4": "four",
            };
        case "towardMode":
        case "cuttingPathAngleMode":
            return {
                "0": "relative-angle",
                "1": "absolute-angle",
                "2": "random-angle",
            };
        case "turningMode":
            return {
                "0": "zero-turn",
                "1": "multi-point",
            };
        case "traversalMode":
            return {
                "0": "direct-to-dock",
                "1": "follow-perimeter",
            };
        default:
            return undefined;
    }
}

function getValueUnit(key: string): string | undefined {
    switch (key) {
        case "bladeHeight":
            return "mm";
        case "workingSpeed":
            return "m/s";
        case "pathSpacing":
            return "cm";
        case "cuttingPathAngle":
        case "crossingAngle":
            return "°";
        case "latitude":
        case "longitude":
        case "rtkLatitude":
        case "rtkLongitude":
        case "globalLatitude":
        case "globalLongitude":
        case "locationLatitude":
        case "locationLongitude":
            return "°";
        default:
            return undefined;
    }
}

function buildDynamicCommon(
    channel: "capabilities" | "diagnostics" | "configuration" | "configurationLimits",
    key: string,
    value: Primitive,
    snapshot?: NormalizedDeviceSnapshot,
): ioBroker.StateCommon {
    const writable = channel === "configuration" && isWritableConfigurationKey(key);
    const common: ioBroker.StateCommon = {
        name: key,
        type: inferType(value),
        role:
            typeof value === "number"
                ? writable
                    ? "level"
                    : "value"
                : typeof value === "boolean"
                  ? writable
                      ? "switch"
                      : "indicator"
                  : "text",
        read: true,
        write: writable,
    };

    const unit = getValueUnit(key);
    if (unit && (channel === "configuration" || channel === "diagnostics")) {
        common.unit = unit;
    }

    if (channel === "configuration") {
        const { minKey, maxKey } = getConfigurationLimitBindings(key);
        if (minKey) {
            const min = snapshot?.configurationLimits[minKey];
            if (typeof min === "number") {
                common.min = min;
            }
        }
        if (maxKey) {
            const max = snapshot?.configurationLimits[maxKey];
            if (typeof max === "number") {
                common.max = max;
            }
        }
        const states = getConfigurationStateLabels(key);
        if (states) {
            common.states = states;
        }
    }

    return common;
}

async function ensureState(adapter: ioBroker.Adapter, id: string, common: ioBroker.StateCommon): Promise<void> {
    await adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {},
    });
}

export async function ensureBaseObjects(adapter: ioBroker.Adapter): Promise<void> {
    await adapter.setObjectNotExistsAsync("info", {
        type: "channel",
        common: { name: "Information" },
        native: {},
    });
    await ensureState(adapter, "info.connection", {
        name: "Service connected",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.sidecarReady", {
        name: "Sidecar ready",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.pythonReady", {
        name: "Python ready",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.authenticated", {
        name: "Authenticated",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.lastError", {
        name: "Last error",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.lastSync", {
        name: "Last sync",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pythonVersion", {
        name: "Python version",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionVersion", {
        name: "Pinned PyMammotion version",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionLatestVersion", {
        name: "Latest PyMammotion version",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionLatestCompatibleVersion", {
        name: "Latest compatible PyMammotion version",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionLatestRequiresPython", {
        name: "Latest PyMammotion Python requirement",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionPinnedRequiresPython", {
        name: "Pinned PyMammotion Python requirement",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, "info.pymammotionUpdateAvailable", {
        name: "PyMammotion update available",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.pythonUpgradeRequired", {
        name: "Python upgrade required for latest PyMammotion",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
        def: false,
    });
    await ensureState(adapter, "info.lastLoginCode", {
        name: "Last login code",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0,
    });
    await ensureState(adapter, "info.lastLoginMessage", {
        name: "Last login message",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await adapter.setObjectNotExistsAsync("diagnostics", {
        type: "channel",
        common: { name: "Diagnostics" },
        native: {},
    });
    await ensureState(adapter, "diagnostics.testLogin", {
        name: "Test login",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false,
    });
    await ensureState(adapter, "diagnostics.clearCache", {
        name: "Clear session cache",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false,
    });
}

export async function ensureDeviceObjects(adapter: ioBroker.Adapter, device: DeviceRegistration): Promise<void> {
    const baseId = `devices.${device.channelId}`;
    await adapter.setObjectNotExistsAsync(baseId, {
        type: "device",
        common: { name: device.name },
        native: { deviceId: device.id },
    });
    for (const channel of [
        "info",
        "status",
        "telemetry",
        "capabilities",
        "diagnostics",
        "configuration",
        "controls",
        "commands",
        "zones",
        "plans",
    ]) {
        await adapter.setObjectNotExistsAsync(`${baseId}.${channel}`, {
            type: "channel",
            common: { name: channel },
            native: {},
        });
    }
    await adapter.setObjectNotExistsAsync(`${baseId}.configuration.limits`, {
        type: "channel",
        common: { name: "limits" },
        native: {},
    });
    await adapter.setObjectNotExistsAsync(`${baseId}.zones.config`, {
        type: "channel",
        common: { name: "config" },
        native: {},
    });

    await ensureState(adapter, `${baseId}.info.name`, {
        name: "Device name",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.deviceType`, {
        name: "Device type",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.model`, {
        name: "Model",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.productKey`, {
        name: "Product key",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.firmwareVersion`, {
        name: "Firmware version",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.serialNumber`, {
        name: "Serial number",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.info.mqttTransport`, {
        name: "MQTT transport",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });

    await ensureState(adapter, `${baseId}.status.online`, {
        name: "Online",
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.status.enabled`, {
        name: "Enabled",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.status.connectionState`, {
        name: "Connection state",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.status.activity`, {
        name: "Activity",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${baseId}.status.state`, {
        name: "State",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });

    for (const channel of ["controls", "commands"]) {
        for (const command of [
            "start",
            "pause",
            "stop",
            "dock",
            "refresh",
            "leaveDock",
            "cancelTask",
            "nudgeForward",
            "nudgeBack",
            "nudgeLeft",
            "nudgeRight",
            "bladeOn",
            "bladeOff",
        ]) {
            await ensureState(adapter, `${baseId}.${channel}.${command}`, {
                name: command,
                type: "boolean",
                role: "button",
                read: false,
                write: true,
                def: false,
            });
        }
    }

    await ensureState(adapter, `${baseId}.zones.currentAreas`, {
        name: "Current area hashes",
        type: "string",
        role: "text",
        read: true,
        write: false,
        def: "",
    });
    await ensureState(adapter, `${baseId}.zones.selectedAreas`, {
        name: "Selected area hashes",
        type: "string",
        role: "text",
        read: true,
        write: true,
        def: "",
    });
    await ensureState(adapter, `${baseId}.zones.startPayload`, {
        name: "Zone start payload",
        type: "string",
        role: "json",
        read: true,
        write: true,
        def: "",
    });
    for (const action of ["startSelected", "startAll", "syncMap", "syncAreaNames", "syncPlans"]) {
        await ensureState(adapter, `${baseId}.zones.${action}`, {
            name: action,
            type: "boolean",
            role: "button",
            read: false,
            write: true,
            def: false,
        });
    }

    await ensureState(adapter, `${baseId}.plans.count`, {
        name: "Plan count",
        type: "number",
        role: "value",
        read: true,
        write: false,
        def: 0,
    });
    await ensureState(adapter, `${baseId}.plans.sync`, {
        name: "Sync plans",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false,
    });
}

async function ensureTelemetryState(
    adapter: ioBroker.Adapter,
    baseId: string,
    key: string,
    value: Primitive,
): Promise<void> {
    const id = `${baseId}.telemetry.${toTelemetryStateId(key)}`;
    const common: ioBroker.StateCommon = {
        name: key,
        type: inferType(value),
        role: typeof value === "number" ? "value" : typeof value === "boolean" ? "indicator" : "text",
        read: true,
        write: false,
    };
    const unit = getValueUnit(key);
    if (unit) {
        common.unit = unit;
    }
    await ensureState(adapter, id, common);
    await adapter.extendObjectAsync(id, { common });
}

async function setTelemetryValue(
    adapter: ioBroker.Adapter,
    baseId: string,
    key: string,
    value: Primitive,
): Promise<void> {
    await ensureTelemetryState(adapter, baseId, key, value);
    await adapter.setStateChangedAsync(`${baseId}.telemetry.${toTelemetryStateId(key)}`, normalizeValue(value), true);
}

async function ensureDynamicState(
    adapter: ioBroker.Adapter,
    baseId: string,
    channel: "capabilities" | "diagnostics" | "configuration" | "configurationLimits",
    key: string,
    value: Primitive,
    snapshot?: NormalizedDeviceSnapshot,
): Promise<void> {
    const channelPrefix = channel === "configurationLimits" ? "configuration.limits" : channel;
    const id = `${baseId}.${channelPrefix}.${toDynamicStateId(key)}`;
    const common = buildDynamicCommon(channel, key, value, snapshot);
    await ensureState(adapter, id, common);
    await adapter.extendObjectAsync(id, { common });
}

async function setDynamicValue(
    adapter: ioBroker.Adapter,
    baseId: string,
    channel: "capabilities" | "diagnostics" | "configuration" | "configurationLimits",
    key: string,
    value: Primitive,
    snapshot?: NormalizedDeviceSnapshot,
): Promise<void> {
    await ensureDynamicState(adapter, baseId, channel, key, value, snapshot);
    const channelPrefix = channel === "configurationLimits" ? "configuration.limits" : channel;
    await adapter.setStateChangedAsync(`${baseId}.${channelPrefix}.${toDynamicStateId(key)}`, normalizeValue(value), true);
}

async function syncConfigurationStateMetadata(
    adapter: ioBroker.Adapter,
    baseId: string,
    snapshot: NormalizedDeviceSnapshot,
): Promise<void> {
    for (const [key, value] of Object.entries(snapshot.configuration)) {
        await ensureDynamicState(adapter, baseId, "configuration", key, value, snapshot);
    }
}

async function ensureZoneObjects(
    adapter: ioBroker.Adapter,
    baseId: string,
    hash: number,
): Promise<string> {
    const zoneId = `${baseId}.zones.${toZoneChannelId(hash)}`;
    await adapter.setObjectNotExistsAsync(zoneId, {
        type: "channel",
        common: { name: `zone ${hash}` },
        native: { hash },
    });
    for (const channel of ["info", "status"]) {
        await adapter.setObjectNotExistsAsync(`${zoneId}.${channel}`, {
            type: "channel",
            common: { name: channel },
            native: {},
        });
    }
    await adapter.setObjectNotExistsAsync(`${zoneId}.config`, {
        type: "channel",
        common: { name: "config" },
        native: {},
    });
    await ensureState(adapter, `${zoneId}.info.hash`, {
        name: "Hash",
        type: "number",
        role: "value",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${zoneId}.info.name`, {
        name: "Name",
        type: "string",
        role: "text",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${zoneId}.status.selected`, {
        name: "Selected",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${zoneId}.status.active`, {
        name: "Active",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${zoneId}.status.order`, {
        name: "Order",
        type: "number",
        role: "value",
        read: true,
        write: false,
    });
    await ensureState(adapter, `${zoneId}.config.selected`, {
        name: "Selected for automation",
        type: "boolean",
        role: "switch",
        read: true,
        write: true,
        def: false,
    });
    await ensureState(adapter, `${zoneId}.config.order`, {
        name: "Automation order",
        type: "number",
        role: "level",
        read: true,
        write: true,
        def: 0,
    });
    return zoneId;
}

function buildReadOnlyCommon(key: string, value: Primitive): ioBroker.StateCommon {
    const common: ioBroker.StateCommon = {
        name: key,
        type: inferType(value),
        role: typeof value === "number" ? "value" : typeof value === "boolean" ? "indicator" : "text",
        read: true,
        write: false,
    };
    const unit = getValueUnit(key);
    if (unit) {
        common.unit = unit;
    }
    return common;
}

function buildPlanConfigurationCommon(key: string, value: Primitive): ioBroker.StateCommon {
    const common = buildReadOnlyCommon(key, value);
    const unit = getValueUnit(key);
    if (unit) {
        common.unit = unit;
    }
    const states = getConfigurationStateLabels(key);
    if (states) {
        common.states = states;
    }
    return common;
}

function buildZoneStartConfigurationCommon(key: string, value: Primitive, snapshot?: NormalizedDeviceSnapshot): ioBroker.StateCommon {
    const common: ioBroker.StateCommon = {
        name: key,
        type: inferType(value),
        role:
            typeof value === "number"
                ? "level"
                : typeof value === "boolean"
                  ? "switch"
                  : "text",
        read: true,
        write: true,
    };
    const unit = getValueUnit(key);
    if (unit) {
        common.unit = unit;
    }
    const { minKey, maxKey } = getConfigurationLimitBindings(key);
    if (minKey) {
        const min = snapshot?.configurationLimits[minKey];
        if (typeof min === "number") {
            common.min = min;
        }
    }
    if (maxKey) {
        const max = snapshot?.configurationLimits[maxKey];
        if (typeof max === "number") {
            common.max = max;
        }
    }
    const states = getConfigurationStateLabels(key);
    if (states) {
        common.states = states;
    }
    return common;
}

function getZoneStartConfigurationFallback(
    field: (typeof ZONE_START_CONFIGURATION_FIELDS)[number],
    snapshot: NormalizedDeviceSnapshot,
): Primitive {
    const stateKey = field.stateKey as string;
    if (stateKey === "startImmediately") {
        return true;
    }
    if (stateKey === "perimeterLaps") {
        const value = snapshot.configuration.edgeMode;
        return typeof value === "number" ? value : 1;
    }
    const value = field.snapshotKey ? snapshot.configuration[field.snapshotKey] : undefined;
    if (value !== undefined) {
        return value;
    }
    switch (stateKey) {
        case "pathOrder":
            return 4;
        case "obstacleDetectionMode":
            return 2;
        case "noGoZoneLaps":
        case "boundaryLaps":
        case "perimeterLaps":
            return 1;
        default:
            return 0;
    }
}

async function syncZoneStartConfigurationState(
    adapter: ioBroker.Adapter,
    baseId: string,
    field: (typeof ZONE_START_CONFIGURATION_FIELDS)[number],
    snapshot: NormalizedDeviceSnapshot,
): Promise<void> {
    const id = `${baseId}.zones.config.${toDynamicStateId(field.stateKey)}`;
    const fallback = getZoneStartConfigurationFallback(field, snapshot);
    const common = buildZoneStartConfigurationCommon(field.stateKey, fallback, snapshot);
    common.name = field.label;
    await ensureState(adapter, id, common);
    await adapter.extendObjectAsync(id, { common });
    const currentState = await adapter.getStateAsync(id);
    if (currentState?.val === null || currentState?.val === undefined || currentState.val === "") {
        await adapter.setStateChangedAsync(id, normalizeValue(fallback), true);
    }
}

async function ensurePlanObjects(
    adapter: ioBroker.Adapter,
    baseId: string,
    plan: NormalizedDevicePlan,
): Promise<string> {
    const planId = `${baseId}.plans.${toPlanChannelId(plan.id)}`;
    await adapter.setObjectNotExistsAsync(planId, {
        type: "channel",
        common: { name: plan.name },
        native: { planId: plan.id },
    });
    await adapter.extendObjectAsync(planId, {
        common: { name: plan.name },
        native: { planId: plan.id },
    });
    for (const channel of ["info", "schedule", "configuration", "zones", "commands"]) {
        await adapter.setObjectNotExistsAsync(`${planId}.${channel}`, {
            type: "channel",
            common: { name: channel },
            native: {},
        });
    }
    await ensureState(adapter, `${planId}.commands.start`, {
        name: "start",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false,
    });
    return planId;
}

async function setPlanChannelValue(
    adapter: ioBroker.Adapter,
    planBaseId: string,
    channel: "info" | "schedule" | "configuration" | "zones",
    key: string,
    value: Primitive,
): Promise<void> {
    const id = `${planBaseId}.${channel}.${toDynamicStateId(key)}`;
    const common = channel === "configuration" ? buildPlanConfigurationCommon(key, value) : buildReadOnlyCommon(key, value);
    await ensureState(adapter, id, common);
    await adapter.extendObjectAsync(id, { common });
    await adapter.setStateChangedAsync(id, normalizeValue(value), true);
}

export async function applyDeviceSnapshot(
    adapter: ioBroker.Adapter,
    snapshot: NormalizedDeviceSnapshot,
    previous?: NormalizedDeviceSnapshot,
): Promise<void> {
    const channelId = normalizeDeviceChannelId(snapshot.id);
    const baseId = `devices.${channelId}`;

    await adapter.setStateChangedAsync(`${baseId}.info.name`, snapshot.name, true);
    await adapter.setStateChangedAsync(`${baseId}.info.deviceType`, snapshot.info.deviceType, true);
    await adapter.setStateChangedAsync(`${baseId}.info.model`, snapshot.info.model, true);
    await adapter.setStateChangedAsync(`${baseId}.info.productKey`, snapshot.info.productKey, true);
    await adapter.setStateChangedAsync(`${baseId}.info.firmwareVersion`, snapshot.info.firmwareVersion, true);
    await adapter.setStateChangedAsync(`${baseId}.info.serialNumber`, snapshot.info.serialNumber, true);
    await adapter.setStateChangedAsync(`${baseId}.info.mqttTransport`, snapshot.info.mqttTransport, true);

    await adapter.setStateChangedAsync(`${baseId}.status.online`, snapshot.status.online, true);
    await adapter.setStateChangedAsync(`${baseId}.status.enabled`, snapshot.status.enabled, true);
    await adapter.setStateChangedAsync(`${baseId}.status.connectionState`, snapshot.status.connectionState, true);
    await adapter.setStateChangedAsync(`${baseId}.status.activity`, snapshot.status.activity, true);
    await adapter.setStateChangedAsync(`${baseId}.status.state`, snapshot.status.state, true);

    for (const [key, value] of Object.entries(snapshot.telemetry)) {
        if (previous?.telemetry[key] === value) {
            continue;
        }
        await setTelemetryValue(adapter, baseId, key, value);
    }

    for (const [key, value] of Object.entries(snapshot.capabilities)) {
        if (previous?.capabilities[key] === value) {
            continue;
        }
        await setDynamicValue(adapter, baseId, "capabilities", key, value, snapshot);
    }

    for (const [key, value] of Object.entries(snapshot.diagnostics)) {
        if (previous?.diagnostics[key] === value) {
            continue;
        }
        await setDynamicValue(adapter, baseId, "diagnostics", key, value, snapshot);
    }

    for (const [key, value] of Object.entries(snapshot.configuration)) {
        if (previous?.configuration[key] === value) {
            continue;
        }
        await setDynamicValue(adapter, baseId, "configuration", key, value, snapshot);
    }

    for (const [key, value] of Object.entries(snapshot.configurationLimits)) {
        if (previous?.configurationLimits[key] === value) {
            continue;
        }
        await setDynamicValue(adapter, baseId, "configurationLimits", key, value, snapshot);
    }

    await syncConfigurationStateMetadata(adapter, baseId, snapshot);
    for (const field of ZONE_START_CONFIGURATION_FIELDS) {
        await syncZoneStartConfigurationState(adapter, baseId, field, snapshot);
    }

    const currentAreas = snapshot.zones
        .filter((zone) => zone.selected)
        .sort((left, right) => left.order - right.order)
        .map((zone) => String(zone.hash))
        .join(",");
    await adapter.setStateChangedAsync(`${baseId}.zones.currentAreas`, currentAreas, true);

    for (const zone of snapshot.zones) {
        const zoneId = await ensureZoneObjects(adapter, baseId, zone.hash);
        await adapter.setStateChangedAsync(`${zoneId}.info.hash`, zone.hash, true);
        await adapter.setStateChangedAsync(`${zoneId}.info.name`, zone.name, true);
        await adapter.setStateChangedAsync(`${zoneId}.status.selected`, zone.selected, true);
        await adapter.setStateChangedAsync(`${zoneId}.status.active`, zone.active, true);
        await adapter.setStateChangedAsync(`${zoneId}.status.order`, zone.order, true);
    }

    await adapter.setStateChangedAsync(`${baseId}.plans.count`, snapshot.plans.length, true);
    for (const plan of snapshot.plans) {
        const planId = await ensurePlanObjects(adapter, baseId, plan);
        for (const [key, value] of Object.entries(plan.info)) {
            await setPlanChannelValue(adapter, planId, "info", key, value);
        }
        for (const [key, value] of Object.entries(plan.schedule)) {
            await setPlanChannelValue(adapter, planId, "schedule", key, value);
        }
        for (const [key, value] of Object.entries(plan.configuration)) {
            await setPlanChannelValue(adapter, planId, "configuration", key, value);
        }
        for (const [key, value] of Object.entries(plan.zones)) {
            await setPlanChannelValue(adapter, planId, "zones", key, value);
        }
    }
}
