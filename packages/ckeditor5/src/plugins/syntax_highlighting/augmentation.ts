interface EditorConfig {
    loadHighlightJs(): Promise<HighlightJs>;
    mapLanguageName(mimeType: string): string;
    defaultMimeType: string;
    enabled: boolean;
}

// TODO: Replace once library loader is replaced with webpack.
interface HighlightJs {
    highlightAuto(text: string): HighlightJsResult;
    highlight(text: string, opts: {
        language: string
    }): HighlightJsResult;
};

interface HighlightJsResult {
    value: string;
}

