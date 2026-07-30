---
title: Building the App
links:
  - title: Compiling the DIY Kronos Editor on macOS, Linux, and Windows
    description: CMake-based build instructions, verified via CI on all three platforms
menu:
    main:
        weight: 3
        params:
            icon: cpu

toc: true
---
The editor is a single CMake project with no platform-specific source trees --
[CHOC](https://github.com/Tracktion/choc) provides one native-webview abstraction that
maps to WebKit (macOS), WebKit2GTK (Linux), or WebView2 (Windows) depending on what
`CMakeLists.txt` detects. As of this writing it's built and verified on all three via CI
(macOS arm64 + Intel, Linux x86_64, Windows x86_64) --
[`.github/workflows/native-build.yml`](https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR/blob/main/.github/workflows/native-build.yml)
is the living, tested reference these instructions are drawn from.

## Requirements

| | macOS | Linux | Windows |
|---|---|---|---|
| Compiler | Xcode Command Line Tools (AppleClang) | GCC or Clang | Visual Studio 2022 (MSVC) |
| CMake | 3.21+ | 3.21+ | 3.21+ |
| WebView backend | WebKit + Cocoa (system frameworks, nothing to install) | `libgtk-3-dev` + `libwebkit2gtk-4.1-dev` + `pkg-config` | WebView2 (Evergreen runtime, preinstalled on current Windows 10/11) |
| Python 3 | only for Release builds (`embed_resources.py`) | only for Release builds | only for Release builds |

Linux dependency install (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev pkg-config
```

## Build

```bash
git clone https://github.com/jens-goes-mad/DIY-KORG-KRONOS-EDITOR.git
cd DIY-KORG-KRONOS-EDITOR
cmake -B build -S .
cmake --build build
```

That's a **Debug** build by default -- `frontend/` (the HTML/JS/CSS UI) is read live off
disk from the checked-out source tree at runtime, which is convenient while developing
(edit a file, reload the window, no rebuild needed) but means the binary isn't portable
on its own.

For a **Release** build -- `frontend/` gets embedded into the binary at compile time as
byte arrays (via `tools/embed_resources.py`, hence the Python 3 requirement above), so
the result is a single self-contained executable:

```bash
cmake -B build -S . -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

The `--config Release` flag matters on Windows specifically: MSVC is a multi-config
generator, so the actual build configuration is chosen at build time, not at configure
time, even though `-DCMAKE_BUILD_TYPE=Release` is also needed at configure time (it's
what this project's own `CMakeLists.txt` checks to decide whether to embed resources at
all).

## Where the binary ends up

- macOS / Linux: `build/kronos_editor`
- Windows: `build/Release/kronos_editor.exe` (or `build/Debug/kronos_editor.exe` for a
  Debug build -- MSVC's multi-config generator puts each configuration in its own
  subfolder)

## A note for contributors touching `main.cpp` on Linux

CHOC's `choc_DesktopWindow.h` uses GTK types (`GdkDragContext`, `GtkWidget`, ...) without
including `<gtk/gtk.h>` itself -- it relies on some other header having already pulled
that in. `choc_MessageLoop.h` and `choc_WebView.h` both do (under `#if CHOC_LINUX`), so
one of those **must** be included before `choc_DesktopWindow.h`, or the Linux build fails
with "has not been declared" errors for basic GTK types. `main.cpp` already orders these
correctly -- just worth knowing if you ever reorder those three includes.
