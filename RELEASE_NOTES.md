# GPT AntiCurse v0.6.3

Chrome Web Store packaging fix.

## Store icon compatibility

- Re-encodes the packaged 16, 32, 48, and 128 px icons as plain 8-bit RGBA PNG files.
- Removes nonessential PNG metadata/chunks from the packaged icon files.
- Keeps the 128 px store icon at the required 128×128 dimensions with transparent padding around the artwork.
- Uses the same normalized icon files in the Chromium and Firefox packages.

## Packaging checks

- Release tests now inspect every manifest icon's PNG header, dimensions, bit depth, color type, compression, filtering, interlace mode, and chunk list.
- The package will fail CI if an icon is no longer a simple standard PNG suitable for browser packaging.

## Scope

- No conversation trimming, history, backup, export, or UI behavior changed in this patch.
- This release exists so the Chrome Web Store can process the packaged 48 px and 128 px icons reliably.
