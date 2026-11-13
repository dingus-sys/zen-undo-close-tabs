# Undo Close Tabs for Zen Browser

Press **Cmd+Z** (Ctrl+Z on Windows/Linux) to bring back tabs you just closed in [Zen Browser](https://zen-browser.app).

- Close one tab by accident, press Cmd+Z, and it comes back.
- Hit **Clear** on the sidebar, press Cmd+Z once, and every cleared tab comes back, in the right Space and position.
- The "tabs cleared" toast now tells you to press Cmd+Z.

## Why it keeps working after updates

This is a standalone [Sine](https://github.com/CosmoCreeper/Sine) mod. It doesn't edit Zen or any other mod, so Zen updates and Tidy Tabs updates can't remove it. It marks itself `no-updates`, so Sine won't overwrite it either. It uses Firefox's own session-store undo (the same code behind Cmd+Shift+T), so it follows Zen's tab, Space and folder handling.

## Install

1. Quit Zen (Cmd+Q). Sine rewrites its mod list while running.
2. Run:

   ```bash
   ./install.sh
   ```

   Pass a profile folder as the first argument if you have several Zen profiles.
3. Start Zen.

## Behaviour you can rely on

- **Typing is never hijacked.** If you've typed in the URL bar, a rename box, a search field, or a text field on a web page, Cmd+Z stays normal text undo. An empty URL bar (which Zen focuses after Clear) doesn't count, so Cmd+Z still restores your tabs.
- **Exactly one batch at a time.** One closed tab comes back alone; a Clear brings back just the tabs that Clear closed. Press again to step back to earlier closes.
- **Remembers more than 25.** Firefox only keeps the last 25 closed tabs by default, so the mod raises `browser.sessionstore.max_tabs_undo` to 100 (it never lowers a higher value you set).
- **Nothing recent, nothing happens.** If no tab was closed in the last 15 minutes, Cmd+Z does nothing.

## Settings

In the mod's preferences in Zen:

| Setting | Default | |
| --- | --- | --- |
| `zen.undo-close-tabs.enabled` | on | Turn the shortcut off without uninstalling |
| `zen.undo-close-tabs.window-minutes` | 15 | How long after closing Cmd+Z can still restore. `0` = no limit |

## Troubleshooting

The mod writes one line per Cmd+Z it considered to `undo-close-tabs.log` in your Zen profile folder (`about:support` shows the path), for example `skip: nothing recent` or `restored 3 tab(s)`. It's capped at about 100 KB.

## Known limits

- A text field inside a cross-origin iframe isn't detected, so Cmd+Z there can restore a tab instead of undoing text, but only if you closed a tab in the last 15 minutes.
- Tested on Zen 1.24.1b (macOS).
