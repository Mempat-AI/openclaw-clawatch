declare module "openclaw" {
  export interface OpenClawPluginApi {
    registerService(options: {
      id: string;
      start: (ctx: { logger?: { info?: (msg: string, ...args: unknown[]) => void; error?: (msg: string, ...args: unknown[]) => void } }) => Promise<void>;
      stop: () => Promise<void>;
    }): void;
    registerCli(
      fn: (opts: { program: { command: (name: string, desc?: string) => { command: (name: string, desc?: string) => { option: (name: string, desc: string) => { action: (fn: (...args: unknown[]) => void | Promise<void>) => void }; action: (fn: (...args: unknown[]) => void | Promise<void>) => void }; action: (fn: (...args: unknown[]) => void | Promise<void>) => void } } };
      }) => void,
      opts: { commands: string[] }
    ): void;
    registerTool(options: {
      name: string;
      description: string;
      parameters: object;
      execute: (ctx: unknown, params: object) => Promise<{ content: Array<{ type: string; text: string }> }>;
    }): void;
    registerChannel?(options: { plugin: unknown }): void;
    pluginConfig: unknown;
    config?: {
      gateway?: {
        port?: number;
        remote?: { url?: string };
        auth?: { token?: string; password?: string };
      };
      plugins?: { entries?: Record<string, { config?: unknown }> };
    };
    runtime?: {
      config?: {
        writeConfigFile?: (cfg: unknown) => void;
      };
    };
  }
  const api: OpenClawPluginApi;
  export default api;
}
