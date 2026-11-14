import { BytebeatMode, BytebeatTuning } from "../synth/Bytebeat";

export interface BytebeatExample {
    readonly name: string;
    readonly code: string;
    readonly mode: BytebeatMode;
    readonly tuning: BytebeatTuning;
    readonly sampleRate: number;
    readonly length: number;
}

// Starting points offered by the bytebeat prompt, and used when randomizing a bytebeat instrument.
// The lengths are chosen so that each sample loops seamlessly.
export const bytebeatExamples: ReadonlyArray<BytebeatExample> = [
    // Longer loops, played back as samples.
    { name: "42 melody", code: "t*(42&t>>10)", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.sample, sampleRate: 8000, length: 65536 },
    { name: "sierpinski harmony", code: "t&t>>8", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.sample, sampleRate: 8000, length: 65536 },
    { name: "minor arpeggio", code: "a=2**([0,3,7,10,12,10,7,3][t>>11&7]/12),\n(t*a*8&128)+(t*a*2&64)", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.sample, sampleRate: 8000, length: 16384 },
    // One-shot sounds. These work best with the loop controls set to "Play Once".
    { name: "kick drum", code: "k=t%4000,\nsin(PI/4000*(40*k+6e4*(1-exp(-k/300))))*exp(-k/1500)", mode: BytebeatMode.floatbeat, tuning: BytebeatTuning.sample, sampleRate: 8000, length: 4000 },
    { name: "hi-hat", code: "(random()*2-1)*exp(-t/600)", mode: BytebeatMode.floatbeat, tuning: BytebeatTuning.sample, sampleRate: 22050, length: 4096 },
    { name: "zap", code: "sin((8e3-t)**2/8e3)*(1-t/8e3)", mode: BytebeatMode.floatbeat, tuning: BytebeatTuning.sample, sampleRate: 8000, length: 8000 },
    // Single cycles, played back like regular chip waves.
    { name: "sawtooth wave", code: "t", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
    { name: "square wave", code: "t&128?255:0", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
    { name: "triangle wave", code: "t<128?t*2:511-t*2", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
    { name: "sine wave", code: "sin(t*PI/128)", mode: BytebeatMode.floatbeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
    { name: "organ wave", code: "a=t*PI/128,\n(sin(a)+sin(a*2)/2+sin(a*3)/3+sin(a*4)/4)/2", mode: BytebeatMode.floatbeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
    { name: "sierpinski wave", code: "(t&t>>4)<<4", mode: BytebeatMode.bytebeat, tuning: BytebeatTuning.singleCycle, sampleRate: 8000, length: 256 },
];
