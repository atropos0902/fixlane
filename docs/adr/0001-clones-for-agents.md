# 1. Agents get clones, people get worktrees

## Decision

Each agent works in a `git clone --shared` of a local mirror. The mirror's objects are mounted read-only in its container, and nothing else of the mirror is. The branch comes out as a bundle. A worktree is made after that, for the reviewer.

## Why

Worktrees share the stash, the hooks and the config. Two tests in `packages/gitstore/test/mirror.test.ts` show it: a stash from one worktree is popped in another, and a hook written from a worktree runs in the main checkout with the user's rights.

That can be worked around. Hooks can be turned off per command and `git stash` can be wrapped. But every workaround has to hold for every git command that anybody runs near an agent, including the ones the user's editor runs on its own.

## What it costs

A repository with 4,000 files and 301 commits, median of 15, on one machine (`node bench/layout.ts`).

| | time | git data of its own |
| --- | --: | --: |
| worktree | 393 ms | 354 kB |
| shared clone | 499 ms | 420 kB |
| full clone | 772 ms | 7.2 MB |

So about a tenth of a second and 66 kB per session. The checked-out files are the same 16 MB in all three.

The shared clone makes its own index and nothing else. In the container it also has to find the objects, which are mounted at `/mirror/objects`, and that path is written into the clone.

## What follows

- The mirror must not prune while a clone borrows from it. Every session leaves a hold file before it clones, and gc refuses while there is one. A test shows the prune breaking a clone without it.
- `git fetch` from a bundle does not apply `fetch.fsckObjects` on git 2.34. So the daemon reads the bundle's header itself and gives the pack to `git index-pack --strict`.
- The daemon never runs git inside a clone once an agent has been in it. Collecting the branch is done by git in a container.
- An agent can read every object in the mirror, other sessions' branches among them. They are all from the same repository, which it could read anyway.

## What would change it

Git giving each worktree its own stash and hooks. Or a repository so big that the checkout itself hurts, where the answer is a sparse one in both layouts.
