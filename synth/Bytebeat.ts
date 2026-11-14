// Bytebeat support for the "bytebeat" instrument type, which branches off of the chip instrument.
// A bytebeat is a tiny formula of the sample counter "t" (for example "t*(42&t>>10)") whose output
// is treated as audio. Here the formula is compiled and rendered once into a sample, which the chip
// synth then plays back like any other sampled chip wave.
//
// Song data is shared through URLs, so a formula must never be handed to eval()/new Function()
// as-is: that would let a song link run arbitrary JavaScript. Instead the formula is parsed with
// the small expression parser below, and JavaScript source is generated back out of the parsed
// tree. Nothing typed by the user is ever copied into the generated source: identifiers are
// replaced with numbered local slots or with names from a fixed whitelist, numbers are re-printed
// from their parsed value, and string literals are turned into numeric lookup tables. The language
// has no loops, no user functions, no strings at runtime and no property access apart from numeric
// indexing and ".length", so evaluation is bounded and can't reach anything outside of the formula.

export const enum BytebeatMode {
    bytebeat,       // classic: the low 8 bits of the result are an unsigned sample (0 to 255).
    signedBytebeat, // the low 8 bits of the result are a signed sample (-128 to 127).
    floatbeat,      // the result is used directly as a sample between -1 and 1.
    length,
}

export const enum BytebeatTuning {
    sample,      // the sample plays at its own sample rate on the root key, like a custom sample.
    singleCycle, // the whole sample is treated as one cycle of a wave, like a regular chip wave.
    length,
}

export interface BytebeatError {
    readonly message: string;
    // Character index into the formula where the problem was noticed, or -1 if not applicable.
    readonly index: number;
}

export interface BytebeatProgram {
    // Null when the formula failed to compile, in which case `error` is set.
    readonly createRenderer: (() => BytebeatRenderer) | null;
    readonly error: BytebeatError | null;
}

// Writes the raw formula results for t in [start, end) into `out`. Variables assigned by the formula
// keep their values between calls, so a sample can be rendered in several chunks.
export type BytebeatRenderer = (out: Float64Array, start: number, end: number) => void;

export interface BytebeatRender {
    // The centered wave. One extra element at the end duplicates the first, like the other chip waves.
    readonly wave: Float32Array;
    // Running sum of the wave, used by the chip synth for antialiasing. The sums of long samples drift
    // far away from zero, where 32 bit floats get audibly noisy, so this one uses 64 bit floats.
    readonly integral: Float64Array;
    readonly error: BytebeatError | null;
    // True if the formula was so slow that rendering was cut short. The rest of the sample is silent.
    readonly timedOut: boolean;
}

const maxNestingDepth: number = 128;
const maxVariableCount: number = 256;
const maxArrayLiteralItems: number = 4096;
// A formula can't loop, but a huge one evaluated a million times can still take a while. Rendering
// gives up after this long so that a pathological song can't freeze the page indefinitely.
const renderTimeBudgetMs: number = 3000;
const renderChunkSize: number = 16384;

class BytebeatSyntaxError extends Error {
    constructor(message: string, public readonly index: number) {
        super(message);
    }
}

const enum TokenType {
    number,
    string,
    identifier,
    punctuation,
    end,
}

interface Token {
    readonly type: TokenType;
    readonly text: string;   // punctuation and identifier text, or the contents of a string literal.
    readonly value: number;  // the value of a number literal.
    readonly index: number;
}

// Longest first, so that for example ">>>=" isn't read as ">>" followed by ">=".
const punctuation: ReadonlyArray<string> = [
    ">>>=",
    ">>>", "<<=", ">>=", "**=", "===", "!==",
    "**", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
    "+", "-", "*", "/", "%", "&", "|", "^", "~", "!", "<", ">", "=", "?", ":", ",", ";", "(", ")", "[", "]", ".",
];

const assignmentOperators: ReadonlyArray<string> = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^="];

// The left-associative binary operators, from loosest to tightest. ("**" is right-associative and handled separately.)
const binaryOperatorLevels: ReadonlyArray<ReadonlyArray<string>> = [
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "!=", "===", "!=="],
    ["<", ">", "<=", ">="],
    ["<<", ">>", ">>>"],
    ["+", "-"],
    ["*", "/", "%"],
];

// Every function a formula may call, mapped to the fixed JavaScript that is generated for it, along
// with the number of arguments it accepts.
interface BytebeatFunction {
    readonly js: string;
    readonly minArgs: number;
    readonly maxArgs: number;
}

function mathFunction(name: string, minArgs: number = 1, maxArgs: number = minArgs): BytebeatFunction {
    return { js: "Math." + name, minArgs: minArgs, maxArgs: maxArgs };
}

const functions: { [name: string]: BytebeatFunction } = Object.assign(Object.create(null), {
    "sin": mathFunction("sin"), "cos": mathFunction("cos"), "tan": mathFunction("tan"),
    "asin": mathFunction("asin"), "acos": mathFunction("acos"), "atan": mathFunction("atan"), "atan2": mathFunction("atan2", 2),
    "sinh": mathFunction("sinh"), "cosh": mathFunction("cosh"), "tanh": mathFunction("tanh"),
    "asinh": mathFunction("asinh"), "acosh": mathFunction("acosh"), "atanh": mathFunction("atanh"),
    "exp": mathFunction("exp"), "expm1": mathFunction("expm1"),
    "log": mathFunction("log"), "log2": mathFunction("log2"), "log10": mathFunction("log10"), "log1p": mathFunction("log1p"),
    "sqrt": mathFunction("sqrt"), "cbrt": mathFunction("cbrt"), "pow": mathFunction("pow", 2), "hypot": mathFunction("hypot", 1, 8),
    "abs": mathFunction("abs"), "sign": mathFunction("sign"),
    "floor": mathFunction("floor"), "ceil": mathFunction("ceil"), "round": mathFunction("round"), "trunc": mathFunction("trunc"),
    "min": mathFunction("min", 1, 8), "max": mathFunction("max", 1, 8),
    "imul": mathFunction("imul", 2), "clz32": mathFunction("clz32"), "fround": mathFunction("fround"),
    // Several bytebeat players offer int() as a shorthand for floor().
    "int": mathFunction("floor"),
    // Seeded, so that a song sounds the same every time it is loaded.
    "random": { js: "rnd", minArgs: 0, maxArgs: 0 },
});

const constants: { [name: string]: string } = Object.assign(Object.create(null), {
    "PI": "Math.PI", "E": "Math.E", "LN2": "Math.LN2", "LN10": "Math.LN10", "LOG2E": "Math.LOG2E", "LOG10E": "Math.LOG10E",
    "SQRT2": "Math.SQRT2", "SQRT1_2": "Math.SQRT1_2",
    "Infinity": "(1/0)", "NaN": "(0/0)", "true": "true", "false": "false",
});

// Words that mean something in JavaScript. Refusing them as variable names keeps the error messages
// sensible for people who paste in a whole program instead of a formula.
const reservedWords: ReadonlyArray<string> = [
    "var", "let", "const", "function", "return", "for", "while", "do", "if", "else", "switch", "case", "break", "continue",
    "new", "delete", "typeof", "void", "in", "of", "instanceof", "this", "null", "undefined", "class", "try", "catch", "throw",
    "eval", "window", "document", "globalThis", "arguments", "async", "await", "yield", "import", "export", "with",
];

function isIdentifierStart(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code == 95 || code == 36; // A-Z a-z _ $
}

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index: number = 0;
    while (index < source.length) {
        const code: number = source.charCodeAt(index);
        // Whitespace.
        if (code == 32 || code == 9 || code == 10 || code == 13 || code == 160) {
            index++;
            continue;
        }
        // Comments.
        if (code == 47 && source.charCodeAt(index + 1) == 47) { // "//"
            while (index < source.length && source.charCodeAt(index) != 10) index++;
            continue;
        }
        if (code == 47 && source.charCodeAt(index + 1) == 42) { // "/*"
            const end: number = source.indexOf("*/", index + 2);
            if (end == -1) throw new BytebeatSyntaxError("This comment is never closed.", index);
            index = end + 2;
            continue;
        }
        // Numbers.
        if (isDigit(code) || (code == 46 && isDigit(source.charCodeAt(index + 1)))) {
            const start: number = index;
            let value: number;
            const prefix: string = source.substring(index, index + 2).toLowerCase();
            if (prefix == "0x" || prefix == "0b" || prefix == "0o") {
                const radix: number = prefix == "0x" ? 16 : (prefix == "0b" ? 2 : 8);
                index += 2;
                const digitsStart: number = index;
                while (index < source.length && /[0-9a-fA-F]/.test(source.charAt(index))) index++;
                const digits: string = source.substring(digitsStart, index);
                value = digits.length == 0 ? NaN : 0;
                for (let i: number = 0; i < digits.length; i++) {
                    const digit: number = parseInt(digits.charAt(i), 16);
                    if (digit >= radix) { value = NaN; break; }
                    value = value * radix + digit;
                }
            } else {
                while (isDigit(source.charCodeAt(index))) index++;
                if (source.charCodeAt(index) == 46) { // "."
                    index++;
                    while (isDigit(source.charCodeAt(index))) index++;
                }
                const exponentCode: number = source.charCodeAt(index);
                if (exponentCode == 101 || exponentCode == 69) { // "e" or "E"
                    let exponentIndex: number = index + 1;
                    const signCode: number = source.charCodeAt(exponentIndex);
                    if (signCode == 43 || signCode == 45) exponentIndex++;
                    if (isDigit(source.charCodeAt(exponentIndex))) {
                        index = exponentIndex;
                        while (isDigit(source.charCodeAt(index))) index++;
                    }
                }
                value = Number(source.substring(start, index));
            }
            if (isNaN(value) || isIdentifierStart(source.charCodeAt(index))) {
                throw new BytebeatSyntaxError("This number isn't written in a way that is understood.", start);
            }
            tokens.push({ type: TokenType.number, text: "", value: value, index: start });
            continue;
        }
        // Strings. These only exist so that a formula can pick characters out of them, as in "36364689"[t>>13&7].
        if (code == 34 || code == 39 || code == 96) { // " ' `
            const start: number = index;
            index++;
            let text: string = "";
            while (true) {
                if (index >= source.length || source.charCodeAt(index) == 10) throw new BytebeatSyntaxError("This text is never closed with a matching quote.", start);
                const charCode: number = source.charCodeAt(index);
                if (charCode == code) { index++; break; }
                if (charCode == 92) { // backslash
                    const escaped: string = source.charAt(index + 1);
                    if (escaped == "x" && /^[0-9a-fA-F]{2}$/.test(source.substring(index + 2, index + 4))) {
                        text += String.fromCharCode(parseInt(source.substring(index + 2, index + 4), 16));
                        index += 4;
                    } else if (escaped == "u" && /^[0-9a-fA-F]{4}$/.test(source.substring(index + 2, index + 6))) {
                        text += String.fromCharCode(parseInt(source.substring(index + 2, index + 6), 16));
                        index += 6;
                    } else {
                        switch (escaped) {
                            case "n": text += "\n"; break;
                            case "t": text += "\t"; break;
                            case "r": text += "\r"; break;
                            case "0": text += "\0"; break;
                            default: text += escaped; break;
                        }
                        index += 2;
                    }
                    continue;
                }
                if (charCode == 36 && code == 96 && source.charCodeAt(index + 1) == 123) { // "${" inside backticks
                    throw new BytebeatSyntaxError("Template placeholders aren't supported.", index);
                }
                text += source.charAt(index);
                index++;
            }
            tokens.push({ type: TokenType.string, text: text, value: 0, index: start });
            continue;
        }
        // Names.
        if (isIdentifierStart(code)) {
            const start: number = index;
            index++;
            while (index < source.length && (isIdentifierStart(source.charCodeAt(index)) || isDigit(source.charCodeAt(index)))) index++;
            tokens.push({ type: TokenType.identifier, text: source.substring(start, index), value: 0, index: start });
            continue;
        }
        // Operators and brackets.
        let matched: string | null = null;
        for (const candidate of punctuation) {
            if (source.startsWith(candidate, index)) {
                matched = candidate;
                break;
            }
        }
        if (matched == null) {
            // Use the whole code point in the message, in case it is outside of the basic plane.
            throw new BytebeatSyntaxError("The character \"" + String.fromCodePoint(source.codePointAt(index)!) + "\" isn't understood.", index);
        }
        tokens.push({ type: TokenType.punctuation, text: matched, value: 0, index: index });
        index += matched.length;
    }
    tokens.push({ type: TokenType.end, text: "", value: 0, index: source.length });
    return tokens;
}

interface Variable {
    readonly slot: number;
    readonly firstIndex: number;
    assigned: boolean;
}

// Parses a formula and generates JavaScript for it at the same time. Every method returns generated
// source for the part of the formula it consumed, and that source is always "atomic": a single name,
// a list in square brackets, or something wrapped in parentheses. That way the pieces can be combined
// without thinking about JavaScript's own operator precedence or about neighboring symbols merging.
class BytebeatParser {
    private readonly _tokens: Token[];
    private _position: number = 0;
    private _depth: number = 0;
    private readonly _variables: { [name: string]: Variable } = Object.create(null);
    private _variableCount: number = 0;
    public readonly tables: number[][] = [];

    constructor(source: string) {
        this._tokens = tokenize(source);
    }

    public get variableCount(): number {
        return this._variableCount;
    }

    private _peek(offset: number = 0): Token {
        return this._tokens[Math.min(this._position + offset, this._tokens.length - 1)];
    }

    private _isPunctuation(text: string, offset: number = 0): boolean {
        const token: Token = this._peek(offset);
        return token.type == TokenType.punctuation && token.text == text;
    }

    private _take(text: string): boolean {
        if (this._isPunctuation(text)) {
            this._position++;
            return true;
        }
        return false;
    }

    private _expect(text: string, purpose: string): void {
        if (!this._take(text)) throw new BytebeatSyntaxError("Expected \"" + text + "\" " + purpose + ".", this._peek().index);
    }

    private _describe(token: Token): string {
        switch (token.type) {
            case TokenType.end: return "the end of the formula";
            case TokenType.number: return "a number";
            case TokenType.string: return "text";
            default: return "\"" + token.text + "\"";
        }
    }

    private _enter(): void {
        if (++this._depth > maxNestingDepth) throw new BytebeatSyntaxError("This formula is nested too deeply.", this._peek().index);
    }

    private _leave(): void {
        this._depth--;
    }

    private _addTable(values: number[]): string {
        this.tables.push(values);
        return "c" + (this.tables.length - 1);
    }

    private _variable(name: string, index: number): Variable {
        let variable: Variable | undefined = this._variables[name];
        if (variable == undefined) {
            if (reservedWords.indexOf(name) != -1) {
                throw new BytebeatSyntaxError("\"" + name + "\" isn't available here. A bytebeat is a single formula, not a whole program.", index);
            }
            if (this._variableCount >= maxVariableCount) throw new BytebeatSyntaxError("This formula uses too many variables.", index);
            variable = { slot: this._variableCount++, firstIndex: index, assigned: false };
            this._variables[name] = variable;
        }
        return variable;
    }

    // The generated name for something that can be assigned to: "t" or a numbered variable slot.
    private _assignmentTarget(token: Token): string {
        const name: string = token.text;
        if (name == "t") return "t";
        if (name == "Math" || functions[name] != undefined || constants[name] != undefined) {
            throw new BytebeatSyntaxError("\"" + name + "\" is built in and can't be changed.", token.index);
        }
        const variable: Variable = this._variable(name, token.index);
        variable.assigned = true;
        return "v" + variable.slot;
    }

    public parseProgram(): string {
        if (this._peek().type == TokenType.end) throw new BytebeatSyntaxError("The formula is empty.", 0);
        // Semicolons are accepted as separators between expressions, the last of which is the result.
        const parts: string[] = [];
        while (true) {
            while (this._take(";")) { }
            if (this._peek().type == TokenType.end) break;
            parts.push(this._parseSequence());
            if (this._peek().type == TokenType.end) break;
            if (!this._isPunctuation(";")) {
                throw new BytebeatSyntaxError("Didn't expect " + this._describe(this._peek()) + " here.", this._peek().index);
            }
        }
        if (parts.length == 0) throw new BytebeatSyntaxError("The formula is empty.", 0);
        for (const name in this._variables) {
            const variable: Variable = this._variables[name];
            if (!variable.assigned) throw new BytebeatSyntaxError("\"" + name + "\" isn't a known function or variable.", variable.firstIndex);
        }
        return parts.length == 1 ? parts[0] : "(" + parts.join(",") + ")";
    }

    private _parseSequence(): string {
        const parts: string[] = [this._parseAssignment()];
        while (this._take(",")) parts.push(this._parseAssignment());
        return parts.length == 1 ? parts[0] : "(" + parts.join(",") + ")";
    }

    private _parseAssignment(): string {
        const token: Token = this._peek();
        const next: Token = this._peek(1);
        if (token.type == TokenType.identifier && next.type == TokenType.punctuation && assignmentOperators.indexOf(next.text) != -1) {
            this._enter();
            this._position += 2;
            const target: string = this._assignmentTarget(token);
            const value: string = this._parseAssignment();
            this._leave();
            return "(" + target + next.text + value + ")";
        }
        return this._parseTernary();
    }

    private _parseTernary(): string {
        const test: string = this._parseBinary(0);
        if (!this._take("?")) return test;
        this._enter();
        const whenTrue: string = this._parseAssignment();
        this._expect(":", "to finish the \"?\" choice");
        const whenFalse: string = this._parseAssignment();
        this._leave();
        return "(" + test + "?" + whenTrue + ":" + whenFalse + ")";
    }

    private _parseBinary(level: number): string {
        if (level >= binaryOperatorLevels.length) return this._parseExponent();
        const operators: ReadonlyArray<string> = binaryOperatorLevels[level];
        // The operators within a level have equal precedence and group from the left in JavaScript too,
        // so a chain of them is written out flat. Nesting every step in its own parentheses would make
        // long chains too deep for the browser to compile.
        const parts: string[] = [this._parseBinary(level + 1)];
        while (true) {
            const token: Token = this._peek();
            if (token.type != TokenType.punctuation || operators.indexOf(token.text) == -1) break;
            this._position++;
            parts.push(token.text, this._parseBinary(level + 1));
        }
        return parts.length == 1 ? parts[0] : "(" + parts.join("") + ")";
    }

    private _parseExponent(): string {
        const baseToken: Token = this._peek();
        const base: string = this._parseUnary();
        if (!this._isPunctuation("**")) return base;
        if (baseToken.type == TokenType.punctuation && (baseToken.text == "-" || baseToken.text == "+" || baseToken.text == "~" || baseToken.text == "!")) {
            // JavaScript refuses this as ambiguous too.
            throw new BytebeatSyntaxError("Put parentheses around the left side of \"**\" to make it clear what \"" + baseToken.text + "\" applies to.", baseToken.index);
        }
        this._position++;
        this._enter();
        const exponent: string = this._parseExponent();
        this._leave();
        return "(" + base + "**" + exponent + ")";
    }

    private _parseUnary(): string {
        const token: Token = this._peek();
        if (token.type == TokenType.punctuation) {
            if (token.text == "-" || token.text == "+" || token.text == "~" || token.text == "!") {
                this._position++;
                this._enter();
                const operand: string = this._parseUnary();
                this._leave();
                return "(" + token.text + operand + ")";
            }
            if (token.text == "++" || token.text == "--") {
                this._position++;
                const targetToken: Token = this._peek();
                if (targetToken.type != TokenType.identifier) throw new BytebeatSyntaxError("\"" + token.text + "\" needs a variable to change.", token.index);
                this._position++;
                return "(" + token.text + this._assignmentTarget(targetToken) + ")";
            }
        }
        return this._parsePostfix();
    }

    private _parsePostfix(): string {
        let result: string;
        const token: Token = this._peek();
        const next: Token = this._peek(1);
        if (token.type == TokenType.identifier && next.type == TokenType.punctuation && (next.text == "++" || next.text == "--")) {
            this._position += 2;
            result = "(" + this._assignmentTarget(token) + next.text + ")";
        } else if (token.type == TokenType.string) {
            this._position++;
            if (this._isPunctuation(".") && this._peek(1).type == TokenType.identifier && this._peek(1).text == "charCodeAt") {
                // "text".charCodeAt(i) looks the character code up directly.
                this._position += 2;
                this._expect("(", "after charCodeAt");
                this._enter();
                const index: string = this._isPunctuation(")") ? "(0)" : this._parseAssignment();
                this._leave();
                this._expect(")", "to close charCodeAt");
                const codes: number[] = [];
                for (let i: number = 0; i < token.text.length; i++) codes.push(token.text.charCodeAt(i));
                result = "(" + this._addTable(codes) + "[" + index + "])";
            } else {
                // Otherwise text stands for the list of numbers that its characters would convert
                // to, which is what picking a digit out of a string and doing math with it relies on.
                const values: number[] = [];
                for (let i: number = 0; i < token.text.length; i++) values.push(Number(token.text.charAt(i)));
                result = this._addTable(values);
            }
        } else {
            result = this._parsePrimary();
        }

        while (true) {
            if (this._take("[")) {
                this._enter();
                const index: string = this._parseSequence();
                this._leave();
                this._expect("]", "to close the \"[\"");
                // "?." so that indexing into a missing item quietly gives nothing, instead of stopping the render.
                result = "(" + result + "?.[" + index + "])";
            } else if (this._isPunctuation(".")) {
                const member: Token = this._peek(1);
                if (member.type == TokenType.identifier && member.text == "length") {
                    this._position += 2;
                    result = "(" + result + "?.length)";
                } else if (member.type == TokenType.identifier && member.text == "charCodeAt") {
                    throw new BytebeatSyntaxError("charCodeAt only works directly on quoted text.", member.index);
                } else {
                    throw new BytebeatSyntaxError("Didn't expect " + this._describe(member) + " after \".\".", member.index);
                }
            } else if (this._isPunctuation("(")) {
                throw new BytebeatSyntaxError("Only the built in functions can be called.", this._peek().index);
            } else {
                break;
            }
        }
        return result;
    }

    private _parsePrimary(): string {
        const token: Token = this._peek();
        if (token.type == TokenType.number) {
            this._position++;
            // Re-printed from the parsed value. Number literals are never negative or NaN.
            return isFinite(token.value) ? "(" + String(token.value) + ")" : "(1/0)";
        }
        if (token.type == TokenType.punctuation) {
            if (token.text == "(") {
                this._position++;
                this._enter();
                const inner: string = this._parseSequence();
                this._leave();
                this._expect(")", "to close the \"(\"");
                return inner;
            }
            if (token.text == "[") {
                this._position++;
                this._enter();
                const items: string[] = [];
                let allConstant: boolean = true;
                const constantValues: number[] = [];
                while (!this._isPunctuation("]")) {
                    if (items.length >= maxArrayLiteralItems) throw new BytebeatSyntaxError("This list has too many items.", this._peek().index);
                    // Lists made only of plain numbers are the common case, and are built once instead of once per sample.
                    const itemToken: Token = this._peek();
                    const negative: boolean = itemToken.type == TokenType.punctuation && itemToken.text == "-";
                    const numberToken: Token = this._peek(negative ? 1 : 0);
                    const afterNumber: Token = this._peek(negative ? 2 : 1);
                    if (allConstant && numberToken.type == TokenType.number && afterNumber.type == TokenType.punctuation && (afterNumber.text == "," || afterNumber.text == "]")) {
                        constantValues.push(negative ? -numberToken.value : numberToken.value);
                    } else {
                        allConstant = false;
                    }
                    items.push(this._parseAssignment());
                    if (!this._take(",")) break;
                }
                this._leave();
                this._expect("]", "to close the list");
                if (allConstant) return this._addTable(constantValues);
                return "[" + items.join(",") + "]";
            }
        }
        if (token.type == TokenType.identifier) {
            this._position++;
            let name: string = token.text;
            let nameIndex: number = token.index;
            if (name == "Math") {
                // Allow the "Math." prefix, so that formulas written for other players work unchanged.
                const member: Token = this._peek(1);
                if (!this._isPunctuation(".") || member.type != TokenType.identifier) throw new BytebeatSyntaxError("Expected a function or constant after \"Math\".", token.index);
                this._position += 2;
                name = member.text;
                nameIndex = member.index;
                const isMathConstant: boolean = constants[name] != undefined && constants[name].startsWith("Math.");
                if (functions[name] == undefined && !isMathConstant) throw new BytebeatSyntaxError("\"Math." + name + "\" isn't available.", nameIndex);
            }
            const func: BytebeatFunction | undefined = functions[name];
            if (func != undefined) {
                if (!this._take("(")) throw new BytebeatSyntaxError("\"" + name + "\" is a function, so it needs to be followed by \"(\".", nameIndex);
                this._enter();
                const args: string[] = [];
                while (!this._isPunctuation(")")) {
                    args.push(this._parseAssignment());
                    if (!this._take(",")) break;
                }
                this._leave();
                this._expect(")", "to close the call to " + name);
                if (args.length < func.minArgs || args.length > func.maxArgs) {
                    const expected: string = func.minArgs == func.maxArgs ? String(func.minArgs) : func.minArgs + " to " + func.maxArgs;
                    throw new BytebeatSyntaxError("\"" + name + "\" takes " + expected + " value" + (func.maxArgs == 1 ? "" : "s") + ", not " + args.length + ".", nameIndex);
                }
                return "(" + func.js + "(" + args.join(",") + "))";
            }
            if (constants[name] != undefined) return "(" + constants[name] + ")";
            if (name == "t") return "t";
            return "v" + this._variable(name, nameIndex).slot;
        }
        throw new BytebeatSyntaxError("Didn't expect " + this._describe(token) + " here.", token.index);
    }
}

// A small, fast, seedable random number generator (mulberry32) backing random().
function createRandom(seed: number): () => number {
    let state: number = seed | 0;
    return (): number => {
        state = (state + 0x6D2B79F5) | 0;
        let x: number = Math.imul(state ^ (state >>> 15), 1 | state);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

export function compileBytebeat(code: string, maxCodeLength: number = Infinity): BytebeatProgram {
    try {
        if (code.length > maxCodeLength) {
            throw new BytebeatSyntaxError("The formula is too long. It can have at most " + maxCodeLength + " characters.", maxCodeLength);
        }
        const parser: BytebeatParser = new BytebeatParser(code);
        const expression: string = parser.parseProgram();
        let source: string = "\"use strict\";\n";
        for (let i: number = 0; i < parser.tables.length; i++) source += "const c" + i + " = c[" + i + "];\n";
        for (let i: number = 0; i < parser.variableCount; i++) source += "let v" + i + " = 0;\n";
        source += "return function (out, start, end) {\n";
        source += "for (let i = start; i < end; i++) {\n";
        source += "let t = i;\n";
        source += "out[i] = +" + expression + ";\n";
        source += "}\n";
        source += "};\n";
        const factory: Function = new Function("c", "rnd", source);
        const tables: number[][] = parser.tables;
        return {
            createRenderer: (): BytebeatRenderer => factory(tables, createRandom(0x5eed)),
            error: null,
        };
    } catch (error) {
        if (error instanceof BytebeatSyntaxError) {
            return { createRenderer: null, error: { message: error.message, index: error.index } };
        }
        // For example, the browser refusing to compile something enormous.
        return { createRenderer: null, error: { message: "This formula couldn't be compiled.", index: -1 } };
    }
}

// Converts one raw formula result into a sample between -1 and 1.
export function bytebeatValueToSample(value: number, mode: BytebeatMode): number {
    switch (mode) {
        case BytebeatMode.signedBytebeat:
            return (((value + 128) & 255) - 127.5) / 127.5;
        case BytebeatMode.floatbeat:
            return (value != value) ? 0.0 : Math.max(-1.0, Math.min(1.0, value));
        default:
            return ((value & 255) - 127.5) / 127.5;
    }
}

function renderBytebeatUncached(code: string, mode: BytebeatMode, length: number, maxCodeLength: number): BytebeatRender {
    const wave: Float32Array = new Float32Array(length + 1);
    const integral: Float64Array = new Float64Array(length + 1);
    const program: BytebeatProgram = compileBytebeat(code, maxCodeLength);
    if (program.createRenderer == null) {
        // Formulas that don't compile play silence.
        return { wave: wave, integral: integral, error: program.error, timedOut: false };
    }

    // The integral array doubles as scratch space for the raw results until they're processed below.
    let rendered: number = 0;
    let timedOut: boolean = false;
    let error: BytebeatError | null = null;
    try {
        const renderer: BytebeatRenderer = program.createRenderer();
        const startTime: number = Date.now();
        while (rendered < length) {
            const end: number = Math.min(length, rendered + renderChunkSize);
            renderer(integral, rendered, end);
            rendered = end;
            if (rendered < length && Date.now() - startTime > renderTimeBudgetMs) {
                timedOut = true;
                break;
            }
        }
    } catch (exception) {
        error = { message: "This formula failed while it was running.", index: -1 };
        rendered = 0;
    }

    // Center the part that was rendered, so that the integral used for antialiasing wraps around cleanly.
    let sum: number = 0.0;
    for (let i: number = 0; i < rendered; i++) {
        const sample: number = bytebeatValueToSample(integral[i], mode);
        integral[i] = sample;
        sum += sample;
    }
    const average: number = rendered > 0 ? sum / rendered : 0.0;
    let cumulative: number = 0.0;
    for (let i: number = 0; i < length; i++) {
        const sample: number = i < rendered ? integral[i] - average : 0.0;
        wave[i] = sample;
        integral[i] = cumulative;
        cumulative += sample;
    }
    wave[length] = wave[0];
    integral[length] = 0.0;
    return { wave: wave, integral: integral, error: error, timedOut: timedOut };
}

// Rendering a long sample takes a moment, and the same formula gets asked for again every time a
// song is reloaded by undo/redo or copied for exporting, so recent renders are kept around.
const renderCache: Map<string, BytebeatRender> = new Map();
const renderCacheMaxSamples: number = 1 << 22;
let renderCacheSamples: number = 0;

export function renderBytebeat(code: string, mode: BytebeatMode, length: number, maxCodeLength: number = Infinity): BytebeatRender {
    length = Math.max(1, length | 0);
    const key: string = mode + "," + length + "," + maxCodeLength + "," + code;
    const cached: BytebeatRender | undefined = renderCache.get(key);
    if (cached != undefined) {
        // Move it to the end of the map, which keeps the most recently used renders around the longest.
        renderCache.delete(key);
        renderCache.set(key, cached);
        return cached;
    }
    const render: BytebeatRender = renderBytebeatUncached(code, mode, length, maxCodeLength);
    // A render that ran out of time depends on how busy the computer was, so it's worth another try later.
    if (!render.timedOut) {
        renderCache.set(key, render);
        renderCacheSamples += length;
        for (const oldKey of renderCache.keys()) {
            if (renderCacheSamples <= renderCacheMaxSamples || oldKey == key) break;
            renderCacheSamples -= renderCache.get(oldKey)!.wave.length - 1;
            renderCache.delete(oldKey);
        }
    }
    return render;
}
