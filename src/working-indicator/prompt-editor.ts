import { CustomEditor } from "@earendil-works/pi-coding-agent";

export class PromptEditor extends CustomEditor {
	setPaddingX(padding: number): void {
		super.setPaddingX(Math.max(2, padding));
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (width >= 5 && lines[1]) {
			lines[1] = this.borderColor("❯ ") + lines[1].slice(2);
		}
		return lines;
	}
}
