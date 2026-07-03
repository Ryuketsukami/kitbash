// Minimal ambient types for optional Capacitor peers, so the client compiles
// (and dynamic imports typecheck) without the plugins installed.

declare module '@capacitor/browser' {
  export interface BrowserPluginListenerHandle {
    remove(): Promise<void>;
  }
  export const Browser: {
    open(options: { url: string; windowName?: string }): Promise<void>;
    close(): Promise<void>;
    addListener(
      eventName: 'browserFinished',
      listener: () => void,
    ): Promise<BrowserPluginListenerHandle>;
  };
}

declare module '@capacitor/app' {
  export interface AppPluginListenerHandle {
    remove(): Promise<void>;
  }
  export interface URLOpenListenerEvent {
    url: string;
  }
  export const App: {
    addListener(
      eventName: 'appUrlOpen',
      listener: (event: URLOpenListenerEvent) => void,
    ): Promise<AppPluginListenerHandle>;
  };
}
