import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import {
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
    SidecarBootstrapParams,
    SidecarBootstrapResult,
    SidecarCommandResult,
    SidecarDiagnosticLoginParams,
    SidecarDiagnosticLoginResult,
    SidecarGetSnapshotParams,
    SidecarGetSnapshotResult,
    SidecarHealthResult,
    SidecarListDevicesResult,
    SidecarLoginParams,
    SidecarLoginResult,
    SidecarPlanActionParams,
    SidecarSetSettingParams,
    SidecarSendCommandParams,
    SidecarStartAreasParams,
    SidecarValidateConnectionParams,
    SidecarValidateConnectionResult,
    SidecarZoneActionParams,
} from "./protocol";

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
    timeout: NodeJS.Timeout;
}

export interface SidecarClientOptions {
    pythonExecutable: string;
    scriptPath: string;
    workingDirectory: string;
    namespace: string;
    log: ioBroker.Logger;
}

type SidecarEvents = {
    notification: (message: JsonRpcNotification<any>) => void;
    stderr: (line: string) => void;
    exit: (payload: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

export class SidecarClient extends EventEmitter {
    private readonly options: SidecarClientOptions;
    private child: ChildProcessWithoutNullStreams | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();

    public constructor(options: SidecarClientOptions) {
        super();
        this.options = options;
    }

    public override on<U extends keyof SidecarEvents>(event: U, listener: SidecarEvents[U]): this {
        return super.on(event, listener);
    }

    public async start(): Promise<void> {
        if (this.child) {
            return;
        }
        this.child = spawn(this.options.pythonExecutable, [this.options.scriptPath], {
            cwd: this.options.workingDirectory,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdoutReader = readline.createInterface({ input: this.child.stdout });
        stdoutReader.on("line", (line) => {
            void this.handleStdoutLine(line);
        });
        const stderrReader = readline.createInterface({ input: this.child.stderr });
        stderrReader.on("line", (line) => this.emit("stderr", line));
        this.child.once("exit", (code, signal) => {
            const error = new Error(`Sidecar exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timeout);
                pending.reject(error);
            }
            this.pending.clear();
            this.child = null;
            this.emit("exit", { code, signal });
        });
    }

    public async stop(): Promise<void> {
        if (!this.child) {
            return;
        }
        const child = this.child;
        const exited = new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
        });
        child.kill();
        await Promise.race([
            exited,
            new Promise<void>((resolve) => {
                setTimeout(() => {
                    if (child.exitCode === null && !child.killed) {
                        child.kill("SIGKILL");
                    }
                    resolve();
                }, 5_000);
            }),
        ]);
        this.child = null;
    }

    public async shutdown(): Promise<void> {
        await this.request("shutdown");
    }

    public health(): Promise<SidecarHealthResult> {
        return this.request("health");
    }

    public validateConnection(params: SidecarValidateConnectionParams = {}): Promise<SidecarValidateConnectionResult> {
        return this.request("validate_connection", params);
    }

    public bootstrap(params: SidecarBootstrapParams): Promise<SidecarBootstrapResult> {
        return this.request("bootstrap", params);
    }

    public loginOrRestore(params: SidecarLoginParams): Promise<SidecarLoginResult> {
        return this.request("login_or_restore", params);
    }

    public diagnosticLogin(params: SidecarDiagnosticLoginParams): Promise<SidecarDiagnosticLoginResult> {
        return this.request("diagnostic_login", params);
    }

    public listDevices(): Promise<SidecarListDevicesResult> {
        return this.request("list_devices");
    }

    public getSnapshot(params: SidecarGetSnapshotParams): Promise<SidecarGetSnapshotResult> {
        return this.request("get_snapshot", params);
    }

    public sendCommand(params: SidecarSendCommandParams): Promise<SidecarCommandResult> {
        return this.request("send_command", params);
    }

    public setSetting(params: SidecarSetSettingParams): Promise<SidecarCommandResult> {
        return this.request("set_setting", params);
    }

    public zoneAction(params: SidecarZoneActionParams): Promise<SidecarCommandResult> {
        return this.request("zone_action", params);
    }

    public planAction(params: SidecarPlanActionParams): Promise<SidecarCommandResult> {
        return this.request("plan_action", params);
    }

    public startAreas(params: SidecarStartAreasParams): Promise<SidecarCommandResult> {
        return this.request("start_areas", params);
    }

    private async handleStdoutLine(line: string): Promise<void> {
        if (!line.trim()) {
            return;
        }
        const parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification<any>;
        if ("id" in parsed) {
            const pending = this.pending.get(parsed.id);
            if (!pending) {
                return;
            }
            this.pending.delete(parsed.id);
            clearTimeout(pending.timeout);
            if (parsed.error) {
                pending.reject(new Error(parsed.error.message));
                return;
            }
            pending.resolve(parsed.result);
            return;
        }
        this.emit("notification", parsed);
    }

    private request<TResult>(method: string, params?: unknown): Promise<TResult> {
        if (!this.child) {
            return Promise.reject(new Error("Sidecar process is not running"));
        }
        const id = this.nextId++;
        const message: JsonRpcRequest = {
            id,
            method,
            params,
        };
        return new Promise<TResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.pending.has(id)) {
                    return;
                }
                this.pending.delete(id);
                reject(new Error(`Sidecar request timed out: ${method}`));
            }, 30_000);
            this.pending.set(id, { resolve, reject, timeout });
            this.child?.stdin.write(`${JSON.stringify(message)}\n`);
        });
    }
}
