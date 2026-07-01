# slack-emojis

Slack/GitHub-style emoji shortcodes for Pi.

## What it does

- Converts submitted user input like `:moon:` into `🌔` before the agent sees it.
- Adds editor autocomplete for `:shortcode` tokens; press Tab/Enter on a suggestion to insert the emoji.
- Leaves shortcodes inside inline code and fenced code blocks unchanged.

## Examples

| Input | Output |
|-------|--------|
| `ship it :rocket:` | `ship it 🚀` |
| `:moon:` | `🌔` |
| ``keep `:moon:` literal`` | ``keep `:moon:` literal`` |

## Command

```text
/slack-emojis moon
```

Shows the emoji mapped by a shortcode.

## Data source

Uses [`gemoji`](https://github.com/wooorm/gemoji), the GitHub emoji shortcode dataset. These shortcodes overlap well with Slack's built-in emoji names, including `:moon:`.

Slack workspace-specific custom emojis are not included; those would need Slack API access via `emoji.list`.
