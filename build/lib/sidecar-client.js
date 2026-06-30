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
var sidecar_client_exports = {};
__export(sidecar_client_exports, {
  SidecarClient: () => SidecarClient
});
module.exports = __toCommonJS(sidecar_client_exports);
var import_node_child_process = require("node:child_process");
var import_node_events = require("node:events");
var import_node_readline = __toESM(require("node:readline"));
class SidecarClient extends import_node_events.EventEmitter {
  options;
  child = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  constructor(options) {
    super();
    this.options = options;
  }
  on(event, listener) {
    return super.on(event, listener);
  }
  async start() {
    if (this.child) {
      return;
    }
    this.child = (0, import_node_child_process.spawn)(this.options.pythonExecutable, [this.options.scriptPath], {
      cwd: this.options.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutReader = import_node_readline.default.createInterface({ input: this.child.stdout });
    stdoutReader.on("line", (line) => {
      void this.handleStdoutLine(line);
    });
    const stderrReader = import_node_readline.default.createInterface({ input: this.child.stderr });
    stderrReader.on("line", (line) => this.emit("stderr", line));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Sidecar exited with code ${code != null ? code : "null"} signal ${signal != null ? signal : "null"}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", { code, signal });
    });
  }
  async stop() {
    if (!this.child) {
      return;
    }
    const child = this.child;
    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => {
        setTimeout(() => {
          if (child.exitCode === null && !child.killed) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5e3);
      })
    ]);
    this.child = null;
  }
  async shutdown() {
    await this.request("shutdown");
  }
  health() {
    return this.request("health");
  }
  validateConnection(params = {}) {
    return this.request("validate_connection", params);
  }
  bootstrap(params) {
    return this.request("bootstrap", params);
  }
  loginOrRestore(params) {
    return this.request("login_or_restore", params);
  }
  diagnosticLogin(params) {
    return this.request("diagnostic_login", params);
  }
  listDevices() {
    return this.request("list_devices");
  }
  getSnapshot(params) {
    return this.request("get_snapshot", params);
  }
  sendCommand(params) {
    return this.request("send_command", params);
  }
  setSetting(params) {
    return this.request("set_setting", params);
  }
  zoneAction(params) {
    return this.request("zone_action", params);
  }
  startAreas(params) {
    return this.request("start_areas", params);
  }
  async handleStdoutLine(line) {
    if (!line.trim()) {
      return;
    }
    const parsed = JSON.parse(line);
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
  request(method, params) {
    if (!this.child) {
      return Promise.reject(new Error("Sidecar process is not running"));
    }
    const id = this.nextId++;
    const message = {
      id,
      method,
      params
    };
    return new Promise((resolve, reject) => {
      var _a;
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`Sidecar request timed out: ${method}`));
      }, 3e4);
      this.pending.set(id, { resolve, reject, timeout });
      (_a = this.child) == null ? void 0 : _a.stdin.write(`${JSON.stringify(message)}
`);
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SidecarClient
});
//# sourceMappingURL=sidecar-client.js.map
