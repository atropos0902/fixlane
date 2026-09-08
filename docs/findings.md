# Found on the way

Things that were wrong and that a test found. Each has a test now.

| What | Found by |
| --- | --- |
| `fetch.fsckObjects` does nothing for a bundle on git 2.34, so broken objects came in | a hand-made tree with `.git` in it |
| Gitbeaker sends a POST again on a 502, up to ten times, a few milliseconds apart | reading it before using it. The adapter has its own requester |
| A daemon killed right after "done" never removed the review worktree | the crash runs |
| A session cancelled between "running" and the container's start kept its agent until that was finished | a test that failed once in a while |
| Taking over failed when the button was pressed in the moment before the container was there | a desktop test, on a busy machine |
| With the daemon's directory below `/root`, the agent's user could not reach the borrowed objects, because the image has a `/root` of its own | starting it for real. Every test had used `/tmp` |
| Tests could write results into the runner's output through `/proc` | asking what the checks could not see |
| On a full disk, sessions used up their attempts and gave up | the crash runs, on a machine whose disk really was full |
