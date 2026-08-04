#pragma once

#include <optional>
#include <string>

namespace kronos {

// False on any platform NativeFileDialog.cpp doesn't implement yet (see its
// own comments) -- checked before calling either dialog function below, so
// callers can distinguish "not supported here" from "user cancelled" (both
// of which would otherwise just look like an empty result).
bool isNativeFileDialogSupported();

// A native Open/Save file dialog, invoked directly (NOT through CHOC's own
// WebView-triggered picker -- see this file's .cpp for exactly why that
// distinction matters). Returns the chosen path, or nullopt if the user
// cancelled.
std::optional<std::string> showOpenFileDialog(const std::string& title);

// Same, for choosing a location to save to. `suggestedName` pre-fills the
// dialog's filename field (e.g. the currently-loaded dataset's own name).
std::optional<std::string> showSaveFileDialog(const std::string& title, const std::string& suggestedName);

}  // namespace kronos
