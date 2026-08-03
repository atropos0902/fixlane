#!/bin/sh
# Prints the branch as a base64 bundle. Exit 3: there is nothing on it.
set -e
base=$1
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1='*'
export GIT_AUTHOR_NAME=agent GIT_AUTHOR_EMAIL=agent@localhost GIT_COMMITTER_NAME=agent GIT_COMMITTER_EMAIL=agent@localhost
cd /work
rm -f .git/index.lock
git add -A >&2
git diff --cached --quiet || git commit -q --no-verify -m work >&2
[ "$(git rev-list --count "$base..HEAD")" = 0 ] && exit 3
git bundle create -q - "$base..HEAD" | base64 -w0
