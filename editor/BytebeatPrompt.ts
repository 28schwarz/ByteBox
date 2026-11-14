// The editor for the formula and sample settings of a bytebeat instrument.

import { HTML } from "imperative-html/dist/esm/elements-strict";
import { Config } from "../synth/SynthConfig";
import { Instrument } from "../synth/synth";
import { BytebeatMode, BytebeatTuning, BytebeatRender, BytebeatError, renderBytebeat } from "../synth/Bytebeat";
import { Prompt } from "./Prompt";
import { SongDocument } from "./SongDocument";
import { ColorConfig } from "./ColorConfig";
import { ChangeBytebeat } from "./changes";
import { BytebeatExample, bytebeatExamples } from "./BytebeatExamples";

const { button, div, h2, input, select, option, optgroup, textarea, span, canvas } = HTML;

// Draws an overview of a whole rendered bytebeat sample: for every column of pixels, a line from the
// lowest to the highest sample that falls within that column.
export function drawBytebeatWaveform(target: HTMLCanvasElement, render: BytebeatRender, waveColor: string, backgroundColor: string): void {
    const context: CanvasRenderingContext2D | null = target.getContext("2d");
    if (context == null) return;
    const width: number = target.width;
    const height: number = target.height;
    const wave: Float32Array = render.wave;
    const length: number = wave.length - 1; // The last sample only repeats the first.

    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, width, height);

    // Centering a lopsided sample can push it past the usual range, so fit the tallest peak in.
    let peak: number = 1.0;
    for (let i: number = 0; i < length; i++) {
        const magnitude: number = Math.abs(wave[i]);
        if (magnitude > peak) peak = magnitude;
    }
    const scale: number = (height / 2 - 1) / peak;
    const middle: number = height / 2;

    context.fillStyle = waveColor;
    for (let x: number = 0; x < width; x++) {
        const start: number = Math.floor(x * length / width);
        const end: number = Math.max(start + 1, Math.floor((x + 1) * length / width));
        let lowest: number = Infinity;
        let highest: number = -Infinity;
        for (let i: number = start; i < end && i < length; i++) {
            const sample: number = wave[i];
            if (sample < lowest) lowest = sample;
            if (sample > highest) highest = sample;
        }
        if (lowest > highest) continue;
        const top: number = Math.round(middle - highest * scale);
        const bottom: number = Math.round(middle - lowest * scale);
        context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
}

function describeError(code: string, error: BytebeatError): string {
    if (error.index < 0) return error.message;
    // Point at the line and column of the problem, counting from one like text editors do.
    const before: string = code.substring(0, Math.min(error.index, code.length));
    const line: number = before.split("\n").length;
    const column: number = before.length - before.lastIndexOf("\n");
    return (code.indexOf("\n") == -1 ? "Column " + column : "Line " + line + ", column " + column) + ": " + error.message;
}

function describeRootKey(rootKey: number): string {
    const names: ReadonlyArray<string> = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
    return names[((rootKey % 12) + 12) % 12] + (Math.floor(rootKey / 12) - 1);
}

export class BytebeatPrompt implements Prompt {
    private readonly _instrument: Instrument = this._doc.song.channels[this._doc.channel].instruments[this._doc.getCurrentInstrument()];

    private readonly _codeInput: HTMLTextAreaElement = textarea({
        spellcheck: "false", autocomplete: "off", autocapitalize: "off", maxlength: "" + Config.bytebeatCodeMaxLength, rows: "4",
        style: `width: 100%; box-sizing: border-box; resize: vertical; min-height: 3em; max-height: 14em; padding: 4px; font-family: monospace; font-size: 110%; background: transparent; color: ${ColorConfig.primaryText}; border: 1px solid ${ColorConfig.inputBoxOutline}; -webkit-user-select: text; -moz-user-select: text; user-select: text; cursor: text;`,
    });
    private readonly _exampleSelect: HTMLSelectElement = select({ style: "width: 100%;" });
    private readonly _status: HTMLDivElement = div({ style: `text-align: left; min-height: 1.3em; font-size: 90%; overflow-wrap: anywhere; -webkit-user-select: text; -moz-user-select: text; user-select: text;` });
    // The editor's stylesheet takes every canvas out of the layout by default, so this one is put back in with "position: static".
    private readonly _waveformCanvas: HTMLCanvasElement = canvas({ width: "560", height: "48", style: `position: static; display: block; width: 100%; height: 48px; cursor: default; image-rendering: pixelated; border: 2px solid ${ColorConfig.uiWidgetBackground}; box-sizing: border-box;` });
    private readonly _modeSelect: HTMLSelectElement = select({ style: "width: 100%;" },
        option({ value: BytebeatMode.bytebeat }, "bytebeat (0 to 255)"),
        option({ value: BytebeatMode.signedBytebeat }, "signed bytebeat (-128 to 127)"),
        option({ value: BytebeatMode.floatbeat }, "floatbeat (-1 to 1)"),
    );
    private readonly _tuningSelect: HTMLSelectElement = select({ style: "width: 100%;" },
        option({ value: BytebeatTuning.sample }, "sample (original speed on the root key)"),
        option({ value: BytebeatTuning.singleCycle }, "single cycle (like a chip wave)"),
    );
    private readonly _sampleRateInput: HTMLInputElement = input({ type: "number", min: "" + Config.bytebeatSampleRateMin, max: "" + Config.bytebeatSampleRateMax, step: "1", style: "width: 6.5em;" });
    private readonly _lengthInput: HTMLInputElement = input({ type: "number", min: "" + Config.bytebeatLengthMin, max: "" + Config.bytebeatLengthMax, step: "1", style: "width: 6.5em;" });
    private readonly _rootKeyInput: HTMLInputElement = input({ type: "number", min: "0", max: "" + Config.bytebeatRootKeyMax, step: "1", style: "width: 4em;" });
    private readonly _durationLabel: HTMLSpanElement = span({ style: `color: ${ColorConfig.secondaryText}; margin-left: 0.5em; white-space: nowrap;` });
    private readonly _rootKeyLabel: HTMLSpanElement = span({ style: `color: ${ColorConfig.secondaryText}; margin-left: 0.5em; white-space: nowrap;` });
    // Only shown for the "sample" tuning, as a single cycle is tuned by the notes themselves.
    private readonly _sampleTuningRow: HTMLDivElement = div({ style: "display: flex; align-items: center; margin-top: 0.5em;" },
        span({ style: "width: 6.5em; text-align: right; margin-right: 0.5em; flex-shrink: 0;" }, "Sample rate:"), this._sampleRateInput, span({ style: `color: ${ColorConfig.secondaryText}; margin-left: 0.5em;` }, "Hz"),
        span({ style: "margin-left: 1.5em; margin-right: 0.5em; flex-shrink: 0;" }, "Root key:"), this._rootKeyInput, this._rootKeyLabel,
    );
    private readonly _previewButton: HTMLButtonElement = button({ style: "width: 45%;", type: "button" });
    private readonly _cancelButton: HTMLButtonElement = button({ class: "cancelButton" });
    private readonly _okayButton: HTMLButtonElement = button({ class: "okayButton", style: "width: 45%;" }, "Okay");

    // The prompt is a column that shrinks its rows to fit by default. These rows keep their size, and
    // the prompt scrolls instead if the editor is too short to show all of it.
    public readonly container: HTMLDivElement = div({ class: "prompt noSelection", style: "width: 600px; max-height: calc(100% - 40px); overflow-y: auto;" },
        h2({ style: "flex-shrink: 0;" }, "Edit Bytebeat"),
        div({ style: "margin-top: 0.75em; flex-shrink: 0;" },
            div({ style: `text-align: left; color: ${ColorConfig.secondaryText}; margin-bottom: 0.5em;` },
                "Write a formula for the sample counter ", span({ style: "font-family: monospace;" }, "t"), ". It is compiled into a sample that this instrument plays.",
            ),
            this._codeInput,
            div({ style: "margin-top: 0.25em; margin-bottom: 0.25em;" }, this._status),
            this._waveformCanvas,
        ),
        div({ style: "margin-top: 0.75em; flex-shrink: 0;" },
            div({ style: "display: flex; align-items: center;" },
                span({ style: "width: 6.5em; text-align: right; margin-right: 0.5em; flex-shrink: 0;" }, "Examples:"), div({ class: "selectContainer", style: "flex-grow: 1;" }, this._exampleSelect),
            ),
            div({ style: "display: flex; align-items: center; margin-top: 0.5em;" },
                span({ style: "width: 6.5em; text-align: right; margin-right: 0.5em; flex-shrink: 0;" }, "Mode:"), div({ class: "selectContainer", style: "flex-grow: 1;" }, this._modeSelect),
            ),
            div({ style: "display: flex; align-items: center; margin-top: 0.5em;" },
                span({ style: "width: 6.5em; text-align: right; margin-right: 0.5em; flex-shrink: 0;" }, "Length:"), this._lengthInput, this._durationLabel,
            ),
            div({ style: "display: flex; align-items: center; margin-top: 0.5em;" },
                span({ style: "width: 6.5em; text-align: right; margin-right: 0.5em; flex-shrink: 0;" }, "Tuning:"), div({ class: "selectContainer", style: "flex-grow: 1;" }, this._tuningSelect),
            ),
            this._sampleTuningRow,
        ),
        div({ style: "display: flex; flex-direction: row-reverse; justify-content: space-between; margin-top: 1em; flex-shrink: 0;" },
            this._okayButton,
            this._previewButton,
        ),
        this._cancelButton,
    );

    // Set briefly after the mouse is released, which keeps a text selection that was dragged out past the
    // edge of the prompt from counting as a click outside of it, which would close the prompt.
    public gotMouseUp: boolean = false;
    private _mouseDownInside: boolean = false;

    private _updateTimeout: number | null = null;
    private _previewContext: AudioContext | null = null;
    private _previewSource: AudioBufferSourceNode | null = null;
    private _previewGain: GainNode | null = null;

    constructor(private _doc: SongDocument) {
        this._exampleSelect.appendChild(option({ value: "-1", selected: "selected", disabled: "disabled", hidden: "hidden" }, "Load an example…"));
        const sampleGroup: HTMLElement = optgroup({ label: "Samples" });
        const waveGroup: HTMLElement = optgroup({ label: "Single cycle waves" });
        for (let i: number = 0; i < bytebeatExamples.length; i++) {
            const example: BytebeatExample = bytebeatExamples[i];
            (example.tuning == BytebeatTuning.singleCycle ? waveGroup : sampleGroup).appendChild(option({ value: "" + i }, example.name));
        }
        this._exampleSelect.appendChild(sampleGroup);
        this._exampleSelect.appendChild(waveGroup);

        this._codeInput.value = this._instrument.bytebeatCode;
        this._modeSelect.value = "" + this._instrument.bytebeatMode;
        this._tuningSelect.value = "" + this._instrument.bytebeatTuning;
        this._sampleRateInput.value = "" + this._instrument.bytebeatSampleRate;
        this._lengthInput.value = "" + this._instrument.bytebeatLength;
        this._rootKeyInput.value = "" + this._instrument.bytebeatRootKey;

        this._codeInput.addEventListener("input", this._whenCodeEdited);
        this._exampleSelect.addEventListener("change", this._whenExampleSelected);
        this._modeSelect.addEventListener("change", this._update);
        this._tuningSelect.addEventListener("change", this._update);
        this._sampleRateInput.addEventListener("input", this._whenCodeEdited);
        this._lengthInput.addEventListener("input", this._whenCodeEdited);
        this._rootKeyInput.addEventListener("input", this._whenCodeEdited);
        this._sampleRateInput.addEventListener("change", this._whenNumberCommitted);
        this._lengthInput.addEventListener("change", this._whenNumberCommitted);
        this._rootKeyInput.addEventListener("change", this._whenNumberCommitted);
        this._previewButton.addEventListener("click", this._togglePreview);
        this._okayButton.addEventListener("click", this._saveChanges);
        this._cancelButton.addEventListener("click", this._close);
        this.container.addEventListener("mousedown", this._whenMouseDown);
        document.addEventListener("mouseup", this._whenMouseUp);

        this._update();
        this._updatePreviewButton();

        setTimeout(() => this._codeInput.focus());
    }

    // The settings as they are currently entered, with everything forced into range.
    private _getMode(): BytebeatMode {
        return Math.max(0, Math.min(BytebeatMode.length - 1, parseInt(this._modeSelect.value) | 0));
    }

    private _getTuning(): BytebeatTuning {
        return Math.max(0, Math.min(BytebeatTuning.length - 1, parseInt(this._tuningSelect.value) | 0));
    }

    private _getNumber(element: HTMLInputElement, min: number, max: number, fallback: number): number {
        const value: number = Math.round(Number(element.value));
        if (element.value.trim() == "" || isNaN(value)) return fallback;
        return Math.max(min, Math.min(max, value));
    }

    private _getSampleRate(): number {
        return this._getNumber(this._sampleRateInput, Config.bytebeatSampleRateMin, Config.bytebeatSampleRateMax, this._instrument.bytebeatSampleRate);
    }

    private _getLength(): number {
        return this._getNumber(this._lengthInput, Config.bytebeatLengthMin, Config.bytebeatLengthMax, this._instrument.bytebeatLength);
    }

    private _getRootKey(): number {
        return this._getNumber(this._rootKeyInput, 0, Config.bytebeatRootKeyMax, this._instrument.bytebeatRootKey);
    }

    private _whenCodeEdited = (): void => {
        // Wait for a pause in typing before rendering, since long samples take a moment.
        if (this._updateTimeout != null) clearTimeout(this._updateTimeout);
        this._updateTimeout = window.setTimeout(this._update, 200);
    }

    private _whenNumberCommitted = (): void => {
        // Show what an out of range or empty entry actually turned into.
        this._sampleRateInput.value = "" + this._getSampleRate();
        this._lengthInput.value = "" + this._getLength();
        this._rootKeyInput.value = "" + this._getRootKey();
        this._update();
    }

    private _whenExampleSelected = (): void => {
        const example: BytebeatExample | undefined = bytebeatExamples[parseInt(this._exampleSelect.value)];
        this._exampleSelect.selectedIndex = 0;
        if (example == undefined) return;
        this._codeInput.value = example.code;
        this._modeSelect.value = "" + example.mode;
        this._tuningSelect.value = "" + example.tuning;
        this._sampleRateInput.value = "" + example.sampleRate;
        this._lengthInput.value = "" + example.length;
        this._update();
    }

    private _update = (): void => {
        if (this._updateTimeout != null) {
            clearTimeout(this._updateTimeout);
            this._updateTimeout = null;
        }
        const code: string = this._codeInput.value;
        const length: number = this._getLength();
        const sampleRate: number = this._getSampleRate();
        const tuning: BytebeatTuning = this._getTuning();
        const render: BytebeatRender = renderBytebeat(code, this._getMode(), length, Config.bytebeatCodeMaxLength);

        // Only ever set as text, since error messages quote parts of the formula.
        if (render.error != null) {
            this._status.textContent = "⚠ " + describeError(code, render.error);
            this._status.style.color = ColorConfig.primaryText;
        } else if (render.timedOut) {
            this._status.textContent = "⚠ This formula takes too long to calculate, so the end of the sample was left silent. Try a shorter length.";
            this._status.style.color = ColorConfig.primaryText;
        } else {
            this._status.textContent = "✓ Compiled into a sample of " + length + " values.";
            this._status.style.color = ColorConfig.secondaryText;
        }

        const isSample: boolean = tuning == BytebeatTuning.sample;
        this._sampleTuningRow.style.display = isSample ? "flex" : "none";
        if (isSample) {
            const seconds: number = length / sampleRate;
            this._durationLabel.textContent = "values = " + (seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(3)) + " seconds at " + sampleRate + " Hz";
        } else {
            this._durationLabel.textContent = "values in each cycle of the wave";
        }
        this._rootKeyLabel.textContent = "= " + describeRootKey(this._getRootKey()) + " in the key of C";

        drawBytebeatWaveform(this._waveformCanvas, render, ColorConfig.getComputed("--primary-text"), ColorConfig.getComputed("--editor-background"));

        if (this._previewSource != null) this._startPreview();
    }

    private _updatePreviewButton(): void {
        if (this._previewSource != null) {
            this._previewButton.classList.remove("playButton");
            this._previewButton.classList.add("pauseButton");
            this._previewButton.textContent = "Stop";
            this._previewButton.title = "Stop the preview";
        } else {
            this._previewButton.classList.remove("pauseButton");
            this._previewButton.classList.add("playButton");
            this._previewButton.textContent = "Preview";
            this._previewButton.title = "Listen to the sample on its own";
        }
    }

    private _togglePreview = (): void => {
        if (this._previewSource != null) {
            this._stopPreview();
        } else {
            this._startPreview();
        }
        this._updatePreviewButton();
    }

    // Plays the sample by itself, looping, the way it would sound on the root key (or on middle C for a single cycle).
    private _startPreview(): void {
        this._stopPreview();
        try {
            let context: AudioContext | null = this._previewContext;
            if (context == null) {
                context = <AudioContext>new (window.AudioContext || (<any>window).webkitAudioContext)();
                this._previewContext = context;
                this._previewGain = context.createGain();
                this._previewGain.connect(context.destination);
            }
            const length: number = this._getLength();
            const render: BytebeatRender = renderBytebeat(this._codeInput.value, this._getMode(), length, Config.bytebeatCodeMaxLength);
            const buffer: AudioBuffer = context.createBuffer(1, length, context.sampleRate);
            buffer.getChannelData(0).set(render.wave.subarray(0, length));
            const source: AudioBufferSourceNode = context.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            // The buffer claims to be at the output's sample rate, and is then sped up or slowed down to its real one.
            const samplesPerSecond: number = (this._getTuning() == BytebeatTuning.sample) ? this._getSampleRate() : length * Instrument.frequencyFromPitch(60);
            source.playbackRate.value = samplesPerSecond / context.sampleRate;
            // A bytebeat at full scale is very loud next to everything else, so the preview is turned down, and follows the editor's volume.
            const volume: number = this._doc.prefs.volume;
            this._previewGain!.gain.value = 0.2 * Math.min(1.0, Math.pow(volume / 50.0, 0.5)) * Math.pow(2.0, (volume - 75.0) / 25.0);
            source.connect(this._previewGain!);
            source.start();
            if (context.state == "suspended") context.resume();
            this._previewSource = source;
        } catch (error) {
            // Without audio output there is nothing to preview.
            this._previewSource = null;
        }
    }

    private _stopPreview(): void {
        if (this._previewSource != null) {
            try {
                this._previewSource.stop();
            } catch (error) { }
            this._previewSource.disconnect();
            this._previewSource = null;
        }
    }

    private _whenMouseDown = (): void => {
        this._mouseDownInside = true;
    }

    private _whenMouseUp = (): void => {
        if (!this._mouseDownInside) return;
        this._mouseDownInside = false;
        this.gotMouseUp = true;
        setTimeout(() => { this.gotMouseUp = false; }, 10);
    }

    private _close = (): void => {
        this._doc.prompt = null;
        this._doc.undo();
    }

    public cleanUp = (): void => {
        if (this._updateTimeout != null) clearTimeout(this._updateTimeout);
        this._stopPreview();
        if (this._previewContext != null) {
            this._previewContext.close();
            this._previewContext = null;
        }
        this._codeInput.removeEventListener("input", this._whenCodeEdited);
        this._exampleSelect.removeEventListener("change", this._whenExampleSelected);
        this._modeSelect.removeEventListener("change", this._update);
        this._tuningSelect.removeEventListener("change", this._update);
        this._sampleRateInput.removeEventListener("input", this._whenCodeEdited);
        this._lengthInput.removeEventListener("input", this._whenCodeEdited);
        this._rootKeyInput.removeEventListener("input", this._whenCodeEdited);
        this._sampleRateInput.removeEventListener("change", this._whenNumberCommitted);
        this._lengthInput.removeEventListener("change", this._whenNumberCommitted);
        this._rootKeyInput.removeEventListener("change", this._whenNumberCommitted);
        this._previewButton.removeEventListener("click", this._togglePreview);
        this._okayButton.removeEventListener("click", this._saveChanges);
        this._cancelButton.removeEventListener("click", this._close);
        this.container.removeEventListener("mousedown", this._whenMouseDown);
        document.removeEventListener("mouseup", this._whenMouseUp);
    }

    private _saveChanges = (): void => {
        this._doc.prompt = null;
        this._doc.record(new ChangeBytebeat(this._doc, this._codeInput.value, this._getMode(), this._getTuning(), this._getSampleRate(), this._getLength(), this._getRootKey()), true);
    }
}
