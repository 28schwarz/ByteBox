// Moves what the editor keeps in the browser (preferences, themes, copied instruments, recovered
// songs...) between websites. Browsers keep the storage of every website apart, so a copy of the
// editor hosted at one address has no way of reading what a copy at another address has saved.
// The data has to be carried over by hand: exported into a file on one site, imported on the other.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { Prompt } from "./Prompt";
import { SongDocument } from "./SongDocument";
import { ColorConfig } from "./ColorConfig";

const { button, div, h2, p, input, textarea, span } = HTML;

const browserDataFormat: string = "BeepBoxBrowserData";
const browserDataFileName: string = "slarmoosbox_browser_data.json";

// A self-contained version of the export below, for pasting into the browser console of a site that
// doesn't have this prompt. It only reads that site's own storage and saves it into a file.
export const browserDataExportSnippet: string = `(()=>{const d={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);d[k]=localStorage.getItem(k);}const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify({format:"${browserDataFormat}",version:1,origin:location.origin,localStorage:d})],{type:"application/json"}));a.download="${browserDataFileName}";document.body.appendChild(a);a.click();a.remove();})()`;

function collectBrowserData(): { [key: string]: string } {
    const data: { [key: string]: string } = {};
    for (let i: number = 0; i < window.localStorage.length; i++) {
        const key: string | null = window.localStorage.key(i);
        if (key == null) continue;
        const value: string | null = window.localStorage.getItem(key);
        if (value != null) data[key] = value;
    }
    return data;
}

// Returns the stored items found in the text of an exported file, or null if it isn't one.
export function parseBrowserData(text: string): { [key: string]: string } | null {
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return null;
    }
    if (parsed == null || typeof parsed != "object" || parsed["format"] != browserDataFormat) return null;
    const source: any = parsed["localStorage"];
    if (source == null || typeof source != "object" || Array.isArray(source)) return null;
    const data: { [key: string]: string } = {};
    for (const key of Object.keys(source)) {
        // Browser storage only ever holds text, so anything else in the file doesn't belong there.
        if (typeof source[key] == "string") data[key] = source[key];
    }
    return data;
}

export class BrowserDataPrompt implements Prompt {
    private readonly _exportButton: HTMLButtonElement = button({ style: "width: 100%;", type: "button" }, "Export This Site's Data");
    private readonly _importButton: HTMLButtonElement = button({ style: "width: 100%;", type: "button" }, "Import Data From a File...");
    private readonly _fileInput: HTMLInputElement = input({ type: "file", accept: ".json,application/json", style: "display: none;" });
    private readonly _status: HTMLDivElement = div({ style: `min-height: 1.3em; text-align: left; overflow-wrap: anywhere;` });
    private readonly _snippetBox: HTMLTextAreaElement = textarea({
        readonly: "readonly", spellcheck: "false", rows: "3",
        style: `width: 100%; box-sizing: border-box; resize: none; padding: 4px; font-family: monospace; font-size: 80%; background: transparent; color: ${ColorConfig.secondaryText}; border: 1px solid ${ColorConfig.inputBoxOutline}; -webkit-user-select: text; -moz-user-select: text; user-select: text;`,
    });
    private readonly _copyButton: HTMLButtonElement = button({ style: "width: 100%; margin-top: 0.5em;", type: "button" }, "Copy to Clipboard");
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });

    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 480px; max-height: calc(100% - 40px); overflow-y: auto;" },
        h2({ style: "flex-shrink: 0;" }, "Transfer Browser Data"),
        div({ style: "margin-top: 0.75em; flex-shrink: 0;" },
            p({ style: `margin: 0 0 0.75em 0; color: ${ColorConfig.secondaryText};` },
                "Your preferences, themes, copied instruments and recovered songs are saved by your browser, separately for every website. That means this site can't see what you have saved on another site that hosts Slarmoo's Box, but you can carry it over in a file.",
            ),
            this._exportButton,
            div({ style: "margin-top: 0.5em;" }, this._importButton),
            this._fileInput,
            p({ style: `margin: 0.5em 0 0 0; color: ${ColorConfig.secondaryText}; font-size: 90%;` },
                "Importing replaces the matching settings on this site, and then reloads the page. The song you have open stays as it is.",
            ),
            div({ style: "margin-top: 0.5em;" }, this._status),
        ),
        div({ style: "margin-top: 0.75em; flex-shrink: 0;" },
            p({ style: "margin: 0 0 0.5em 0;" },
                "To get your data out of a site that doesn't have this menu: open that site, open the browser's console (", span({ style: "white-space: nowrap;" }, "F12 or Ctrl+Shift+J"), "), paste this in and press Enter. It saves a file that you can import here.",
            ),
            this._snippetBox,
            this._copyButton,
        ),
        this._cancelButton,
    );

    constructor(private _doc: SongDocument) {
        this._snippetBox.value = browserDataExportSnippet;
        this._exportButton.addEventListener("click", this._whenExportClicked);
        this._importButton.addEventListener("click", this._whenImportClicked);
        this._fileInput.addEventListener("change", this._whenFileSelected);
        this._snippetBox.addEventListener("focus", this._whenSnippetFocused);
        this._copyButton.addEventListener("click", this._whenCopyClicked);
        this._cancelButton.addEventListener("click", this._close);
    }

    private _setStatus(text: string): void {
        // Set as plain text, since it can quote the name of a file.
        this._status.textContent = text;
    }

    private _whenExportClicked = (): void => {
        const data: { [key: string]: string } = collectBrowserData();
        const contents: string = JSON.stringify({ "format": browserDataFormat, "version": 1, "origin": location.origin, "localStorage": data });
        const anchor: HTMLAnchorElement = document.createElement("a");
        const url: string = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
        setTimeout(() => { URL.revokeObjectURL(url); }, 60000);
        anchor.href = url;
        anchor.download = browserDataFileName;
        // Dispatching the click a moment later, like the song export does, to dodge a browser bug.
        setTimeout(() => { anchor.dispatchEvent(new MouseEvent("click")); }, 0);
        this._setStatus("✓ Exported " + Object.keys(data).length + " saved items into " + browserDataFileName + ".");
    }

    private _whenImportClicked = (): void => {
        this._fileInput.value = "";
        this._fileInput.click();
    }

    private _whenFileSelected = (): void => {
        const file: File | undefined = this._fileInput.files == null ? undefined : this._fileInput.files[0];
        if (file == undefined) return;
        const reader: FileReader = new FileReader();
        reader.addEventListener("error", () => { this._setStatus("⚠ " + file.name + " couldn't be read."); });
        reader.addEventListener("load", () => {
            const data: { [key: string]: string } | null = parseBrowserData(String(reader.result));
            if (data == null) {
                this._setStatus("⚠ " + file.name + " isn't a browser data file exported from Slarmoo's Box.");
                return;
            }
            const keys: string[] = Object.keys(data);
            let imported: number = 0;
            for (const key of keys) {
                try {
                    window.localStorage.setItem(key, data[key]);
                    imported++;
                } catch (error) {
                    // Most likely the browser's storage for this site is full. Keep whatever did fit.
                }
            }
            if (imported < keys.length) {
                this._setStatus("⚠ Only " + imported + " of " + keys.length + " saved items fit into this browser's storage. Reloading...");
            } else {
                this._setStatus("✓ Imported " + imported + " saved items. Reloading...");
            }
            // The preferences in memory are written back out whenever one of them changes, which would undo
            // the import, so read them back in right away. Then start over to apply everything else too.
            this._doc.prefs.reload();
            this._doc.prompt = null;
            this._doc.undo();
            setTimeout(() => { location.reload(); }, imported < keys.length ? 2500 : 600);
        });
        reader.readAsText(file);
    }

    private _whenSnippetFocused = (): void => {
        this._snippetBox.select();
    }

    private _whenCopyClicked = (): void => {
        const copied = (): void => { this._copyButton.textContent = "Copied!"; };
        const fallback = (): void => {
            this._snippetBox.focus();
            this._snippetBox.select();
            try {
                if (document.execCommand("copy")) copied();
            } catch (error) { }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(browserDataExportSnippet).then(copied, fallback);
        } else {
            fallback();
        }
    }

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    }

    public cleanUp = (): void => {
        this._exportButton.removeEventListener("click", this._whenExportClicked);
        this._importButton.removeEventListener("click", this._whenImportClicked);
        this._fileInput.removeEventListener("change", this._whenFileSelected);
        this._snippetBox.removeEventListener("focus", this._whenSnippetFocused);
        this._copyButton.removeEventListener("click", this._whenCopyClicked);
        this._cancelButton.removeEventListener("click", this._close);
    }
}
