/**
 * /rename: Claude Code's name for pi's /name. Installed by pi-vt420's install.sh into ~/.pi/agent/extensions, so pi
 * and pi-vt420 both load it.
 */

import type { ExtensionAPI } from "../../../core/extensions/index.ts";

export default function renameExtension(pi: ExtensionAPI) {
	pi.registerCommand("rename", {
		description: "rename this session, as /name does",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				const current = pi.getSessionName();
				ctx.ui.notify(current ? `Session name: ${current}` : "Usage: /rename <name>", current ? "info" : "warning");
				return;
			}
			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed to ${pi.getSessionName() ?? name}`, "info");
		},
	});
}
