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
var hyperion_exports = {};
__export(hyperion_exports, {
  Hyperion: () => Hyperion
});
module.exports = __toCommonJS(hyperion_exports);
var import_ws = __toESM(require("ws"));
var import_library = require("./library");
var import_definition = require("./definition");
class Hyperion extends import_library.BaseClass {
  description;
  UDN;
  ip = "";
  protocol = "";
  port = 0;
  ws;
  delayTimeout;
  aliveTimeout;
  aliveCheckTimeout;
  legacyAliveCheck = true;
  /**
   * constructor
   *
   * @param adapter adapter class definition
   * @param UDN unique device name
   * @param config device description
   */
  constructor(adapter, UDN, config) {
    super(adapter, config.name || "Hyperion");
    this.UDN = UDN.replace(/^uuid:/, "");
    this.protocol = config.protocol;
    this.ip = config.ip;
    this.port = config.port;
  }
  checkHyperionVersion() {
    if (!this.description) {
      return;
    }
    let version = this.description.device.modelNumber;
    if (version) {
      const temp = version.match(/(\d+\.\d+\.\d+)/);
      if (temp) {
        version = temp[1];
        const parts = version.split(".");
        this.log.debug("Hyperion version:", version);
        if (parts.length >= 3) {
          if (parseInt(parts[0]) > 2 || parseInt(parts[1]) > 0 || parseInt(parts[2]) > 16) {
            this.legacyAliveCheck = false;
          } else {
            this.log.warn("Hyperion version is equal or lower than 2.0.16, use legacy alive check");
            this.legacyAliveCheck = true;
          }
        }
      }
    }
  }
  /**
   * init
   *
   * initialize the device
   */
  async init() {
    await this.library.writedp(this.UDN, void 0, {
      _id: "",
      type: "device",
      common: {
        name: this.description ? this.description.device.friendlyName : this.name
      },
      native: {}
    });
    await this.library.writeFromJson(this.UDN, "device", import_definition.statesObjects, import_definition.controlDefaults, false, true);
    this.adapter.subscribeStates(`${this.library.cleandp(`${this.UDN}.controls`)}.*`);
    await this.reconnect();
  }
  /**
   * setOnline
   *
   * @param isOnline set the online state.
   */
  setOnline(isOnline) {
    this.library.writedp(`${this.UDN}.online`, isOnline, import_definition.genericStateObjects.online).catch(() => {
    });
  }
  /**
   * createWebsocketConnectionToHyperion
   */
  async reconnect() {
    if (this.ws) {
      this.ws.terminate;
    }
    try {
      this.description = await this.adapter.controller.network.getSsdpDescription(
        this.protocol,
        this.ip,
        this.port
      );
      if (this.description === void 0) {
        throw new Error("Got no description");
      }
      this.checkHyperionVersion();
      this.name = this.description.device.friendlyName;
      await this.library.writedp(this.UDN, void 0, {
        _id: "",
        type: "device",
        common: {
          name: this.description.device.friendlyName
        },
        native: {}
      });
      await this.library.writeFromJson(
        `${this.description.device.UDN}.device`,
        "device.description",
        import_definition.statesObjects,
        this.description
      );
      const url = this.description.URLBase.replace("http://", "ws://").replace("https://", "wss://");
      this.log.debug(`Re-/Connect to: ${url}`);
      this.ws = new import_ws.default(url);
      this.ws.addEventListener("open", async () => {
        if (this.description) {
          this.log.info(`Connected to ${this.description.device.friendlyName}`);
        }
        this.aliveReset();
        if (this.ws) {
          this.ws.send(
            JSON.stringify({
              command: "sysinfo",
              tan: 1
            })
          );
          this.ws.send(
            JSON.stringify({
              command: "serverinfo",
              subscribe: ["all"],
              tan: 1
            })
          );
        }
      });
      this.ws.addEventListener("message", async (event) => {
        try {
          this.aliveReset();
          const data = typeof event.data === "string" ? JSON.parse(event.data) : void 0;
          if (data) {
            if (data.command === "serverinfo") {
              const info = data.info;
              info.components = this.changeArrayToJsonIfName(info.components);
              info.effects = this.changeArrayToJsonIfName(info.effects);
              await this.library.writeFromJson(this.UDN, "device.serverinfo", import_definition.statesObjects, info);
              await this.cleanTree();
            } else if (data.command === "priorities-update") {
              if (this.ws) {
                this.ws.send(
                  JSON.stringify({
                    command: "serverinfo",
                    tan: 1
                  })
                );
              }
              this.log.debug("Received:", JSON.stringify(data));
            } else if (data.command === "sysinfo") {
              await this.library.writeFromJson(
                this.UDN,
                "device.sysinfo",
                import_definition.statesObjects,
                data.info
              );
            } else {
              await this.updateControlsStates(data);
              this.log.debug("Received:", JSON.stringify(data));
            }
          }
        } catch {
        }
      });
      this.ws.addEventListener("close", () => {
        this.log.info("Connection closed");
        this.ws = void 0;
        this.delayReconnect();
      });
      this.ws.addEventListener("error", async (error) => {
        this.log.error("Error:", error.message);
        this.delayReconnect();
      });
      this.ws.on("pong", () => {
        this.aliveReset();
      });
    } catch {
      this.log.debug("No connection");
      if (this.ws) {
        this.ws.terminate();
      }
      this.ws = void 0;
      this.delayReconnect();
    }
  }
  async cleanTree() {
    for (const state of ["priorities", "adjustment", "transform", "activeLedColor"]) {
      await this.library.garbageColleting(`${this.UDN}.${state}`);
    }
  }
  /**
   * delayReconnect
   *
   * delay the reconnect to avoid a loop
   */
  delayReconnect() {
    this.setOnline(false);
    if (this.delayTimeout) {
      this.adapter.clearTimeout(this.delayTimeout);
    }
    if (this.aliveTimeout) {
      this.adapter.clearTimeout(this.aliveTimeout);
    }
    this.library.writedp(`${this.UDN}.online`, false, import_definition.genericStateObjects.online).catch(() => {
      this.log.error("Error in writedp");
    });
    this.delayTimeout = this.adapter.setTimeout(() => {
      this.reconnect().catch(() => {
      });
    }, 15e3);
  }
  /**
   * check if the connection is alive
   * if not, terminate the connection
   * and reconnect
   */
  aliveCheck() {
    if (this.aliveTimeout) {
      this.adapter.clearTimeout(this.aliveTimeout);
    }
    this.aliveTimeout = this.adapter.setTimeout(
      async () => {
        if (this.ws) {
          if (this.legacyAliveCheck) {
            this.ws.send(
              JSON.stringify({
                command: "sysinfo",
                tan: 1
              })
            );
          } else {
            this.ws.ping();
          }
        }
        this.aliveCheckTimeout = this.adapter.setTimeout(() => {
          this.log.warn("connection lost!");
          if (this.ws) {
            this.ws.terminate();
          }
          this.ws = void 0;
          this.delayReconnect();
        }, 900);
      },
      this.legacyAliveCheck ? 3e4 : 5e3
    );
  }
  /**
   * reset the alive check
   */
  aliveReset() {
    this.setOnline(true);
    if (this.aliveCheckTimeout) {
      this.adapter.clearTimeout(this.aliveCheckTimeout);
    }
    if (this.aliveTimeout) {
      this.adapter.clearTimeout(this.aliveTimeout);
    }
    this.aliveCheck();
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   */
  onUnload() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.delayTimeout) {
      this.adapter.clearTimeout(this.delayTimeout);
    }
    if (this.aliveTimeout) {
      this.adapter.clearTimeout(this.aliveTimeout);
    }
    if (this.aliveCheckTimeout) {
      this.adapter.clearTimeout(this.aliveCheckTimeout);
    }
    this.log.info("unload");
  }
  /**
   * changeArrayToJsonIfName
   *
   * @param array array to check
   */
  changeArrayToJsonIfName(array) {
    const result = {};
    let useArray = false;
    if (Array.isArray(array)) {
      for (const a of array) {
        if (a.name) {
          useArray = true;
          result[a.name] = a;
        }
      }
    }
    return useArray ? result : array;
  }
  async onStateChange(id, state) {
    if (state) {
      const parts = id.split(".");
      if (parts.length == 6) {
        if (parts[3] === "controls" && parts[4] === "color" && parts[5] === "activate") {
          if (this.ws) {
            const values = this.library.getStates(`${this.UDN}.controls.color.`);
            const command = {
              command: "color"
            };
            for (const k in values) {
              const v = k;
              const key = k.split(".").pop();
              if (key !== void 0) {
                let val = values[v].val;
                const defaultValue = import_definition.controlDefaults.controls.color[key];
                if (defaultValue !== void 0) {
                  if (typeof defaultValue === "object" && Array.isArray(defaultValue)) {
                    val = val ? JSON.parse(val) : [];
                  }
                }
                if (key !== "activate" && values[k] && values[v].val !== void 0) {
                  command[key] = val;
                }
              }
            }
            this.ws.send(JSON.stringify({ ...command, tan: 100 }));
          }
        }
      } else if (parts.length == 5 && parts[4] === "action") {
        if (this.ws && typeof state.val === "string") {
          try {
            const command = JSON.parse(state.val);
            command.tan = 220;
            this.ws.send(JSON.stringify(command));
          } catch {
            this.log.warn(`Invalid JSON in ${id}`);
          }
        }
      }
    }
  }
  async updateControlsStates(data) {
    if (data.success) {
      if (data.tan == 220) {
        const state = this.library.readdb(`${this.UDN}.controls.action`);
        if (state !== void 0) {
          await this.library.writedp(`${this.UDN}.controls.action`, state.val);
        }
      } else if (data.command === "color") {
        const values = this.library.getStates(`${this.UDN}.controls.color.`);
        for (const k in values) {
          const v = k;
          if (k.endsWith("activate")) {
            await this.library.writedp(k, false);
          } else {
            await this.library.writedp(k, values[v].val);
          }
        }
      }
    } else {
      this.log.warn(`Command ${data.command} failed - JSON: ${JSON.stringify(data)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Hyperion
});
//# sourceMappingURL=hyperion.js.map
