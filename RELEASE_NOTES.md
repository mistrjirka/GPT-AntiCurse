# GPT AntiCurse v0.6.4

Firefox for Android compatibility release.

## Firefox for Android

- Declares Firefox Android support through `browser_specific_settings.gecko_android`, so AMO can list the same Firefox package as Android-compatible.
- Keeps the existing Firefox network-response filtering architecture; no separate mobile fork is required.
- Adds a Firefox-only narrow-screen stylesheet for the on-page status and archived-history controls.
- Moves the mobile status pill above the bottom browser/composer area and accounts for safe-area insets.
- Uses larger touch targets for older-history loading and allows wider user bubbles on narrow screens.

## Popup

- Removes the hard 360 px minimum width so the extension popup cannot overflow narrow mobile viewports.
- On narrow touch devices, the popup may use the full available width, uses larger controls, and stacks export buttons vertically.
- Desktop Firefox and Chromium retain the existing compact popup layout.

## Regression coverage

- Adds a dedicated Firefox Android compatibility test for the AMO manifest declaration, response-filter permissions, packaged mobile CSS, responsive popup sizing, safe-area placement, and touch targets.
- Existing Chromium and desktop Firefox unit/E2E tests remain release gates.

## Scope

- The conversation trimming algorithm, archive format, export format, and desktop history behavior are unchanged.
- Physical-device Android testing is still recommended after AMO signing because CI does not provide an Android Firefox device.
