# Vouch

Koed uses [Vouch](https://github.com/mitchellh/vouch) for explicit contributor trust.

## Policy

- `.github/VOUCHED.td` is source of truth for vouched and denounced GitHub users.
- `Vouch PR` checks PR authors on `pull_request_target`.
- `Vouch Issue` checks issue authors on `issues.opened` and `issues.reopened`.
- `Vouch Manage by Issue` lets trusted collaborators update `.github/VOUCHED.td` from issue comments.

## Comment commands

Trusted collaborators can comment on issues or PRs:

- `vouch` — vouch for issue or PR author
- `vouch @user` — vouch for named user
- `denounce` — denounce issue or PR author
- `denounce @user` — denounce named user
- `unvouch` — remove user from trust list

## Branch protection

To make PR gating effective, require `Vouch PR / Check PR author trust` in GitHub branch protection or rulesets.

## File format

Example entries:

```text
# comment
github:alice
-github:badactor reason for denouncement
```

Keep entries sorted. Use GitHub usernames only.
