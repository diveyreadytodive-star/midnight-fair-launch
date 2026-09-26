# Public repository fresh-clone verification — 2026-09-27

Source: `https://github.com/diveyreadytodive-star/midnight-fair-launch`, checkout `fef27d20e28d6dc7789474f6becbb095a94a782f`. An isolated `/private/tmp` directory was used; no uncommitted local source or protected `.local` wallet state was copied into it.

Commands run in order:

```sh
git clone --depth 1 https://github.com/diveyreadytodive-star/midnight-fair-launch.git /private/tmp/midnight-fair-launch-fresh-20260927
cd /private/tmp/midnight-fair-launch-fresh-20260927
npm ci
npm run setup:compiler
npm test
```

`npm ci` completed with zero reported vulnerabilities. The repository setup installed Compact `0.31.1` for `aarch64-darwin`. `npm test` compiled the inherited contracts and Fair Launch, passed strict typechecking, then passed **116/116 tests**: 91 repository/web, 11 Fair Launch, and 14 VeilIntent; zero failures. The HTTP integration tests required permission to bind loopback in this execution environment.

This verifies that the published source builds and its test suite runs from a clean checkout. It does **not** prove Preprod deployment, a browser wallet permission prompt, a user-signed bid, or a public write API.
