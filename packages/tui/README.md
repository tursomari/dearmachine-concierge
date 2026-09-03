# Machtiani Installer TUI

This private package is the deliberately small terminal surface for the
Machtiani Installer. It owns transcript rendering, prompt input, progress and
tool activity, one-at-a-time questions, and terminal startup and restoration.
The installation workflow and DeepSeek Harness integration live outside this
package.

The implementation is derived from the last first-party DeepSeek Harness TUI
at commit `7248b5ec8f8769f882f12fd521504fa48e97bcf3`. The preserved source and
tests are in `upstream/`; the applicable BSD 3-Clause license and attribution
are at the repository root. Machtiani Installer is built on DeepSeek Harness
but is not supported or endorsed by DeepSeek.

The active frontend intentionally omits general-purpose commands, session
switching, file completion, skills, image display, and broad workspace search.
It requires stdin and stdout TTYs. Automated tests use an explicit headless
entry point instead of a hidden non-interactive fallback.
