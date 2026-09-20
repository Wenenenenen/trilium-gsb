import { Plugin } from "ckeditor5";
import FileUploadEditing from "./fileuploadediting";

export default class Uploadfileplugin extends Plugin {
	static get requires() {
		return [ FileUploadEditing ];
	}

	static get pluginName() {
		return 'fileUploadPlugin';
	}
}
