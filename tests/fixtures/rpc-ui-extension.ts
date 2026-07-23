import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rpcUiTestExtension(pi: ExtensionAPI): void {
  pi.registerCommand("desktop-ui-test", {
    description: "Exercise the Pi Desktop RPC extension UI protocol",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Desktop UI Test", "type a value");
      ctx.ui.notify(value ? `Received: ${value}` : "Cancelled", value ? "info" : "warning");
    },
  });
}
