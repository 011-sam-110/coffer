// The few extension APIs Coffer uses (Manifest V3). Kept here instead of
// @types/chrome: the extension has no dependencies. Add to it as calls are added.

declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }
    interface MessageSender {
      id?: string;
      url?: string;
      frameId?: number;
      tab?: { id?: number; url?: string };
    }
    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: { addListener(cb: (message: unknown, port: Port) => void): void };
      onDisconnect: { addListener(cb: (port: Port) => void): void };
    }
    interface InstalledDetails {
      reason: "install" | "update" | "chrome_update" | "shared_module_update";
      previousVersion?: string;
    }
    const id: string;
    const lastError: LastError | undefined;
    function connectNative(application: string): Port;
    function getURL(path: string): string;
    function getManifest(): { version: string; name: string };
    function reload(): void;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(cb: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(cb: (details: InstalledDetails) => void): void };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace tabs {
    interface Tab {
      id?: number;
    }
    function create(props: { url: string }): Promise<unknown>;
    function query(q: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage<T = unknown>(tabId: number, message: unknown, options?: { frameId?: number }): Promise<T>;
  }

  namespace commands {
    const onCommand: { addListener(cb: (command: string, tab?: chrome.tabs.Tab) => void): void };
  }

  namespace types {
    type LevelOfControl = "not_controllable" | "controlled_by_other_extensions" | "controllable_by_this_extension" | "controlled_by_this_extension";
    interface ChromeSetting<T> {
      get(details: Record<string, never>): Promise<{ value: T; levelOfControl: LevelOfControl }>;
      set(details: { value: T }): Promise<void>;
    }
  }

  namespace privacy {
    const services: { passwordSavingEnabled: chrome.types.ChromeSetting<boolean> };
  }
}

interface NavigatorUAData {
  brands: ReadonlyArray<{ brand: string; version: string }>;
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData;
}
