export type Primitive = string | number | boolean | null;

export type SidecarCommand =
    | "start"
    | "pause"
    | "stop"
    | "dock"
    | "refresh"
    | "leaveDock"
    | "cancelTask"
    | "nudgeForward"
    | "nudgeBack"
    | "nudgeLeft"
    | "nudgeRight"
    | "bladeOn"
    | "bladeOff";

export interface NormalizedDeviceZone {
    hash: number;
    name: string;
    order: number;
    selected: boolean;
    active: boolean;
}

export interface NormalizedDeviceSnapshot {
    id: string;
    name: string;
    info: {
        deviceType: string;
        productKey: string;
        firmwareVersion: string;
        model: string;
        serialNumber: string;
        mqttTransport: string;
    };
    status: {
        online: boolean;
        enabled: boolean;
        connectionState: string;
        activity: string;
        state: string;
    };
    telemetry: Record<string, Primitive>;
    capabilities: Record<string, Primitive>;
    diagnostics: Record<string, Primitive>;
    configuration: Record<string, Primitive>;
    configurationLimits: Record<string, Primitive>;
    zones: NormalizedDeviceZone[];
}

export interface JsonRpcRequest<TParams = unknown> {
    id: number;
    method: string;
    params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
    id: number;
    result?: TResult;
    error?: {
        code: number;
        message: string;
    };
}

export interface JsonRpcNotification<TParams = unknown> {
    method: string;
    params?: TParams;
}

export interface SidecarBootstrapParams {
    instance_data_dir: string;
    sidecar_log_level: string;
    adapter_version: string;
}

export interface SidecarBootstrapResult {
    adapter: string;
    version: string;
}

export interface SidecarHealthResult {
    ok: boolean;
    python_version: string;
}

export interface SidecarValidateConnectionParams {
    probe?: boolean;
}

export interface SidecarValidateConnectionResult {
    ok: boolean;
    authenticated: boolean;
    device_count: number;
    online_devices: number;
    probe: string;
    last_snapshot_at: string;
    last_snapshot_age_sec: number;
    message?: string;
}

export interface SidecarLoginParams {
    account: string;
    password: string;
    cache_path: string;
    sidecar_log_level: string;
}

export interface SidecarLoginResult {
    authenticated: boolean;
    devices: string[];
}

export interface SidecarDiagnosticLoginParams {
    account: string;
    password: string;
}

export interface SidecarDiagnosticLoginResult {
    ok: boolean;
    code: number;
    message: string;
}

export interface SidecarListDevicesResult {
    devices: string[];
}

export interface SidecarGetSnapshotParams {
    device_id: string;
}

export interface SidecarGetSnapshotResult {
    snapshot: NormalizedDeviceSnapshot | null;
}

export interface SidecarSendCommandParams {
    device_id: string;
    command: SidecarCommand;
}

export interface SidecarSetSettingParams {
    device_id: string;
    key: string;
    value: Primitive;
}

export interface SidecarZoneActionParams {
    device_id: string;
    action: "syncMap" | "syncAreaNames" | "syncPlans";
}

export interface SidecarStartAreasParams {
    device_id: string;
    area_hashes: number[];
    overrides?: Record<string, Primitive>;
    start_immediately?: boolean;
}

export interface SidecarCommandResult {
    ok: boolean;
    device_id: string;
    command: SidecarCommand | string;
    message?: string;
}

export interface SidecarNotificationMap {
    ready: { version: string };
    auth_state: { authenticated: boolean; message?: string };
    device_discovered: { device_id: string; name: string };
    device_snapshot: { snapshot: NormalizedDeviceSnapshot };
    device_online: { device_id: string; online: boolean };
    command_result: SidecarCommandResult;
    log: { level: string; message: string };
    error: { message: string };
}
