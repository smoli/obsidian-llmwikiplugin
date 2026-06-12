import { App, Modal, Setting } from "obsidian";
import { ExtensionUIRequest } from "./rpc-types";

/**
 * Renders a pi extension UI dialog (select / confirm / input / editor) as an
 * Obsidian modal and resolves with the RPC response payload to send back.
 * Resolves to `{ cancelled: true }` if the user dismisses it.
 */
export function showUIDialog(
	app: App,
	req: ExtensionUIRequest
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const modal = new UIDialogModal(app, req, resolve);
		modal.open();
	});
}

class UIDialogModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private req: ExtensionUIRequest,
		private resolve: (value: Record<string, unknown>) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, req } = this;
		contentEl.empty();

		if (req.title) contentEl.createEl("h3", { text: req.title });
		if (req.message) contentEl.createEl("p", { text: req.message });

		switch (req.method) {
			case "confirm":
				this.renderConfirm();
				break;
			case "select":
				this.renderSelect();
				break;
			case "input":
			case "editor":
				this.renderInput();
				break;
			default:
				// Unknown dialog kind — just cancel.
				this.answer({ cancelled: true });
		}
	}

	private renderConfirm(): void {
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText("No")
					.onClick(() => this.answer({ confirmed: false }))
			)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Yes")
					.onClick(() => this.answer({ confirmed: true }))
			);
	}

	private renderSelect(): void {
		const options = this.req.options ?? [];
		const wrap = this.contentEl.createDiv({ cls: "llm-dialog-options" });
		for (const opt of options) {
			const btn = wrap.createEl("button", { text: opt, cls: "llm-dialog-option" });
			btn.addEventListener("click", () => this.answer({ value: opt }));
		}
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Cancel").onClick(() => this.answer({ cancelled: true }))
		);
	}

	private renderInput(): void {
		const isEditor = this.req.method === "editor";
		let value = (this.req.prefill as string) ?? "";
		const input = isEditor
			? this.contentEl.createEl("textarea", { cls: "llm-dialog-textarea" })
			: this.contentEl.createEl("input", { type: "text", cls: "llm-dialog-input" });
		input.value = value;
		if (this.req.placeholder) input.setAttribute("placeholder", String(this.req.placeholder));
		input.addEventListener("input", () => (value = (input as HTMLInputElement | HTMLTextAreaElement).value));
		window.setTimeout(() => input.focus(), 0);

		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => this.answer({ cancelled: true }))
			)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("OK")
					.onClick(() => this.answer({ value }))
			);
	}

	private answer(payload: Record<string, unknown>): void {
		if (this.answered) return;
		this.answered = true;
		this.resolve({ id: this.req.id, ...payload });
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) {
			this.answered = true;
			this.resolve({ id: this.req.id, cancelled: true });
		}
	}
}
