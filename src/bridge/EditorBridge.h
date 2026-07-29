#pragma once

#include <map>
#include <string>

#include "choc/containers/choc_Value.h"
#include "kronos/PcgFile.h"

// Bridge surface exposed to the web UI. Each public method here is bound 1:1
// to a whitelisted JS-callable function in main.cpp (via WebView::bind) --
// there is no generic eval/exec channel into native code from the UI.
//
// Holds up to a handful of loaded .PCG files in memory at once, each keyed
// by a caller-chosen "pane" id (the frontend's two Norton-Commander-style
// panes use "A" and "B"). A file has 128 Set Lists; the frontend picks one
// per pane to view/act on and passes its index explicitly on every call
// (this class holds no "current selection" state of its own). Nothing is
// ever written back to disk yet -- move/copy only rearrange the in-memory
// Setlist struct, see README.md / STATE.md for that limitation.
class EditorBridge {
public:
    choc::value::Value openFile(const choc::value::ValueView& args);    // [paneId, path]

    // [paneId, base64Data, displayName] -- for files handed over by the
    // browser's File API (e.g. dropped onto a pane), which has no
    // filesystem path to give us. See README.md ("Open File").
    choc::value::Value openFileBytes(const choc::value::ValueView& args);

    choc::value::Value listSetlists(const choc::value::ValueView& args);  // [paneId]
    choc::value::Value getEntries(const choc::value::ValueView& args);    // [paneId, setlistIndex]
    choc::value::Value moveEntry(const choc::value::ValueView& args);     // [paneId, setlistIndex, fromIndex, toIndex] (swap)
    choc::value::Value copyEntry(const choc::value::ValueView& args);     // [srcPaneId, srcSetlistIndex, srcIndex, dstPaneId, dstSetlistIndex, dstIndex]

    // [paneId, setlistIndex, songIndex, newComment] -- in-memory only, like
    // move/copy; nothing is written back to disk (see README.md/STATE.md).
    choc::value::Value setComment(const choc::value::ValueView& args);

private:
    struct Pane {
        kronos::PcgFile file;
        std::string sourcePath;
    };

    std::map<std::string, Pane> m_panes;

    kronos::Setlist* setlistOf(const std::string& paneId, int setlistIndex);
    choc::value::Value finishOpen(const std::string& paneId, Pane pane);

    static choc::value::Value makeOk();
    static choc::value::Value makeError(const std::string& error);
    static choc::value::Value songToValue(const kronos::Song& song);
};
