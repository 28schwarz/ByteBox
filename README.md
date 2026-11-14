# Slarmoo's Box

Slarmoo's Box is an online tool for sketching and sharing instrumental music.
You can find it [here](https://github.com/slarmoo/slarmoosbox/).
It is a modification of [Ultrabox](https://ultraabox.github.io), which is a modification of [JummBox](https://github.com/jummbus/jummbox), which inturn is a modification of the [original BeepBox](https://beepbox.co).

Slarmoo's Box is a mod of Ultrabox that aims to advance Beepbox's capabilities. Feel free to contribute!


All song data is packaged into the URL at the top of your browser. When you make
changes to the song, the URL is updated to reflect your changes. When you are
satisfied with your song, just copy and paste the URL to save and share your
song!

Slarmoo's Box, as well as the beepmods which it's based on, are free projects. If you ever feel so inclined, please support the original creator, [John Nesky](http://www.johnnesky.com/), via
[PayPal](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=QZJTX9GRYEV9N&currency_code=USD)!

## Compiling

The compilation procedure is identical to the repository for BeepBox. I will include the excerpt on compiling from that page's readme below for convenience:

The source code is available under the MIT license. The code is written in
[TypeScript](https://www.typescriptlang.org/), which requires
[node & npm](https://www.npmjs.com/get-npm), so install those first. Then to
build this project, open a command line ([Git Bash](https://gitforwindows.org/)) and run:

```
git clone https://github.com/slarmoo/slarmoosbox.git
cd slarmoosbox
npm install
npm run build
```

JummBox (and by extension, Slarmoo's Box) makes a divergence from BeepBox that necessitates an additional dependency:
rather than using the (rather poor) default HTML select implementation, the custom
library [select2](https://select2.org) is employed. select2 has an explicit dependency
on [jQuery](https://jquery.com) as well, so you may need to install the following
additional dependencies if they are not picked up automatically.

```
npm install select2
npm install @types/select2
npm install @types/jquery
```

## Testing

To test, run

```
npm run live-editor-typeless
```
or
```
npm run let
```



## Code

The code is divided into several folders. This architecture is identical to BeepBox's.

The [synth/](synth) folder has just the code you need to be able to play Slarmoo's Box
songs out loud, and you could use this code in your own projects, like a web
game. After compiling the synth code, open website/synth_example.html to see a
demo using it. To rebuild just the synth code, run:

```
npm run build-synth
```

The [editor/](editor) folder has additional code to display the online song
editor interface. After compiling the editor code, open website/index.html to
see the editor interface. To rebuild just the editor code, run:

```
npm run build-editor
```

The [player/](player) folder has a miniature song player interface for embedding
on other sites. To rebuild just the player code, run:

```
npm run build-player
```

The [website/](website) folder contains index.html files to view the interfaces.
The build process outputs JavaScript files into this folder.

## Bytebeat instruments

The `chip (bytebeat)` instrument type branches off of the chip instrument. Instead
of picking a wave, you write a bytebeat formula, such as `t*(42&t>>10)`. The formula is compiled and calculated once for
every value of the counter `t`, and the results become a sample that is played
back by the same code that plays chip waves, including the loop controls.

- **Mode** decides how results become sound: `bytebeat` keeps the low 8 bits
  (0 to 255), `signed bytebeat` treats those 8 bits as -128 to 127, and
  `floatbeat` uses results between -1 and 1 directly.
- **Length** is the number of values of `t` to calculate, up to 1048576.
- **Tuning** is either `sample`, where the sample plays at its sample rate on the
  root key (like a custom sample), or `single cycle`, where the whole sample is
  one cycle of a wave (like a regular chip wave).

Formulas can use numbers, `t`, arithmetic, bitwise, comparison and logic
operators, `? :`, parentheses, commas, lists (`[1,2,4][t>>12&3]`), text to pick
digits or character codes out of (`"1234"[t>>12&3]`, `"abc".charCodeAt(t&1)`),
variables that keep their value from one `t` to the next (`a=t>>4, a*t`), and
these functions and constants, with or without `Math.` in front: `sin cos tan
asin acos atan atan2 sinh cosh tanh asinh acosh atanh exp expm1 log log2 log10
log1p sqrt cbrt pow hypot abs sign floor ceil round trunc min max imul clz32
fround int random`, `PI E LN2 LN10 LOG2E LOG10E SQRT2 SQRT1_2`.

Since songs are shared as links, a formula is never run as JavaScript directly.
[synth/Bytebeat.ts](synth/Bytebeat.ts) parses it and generates its own code from
only the pieces listed above, so a formula can't do anything besides math. Two
differences from other bytebeat players follow from that: text only acts as a
list of numbers (there is no joining text together with `+`), and `random()`
always produces the same sequence so that a song sounds the same every time.

## Dependencies

Most of the dependencies are listed in [package.json](package.json), although
 Slarmoo's Box also has an indirect, optional dependency on
[lamejs](https://www.npmjs.com/package/lamejs) via
[jsdelivr](https://www.jsdelivr.com/) for exporting .mp3 files. If the user
attempts to export an .mp3 file, Slarmoo's Box will direct the browser to download
that dependency on demand. 

## Offline version

If you'd like to BUILD the offline version, enter the following into the command line of your choice:
```
npm run build-offline
```


After building, you can then enter the following to run it for testing purposes:
```
npm run start
```

And to package, run (do ```npm run package-host``` for your host platform; you may need to run git bash as an administrator for non-host platforms):
```
npm run package
```
