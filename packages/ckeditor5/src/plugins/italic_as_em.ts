import { Plugin } from "ckeditor5";

export default class ItalicAsEmPlugin extends Plugin {

	init() {
		this.editor.conversion
			.for("downcast")
			.attributeToElement({
				model: "italic",
				view: "em",
				converterPriority: "high"
			});
	}

}
