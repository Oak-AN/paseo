import { subscriptionFixture } from "@/runtime/subscription-fixture";
/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPluginsPage } from "./plugins-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  sourceSupported: true,
  logsSupported: true,
  client: null as DaemonClient | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => {
    if (feature === "pluginLogs") return runtime.logsSupported;
    if (feature === "pluginGitManagement") return runtime.sourceSupported;
    return runtime.supported;
  },
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@/components/adaptive-modal-sheet")>(
    "@/components/adaptive-modal-sheet",
  );
  return {
    ...actual,
    AdaptiveModalSheet: ({
      header,
      children,
      onClose,
    }: {
      header: { title: string; actions?: React.ReactNode };
      children: React.ReactNode;
      onClose(): void;
    }) =>
      ReactModule.createElement(
        "div",
        { role: "dialog" },
        ReactModule.createElement("h2", null, header.title),
        header.actions,
        ReactModule.createElement("button", { type: "button", onClick: onClose }, "Close"),
        children,
      ),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: ReactModule.forwardRef(() => null),
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function plugin(enabled = true): PluginListItem {
  return {
    id: "example",
    description: "Reviews changes before merge",
    path: "/plugins/example",
    enabled,
    status: enabled ? "running" : "disabled",
  };
}

async function selectPluginAction(action: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Actions for example" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: action }));
}

function createClient() {
  return {
    observeEvents: () =>
      subscriptionFixture(
        Promise.resolve({ events: ["status.plugin_catalog_changed"] }),
        () => () => {},
      ),
    getDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    patchDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    listPlugins: vi.fn(async (): Promise<PluginListItem[]> => []),
    installPluginSource: vi.fn(async () => plugin()),
    reloadPlugin: vi.fn(async () => plugin()),
    enablePlugin: vi.fn(async () => plugin()),
    disablePlugin: vi.fn(async () => plugin(false)),
    removePlugin: vi.fn(async () => undefined),
    getPluginLogs: vi.fn(async (): Promise<PluginLogEntry[]> => []),
  };
}

type PluginClient = ReturnType<typeof createClient>;

function renderPage(client: PluginClient | null): void {
  runtime.client = client as unknown as DaemonClient | null;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const element: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <HostPluginsPage serverId="host-a" />
    </QueryClientProvider>
  );
  render(element);
}

describe("HostPluginsPage", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    runtime.connected = true;
    runtime.supported = true;
    runtime.sourceSupported = true;
    runtime.logsSupported = true;
    runtime.client = null;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the offline state", () => {
    runtime.connected = false;
    renderPage(null);

    expect(screen.getByRole("alert").textContent).toContain("Plugin host is offline");
  });

  it("renders a catalog error and retries through the real query", async () => {
    const client = createClient();
    client.listPlugins.mockRejectedValueOnce(new Error("catalog exploded"));
    renderPage(client);

    expect(await screen.findByText("Unable to load plugins")).toBeDefined();
    expect(screen.getByText("catalog exploded")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(client.listPlugins).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugins configured")).toBeDefined();
  });

  it.each([
    ["reloadPlugin", "Reload"],
    ["removePlugin", "Remove"],
  ] as const)("runs %s from the plugin actions menu", async (method, action) => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await selectPluginAction(action);

    await waitFor(() => expect(client[method]).toHaveBeenCalledTimes(1));
  });

  it("disables the plugin switch and menu while an action is pending", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.reloadPlugin.mockImplementation(() => never<never>());
    renderPage(client);

    await selectPluginAction("Reload");

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "example: Disable" }).getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen.getByRole("button", { name: "Actions for example" }).getAttribute("aria-disabled"),
      ).toBe("true");
    });
  });

  it.each([
    [true, "disablePlugin"],
    [false, "enablePlugin"],
  ] as const)("toggles an enabled=%s plugin with its switch", async (enabled, method) => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin(enabled)]);
    renderPage(client);

    fireEvent.click(
      await screen.findByRole("switch", { name: `example: ${enabled ? "Disable" : "Enable"}` }),
    );

    await waitFor(() => expect(client[method]).toHaveBeenCalledTimes(1));
  });

  it("shows the manifest description and status without exposing the source path", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([
      plugin(),
      {
        id: "disabled-example",
        description: "Available when needed",
        path: "/plugins/disabled-example",
        enabled: false,
        status: "disabled",
      },
      {
        id: "failed-example",
        description: "Needs attention",
        path: "/plugins/failed-example",
        enabled: true,
        status: "failed",
        error: "Plugin failed to start",
      },
    ]);
    renderPage(client);

    expect(await screen.findByText("Reviews changes before merge")).toBeDefined();
    expect(screen.getByText("Available when needed")).toBeDefined();
    expect(screen.getByText("Needs attention")).toBeDefined();
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByText("disabled")).toBeDefined();
    expect(screen.getByText("failed")).toBeDefined();
    expect(screen.getByText("Plugin failed to start")).toBeDefined();
    expect(screen.queryByText("/plugins/example")).toBeNull();
    expect(screen.queryByText("/plugins/disabled-example")).toBeNull();
    expect(screen.queryByText("/plugins/failed-example")).toBeNull();
  });

  it("renders install pending through the real form and mutation", async () => {
    const client = createClient();
    client.installPluginSource.mockImplementation(() => never<never>());
    renderPage(client);

    expect(screen.getByPlaceholderText("Directory, Git URL, or npm package")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Plugin source"), {
      target: { value: "/plugins/example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));

    const pendingControl = await screen.findByRole("button", { name: "Installing…" });
    expect(pendingControl.getAttribute("aria-disabled")).toBe("true");
    expect(client.installPluginSource).toHaveBeenCalledWith({ source: "/plugins/example" });
    expect(screen.queryByLabelText("Plugin installation ID")).toBeNull();
    expect(screen.getByRole("link", { name: "Docs" })).toBeDefined();
  });

  it("keeps management available while source installation requires a host update", async () => {
    runtime.sourceSupported = false;
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    expect(await screen.findByRole("button", { name: "Actions for example" })).toBeDefined();
    expect(screen.getByText("Update this host to install plugins")).toBeDefined();
    expect(screen.queryByLabelText("Plugin source")).toBeNull();
  });

  it("hides the logs action when the host does not advertise support", async () => {
    runtime.logsSupported = false;
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await screen.findByText("example");
    fireEvent.click(screen.getByRole("button", { name: "Actions for example" }));
    expect(screen.queryByRole("menuitem", { name: "Logs" })).toBeNull();
  });

  it("opens readable stdout and stderr logs and refreshes them", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockResolvedValue([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
      {
        sequence: 2,
        timestamp: "2026-08-16T12:00:01.000Z",
        stream: "stderr",
        message: "warning",
      },
    ]);
    renderPage(client);

    await selectPluginAction("Logs");

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Logs: example")).toBeDefined();
    expect(await screen.findByText("ready")).toBeDefined();
    expect(screen.getByText("warning")).toBeDefined();
    expect(screen.getByText(/stdout/)).toBeDefined();
    expect(screen.getByText(/stderr/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
  });

  it("shows empty and recoverable error states for plugin logs", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockRejectedValueOnce(new Error("logs exploded"));
    renderPage(client);

    await selectPluginAction("Logs");
    expect(await screen.findByText("Unable to load plugin logs")).toBeDefined();
    expect(screen.getByText("logs exploded")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" }).at(-1)!);
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugin output yet")).toBeDefined();
  });
});
