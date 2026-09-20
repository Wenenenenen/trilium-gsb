import { Plugin } from "ckeditor5";

export default class StrikethroughAsDel extends Plugin {

	init() {
		this.editor.conversion
			.for("downcast")
			.attributeToElement({
				model: "strikethrough",
				view: "del",
				converterPriority: "high"
			});
	}

}
