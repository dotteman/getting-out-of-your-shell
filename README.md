# Getting Out of Your Shell

A short, practical book on the Linux bash shell: the 20% of bash that does 80% of the work. Twelve chapters, twelve labs, a cheat sheet, and an answer key, aimed at people who have opened a terminal, felt uneasy, and closed it again.

The book comes in two editions, built from the same chapter files:

| Edition | File | What it is |
| --- | --- | --- |
| Interactive | [`docs/index.html`](docs/index.html) | The book with a ▶ Run button on the runnable `$` examples and live terminals in every chapter, backed by a bash simulator that runs entirely in the browser, plus a chmod calculator, a quoting sandbox and a script runner |
| Print | [`docs/print.html`](docs/print.html) | The same text as a clean, printable single page |

Both are single self-contained HTML files. Download one and open it in a browser; nothing else is needed.

## The sandbox

Every lab uses the same practice directory, `~/shell-lab`: sales CSVs, application and access logs, nginx configs and a couple of scripts.

- **In the interactive edition** it is already there. Every terminal on the page shares one simulated filesystem, so a file you create in Chapter 3 is still there in Chapter 9, and any "reset sandbox" button starts over.
- **On a real machine**, run [`lab/setup.sh`](lab/setup.sh) (it's also printed in Appendix B):

  ```bash
  bash lab/setup.sh        # creates ~/shell-lab
  cd ~/shell-lab
  ```

A test (`test/seed-parity.mjs`) runs the real script and checks that the browser sandbox matches it file for file, so the answer key holds in both.

## Repository layout

```
book/
  tools/          decides which examples get a ▶ Run button
  parts/          the chapters: front matter, 01–12, appendices A and B
  template/       page frames, styles and the table-of-contents script for each edition
  assets/         the cover image
src/
  engine/         the bash simulator: tokenizer, parser, virtual filesystem, ~90 commands, mini awk and sed
  widgets/        the terminal UI, the ▶ Run buttons and the bonus widgets
lab/setup.sh      the real sandbox setup script
test/             engine regression suite, seed parity, browser smoke test
build.mjs         builds both editions into docs/
```

## Building and testing

Requires Node.js 18 or later.

```bash
node build.mjs            # rebuild docs/index.html and docs/print.html
node build.mjs --check    # fail if docs/ is out of date with the sources
npm test                  # engine regression suite (171 cases), smoke test, seed parity
```

The browser smoke test needs Playwright:

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

CI runs all of these on every push. Edit files under `book/`, `src/` or `lab/`, then run `node build.mjs` and commit the regenerated `docs/` alongside your change.

## Run buttons

`build.mjs` runs every `$` example line in a fresh sandbox (starting in `~/shell-lab`, in order within its block). A line that runs without error output gets a ▶ Run button; examples that use placeholder names (`file.txt`, `app.log`), commands the simulator lacks, history shortcuts, or anything destructive do not. The rules and the exclusion list, with reasons, are in `book/tools/classify.mjs`; `test/run-lines.mjs` pins them.

## About the simulator

The interactive edition does not run a real shell. It runs a purpose-built simulator of the teaching subset of bash: pipes, redirection, globbing, quoting and expansion, `for`/`if`/`while`/`until`, `[[ ]]`, arithmetic, permissions, background jobs, and simplified `grep`, `sed`, `awk`, `find`, `tar`, `rsync` and friends. Where it fakes something (network commands, `top`), it says so in its output.

Not yet supported: `case`, shell functions, here-docs, `trap` and `set -e`, which Chapter 11 teaches. Those examples need a real terminal for now.
