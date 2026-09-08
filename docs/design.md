# Design

## Two rules

The state on disk says what is about to happen. It never says what did happen. So after a crash the daemon runs the step again, and every step starts by looking: is the container there, is the branch there, is there a pull request for this head.

Nothing the agent says is evidence. Its one useful word is "stop".

## A session

`packages/core/src/machine.ts` is the whole state machine, a function from a state and a happening to the next state. It does no I/O. `packages/daemon/src/engine.ts` does the work for each state.

| State | Step | Looks first at |
| --- | --- | --- |
| queued | take the lease | the same session asking twice gets the same epoch |
| cloning | hold, clone, write the session's files | starts from nothing each time |
| running | start the container, follow its output | the container's name is the session and attempt, so it can't be made twice |
| checking | collect the bundle, import it, run the checks | the same bundle gives the same commit |
| proposing | push, ask for the pull request | the host is asked for the branch before anything is opened |
| in review | wait for the merge | |

The container's output is read from its first line every time somebody follows it. That is what lets an agent survive its daemon: the next one reads everything again and throws away the lines it has.

## The container

No network at all (`--network none`), no capabilities, a read-only root. Two Unix sockets are mounted, and a small forwarder turns them into ports on localhost.

One leads to the model. It adds the key, allows three paths, counts tokens out of the answers and stops at a budget. The other leads to the package registry. A package name alone is enough to carry data out, so only names that are in the lockfile or the advisory go through, plus what those depend on once the registry has said so.

## Evidence

Four trees are made from two commits.

| | base code | branch code |
| --- | --- | --- |
| base tests | must pass | must still pass |
| branch tests | one has to fail, on an assertion | must pass |

Every run is its own container, on a read-only tree. A test that fails to load, or throws something that isn't an assertion, counts as no proof. That turns away some honest tests too: one that only exercises a new helper fails on base for the wrong reason, and the agent is told to test through functions that already exist.

Dependencies and leaked keys have checks of their own, in `packages/core/src/lockfile.ts` and `secrets.ts`. A ticket names a key by its hash and length, so the key is never copied into a ticket.

## Sync

One append-only log, one number per entry. The numbers come from a locked row. A Postgres sequence hands out 7 and 8 and may commit 8 first, and a reader who then asks for everything after 8 never sees 7.

Desktops fold the log into a board, all with the same function, so they end up the same. Drafts made offline carry an id and wait in an outbox. One that was sent twice is stored once.

A lease has an epoch, and the epoch is in the branch name. Pushing can't be fenced: whoever has the push token can push. Pull requests can, since only the server opens them. It keeps the ticket's row locked from the check of the epoch until the host has answered.

A webhook is a hint to go and look. The server asks the host for the pull request and ignores what the webhook claims, so a late or repeated one changes nothing.

## The desktop app

The renderer has no Node, no network (the content policy names only its own files) and no general way to call the daemon. Ten functions, each with checked arguments. Agent output is stripped of escape sequences before it reaches the terminal.

## Left out

- macOS and Windows. The app would run there, the daemon would not: Unix sockets can't be mounted into containers from those hosts.
- Languages other than JavaScript. The checks run `node --test`.
- The desktop package does not contain the daemon. It is started on its own.
- Users on the sync server are names and tokens in a file.
