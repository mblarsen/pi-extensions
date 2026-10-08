# Image Thumbnail

Show a small image preview after Pi inserts a `pi-clipboard-<uuid>` path into the editor.

- Each preview stays visible for three seconds after its first render.
- Multiple previews form a horizontal row, with the newest on the right.
- The row sits above the editor, aligned to the right. It temporarily reserves space rather than covering conversation text.
- Images keep their aspect ratio. The row scales down in narrow terminals.
- The editor keeps keyboard focus. The extension does not change prompt text, clipboard contents, or image files.

Requires an interactive Pi terminal with Kitty or iTerm2 image support, such as Ghostty. Other modes and terminals do nothing.

## Try locally

From this repository:

```bash
pi --link -e ./packages/image-thumbnail/index.ts
```

Paste an image with Pi's image-paste shortcut. Paste another within three seconds to check the row and independent timers.

## Herdr and Pi 1.1.0

Pi 1.1.0 disables image protocols by default when it detects Herdr, even if images worked with earlier Pi versions.
This affects both thumbnail previews and Pi's image tool results.

Set `PI_IMAGE_PROTOCOL=kitty` to enable Kitty image rendering for the session:

```bash
PI_IMAGE_PROTOCOL=kitty pi --link -e ./packages/image-thumbnail/index.ts
```

This override restored previews in the tested Herdr setup. It bypasses capability detection but does not add image support to a terminal.

## Behavior

The extension checks editor text every 75 milliseconds because Pi has no public editor-change event.
It reads image files only when new clipboard paths appear. Existing paths at session startup do not produce previews.
Manually inserted clipboard paths also produce previews. Removing a path or submitting a prompt does not extend the preview timer.

Missing, invalid, or unsupported images do not produce previews. Files over 20 MiB or 40 million pixels are skipped.
Photon resizes images and combines previews into one PNG for Pi's renderer. The package uses Photon 0.3.4, matching Pi, without Sharp.
