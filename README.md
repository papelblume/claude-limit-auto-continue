# claude-limit-auto-continue

Keep long Claude.ai tasks running across repeated limit resets: parses the reset time, clicks Continue, refreshes, and chains until the task is done.

A userscript for [Tampermonkey](https://www.tampermonkey.net/) (or a compatible userscript manager) that watches [claude.ai](https://claude.ai) for the "returns at …" limit notice, waits until that time, and presses **Continue** / **Try again** for you.

> **Unofficial.** This project is not affiliated with or endorsed by Anthropic. It does not bypass or shorten any limit; it only clicks the same button you would click yourself once the limit has reset.

## Install

1. Install a userscript manager such as Tampermonkey.
2. Install the script from one of these:
   - **Greasy Fork:** [Claude.ai - Auto-Continue After Limit Reset](https://update.greasyfork.org/scripts/604018/Claudeai%20-%20Auto-Continue%20After%20Limit%20Reset.user.js)
   - **GitHub:** [claude-limit-auto-continue.user.js](https://raw.githubusercontent.com/papelblume/claude-limit-auto-continue/main/claude-limit-auto-continue.user.js) (your userscript manager will offer to install it)
3. Open [claude.ai](https://claude.ai). A small status pill appears while the script is running.

## What it does

- **Reads the reset time from the page.** It looks for notices such as "Your free messages return at 8:50 AM" or "Paused: Your free usage returns at 6:40 AM. Continue then.", and also handles relative wording like "resets in 2 hours".
- **Clicks at the right moment.** Once the reset time passes (plus a small buffer for clock differences), it clicks the Continue / Try again button next to the notice.
- **Recovers if the button is missing.** If no button shows up within a minute of the reset time, it reloads the page and checks again, with increasing gaps between reloads (1, 2, 4, then 5 minutes) and a cap on the total number of reloads.
- **Chains across repeated limits.** After every click it schedules a page refresh 30 minutes later. If the task hit the limit again, the fresh page shows the new notice and the cycle repeats, so a task that needs several Continue presses keeps going.
- **Shows what it is doing.** A status pill shows the current state and countdown, and the browser tab title gets a countdown prefix so you can see it from another tab.
- **Optional notifications.** A desktop notification when the limit reset time is reached (on by default) and, optionally, whenever the script clicks or reloads.

## Controls

- **Status pill:** click it to turn the script on or off. If it says it gave up, click it to try again.
- **Userscript manager menu:**
  - Toggle auto-continue on/off
  - Toggle notify on limit reset
  - Click Continue / Try again now
  - Print diagnostics to console

On/off and notification settings are remembered and kept in sync across open claude.ai tabs.

## Configuration

The settings live in the `CONFIG` block at the top of the script. Edit them in your userscript manager's editor.

| Option | Default | What it does |
| --- | --- | --- |
| `bufferMs` | `3000` | Extra wait after the parsed reset time before clicking |
| `reloadIfNoButtonMs` | `60000` | Reload if no button appears this long after the reset time |
| `maxReloads` | `10` | Stop reloading after this many attempts |
| `maxAttempts` | `8` | Stop after this many clicks that did not make the button go away |
| `refreshAfterClickMs` | `1800000` | Refresh the page this long after each click (`0` turns it off) |
| `pageWideButton` | `true` | If no button is next to the notice, look page-wide for a strict "Continue" / "Try again" |
| `showPill` | `true` | Show the status pill |
| `pillSide` | `'right'` | `'left'` or `'right'` |
| `titleIndicator` | `true` | Prefix the tab title with a countdown |
| `notify` | `false` | Notify when a click or reload happens |
| `notifyOnReset` | `true` | Notify when the limit reset time is reached |
| `debug` | `false` | Log what the script sees to the console (`[auto-continue]`) |

## Notes and limitations

- The claude.ai tab has to stay open in a running browser. Background tabs get throttled timers, so the script re-checks the moment you switch back to the tab.
- It depends on the wording and layout of claude.ai's limit notice and buttons. If Claude's UI changes, detection may break. Turn on `debug` or use **Print diagnostics to console** and open an issue.
- Reload counters are stored per tab, so multiple tabs don't share them. If sessionStorage is unavailable, automatic reloads are switched off to avoid reload loops.
- You are responsible for making sure your use complies with Anthropic's terms for the service you are using.

## Support

Found a bug or a notice wording that isn't recognized? [Open an issue](https://github.com/papelblume/claude-limit-auto-continue/issues) and include the output of **Print diagnostics to console**.

## License

[GPL-3.0](LICENSE)
