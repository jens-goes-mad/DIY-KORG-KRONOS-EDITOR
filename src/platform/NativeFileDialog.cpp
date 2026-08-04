#include "NativeFileDialog.h"

#include "choc/platform/choc_Platform.h"

#if CHOC_APPLE

#include "choc/platform/choc_ObjectiveCHelpers.h"

namespace kronos {

namespace {

// NSModalResponseOK -- Cocoa defines this as 1 for both NSOpenPanel's and
// NSSavePanel's runModal() result.
constexpr long kModalResponseOK = 1;

}  // namespace

bool isNativeFileDialogSupported() {
    return true;
}

std::optional<std::string> showOpenFileDialog(const std::string& title) {
    using namespace choc::objc;
    std::optional<std::string> result;
    CHOC_AUTORELEASE_BEGIN
    id panel = callClass<id>("NSOpenPanel", "openPanel");
    call<void>(panel, "setTitle:", getNSString(title));
    call<void>(panel, "setCanChooseFiles:", (BOOL) true);
    call<void>(panel, "setCanChooseDirectories:", (BOOL) false);
    call<void>(panel, "setAllowsMultipleSelection:", (BOOL) false);

    // A plain app-modal runModal() call -- deliberately NOT
    // beginSheetModalForWindow:completionHandler: (what CHOC's own WebView-
    // triggered <input type="file"> picker uses internally -- see
    // choc_WebView.h's runOpenPanelWithParameters delegate). That sheet is
    // documented (STATE.md's blind spots) to appear behind the app window
    // on macOS. This is a genuinely different code path: an app-modal panel
    // isn't attached to any specific window at all, so there's no window
    // for it to end up behind.
    long response = call<long>(panel, "runModal");
    if (response == kModalResponseOK) {
        id url = call<id>(panel, "URL");
        id path = call<id>(url, "path");
        result = getString(path);
    }
    CHOC_AUTORELEASE_END
    return result;
}

std::optional<std::string> showSaveFileDialog(const std::string& title, const std::string& suggestedName) {
    using namespace choc::objc;
    std::optional<std::string> result;
    CHOC_AUTORELEASE_BEGIN
    id panel = callClass<id>("NSSavePanel", "savePanel");
    call<void>(panel, "setTitle:", getNSString(title));
    if (!suggestedName.empty()) call<void>(panel, "setNameFieldStringValue:", getNSString(suggestedName));

    long response = call<long>(panel, "runModal");  // see showOpenFileDialog()'s comment -- same app-modal approach
    if (response == kModalResponseOK) {
        id url = call<id>(panel, "URL");
        id path = call<id>(url, "path");
        result = getString(path);
    }
    CHOC_AUTORELEASE_END
    return result;
}

}  // namespace kronos

#elif CHOC_WINDOWS || CHOC_LINUX

// Not implemented yet -- writing untested IFileOpenDialog (Windows) or
// GtkFileChooserNative (Linux) code with no way to verify it in this
// environment would violate this project's "verify by actually running it"
// standard (see CLAUDE.md). A known, tracked gap (see STATE.md's blind
// spots), not attempted blind -- macOS is proven first, these follow once
// someone can actually test them on that platform.
namespace kronos {

bool isNativeFileDialogSupported() {
    return false;
}

std::optional<std::string> showOpenFileDialog(const std::string&) {
    return std::nullopt;
}

std::optional<std::string> showSaveFileDialog(const std::string&, const std::string&) {
    return std::nullopt;
}

}  // namespace kronos

#endif
