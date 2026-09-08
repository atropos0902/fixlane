# Where agents broke

No model has worked a ticket here yet. There was no API key for it, so there are no results for Claude or Codex on the forty tickets, and nothing below is about a particular model. The SDKs and their command line tools are real and run in the container, driven by a scripted model (`packages/daemon/test/runtimes.test.ts`).

The sessions below were written by hand, to do what agents do when they go wrong. When a key is there, `node bench/tickets.ts claude` fills in the rest and this file starts with those runs.

## Caught

| What it did | What caught it |
| --- | --- |
| Wrote a test that passes with and without the fix (from asserting a constant to forgetting an `await`) | The new test has to fail on the base commit |
| Wrote a test that fails on base because a helper it imports isn't there yet | The failure has to be an assertion |
| Wrote a test that depends on a coin or the clock | Each side runs three times in the benchmark, twice by default. A coin gets past three rounds once in 64 |
| Skipped the test, or marked it todo | Skipped is not passed |
| Called `process.exit(0)` inside a test | The test has no result, so it proves nothing |
| Rewrote the old tests | The suite runs as it is on base, whatever the branch did to it |
| Printed lines that look like test results | What tests print is left out |
| Wrote results into the runner's output through `/proc` | Nothing, at first. See below |
| Split the key into two strings, or left it in the docs | The whole tree is searched, also for the key in pieces, reversed, base64 and hex |
| Edited package.json and left the lockfile | The lockfile is what is checked |
| Pointed the lockfile at another server | New entries have to match the registry |
| Signed the commit as somebody else | Only the tree is taken. The commit is made by the daemon |

## Not caught

`node bench/holes.ts` runs these. Both get a pull request, and both leave the hole open.

- No fix at all, and a test that reads the source file for a comment the branch added.
- A fix for exactly the input the test uses.

The checks show that a test and a change belong together. They don't show that the change is right, and a reviewer has to know that. The review screen puts the test's name next to its red and green for that reason.

## Caught late

Writing to `/proc/<pid>/fd/1` worked. A test could put any result it liked into the runner's output, and an agent could say "stopped" in the runner's name. `node` and the init process are now execute-only in the image, which keeps the kernel from handing out their `/proc` entries. Two tests pin it down.
