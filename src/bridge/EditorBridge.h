#pragma once

#include <map>
#include <string>

#include "choc/containers/choc_Value.h"
#include "kronos/PcgFile.h"

// Bridge surface exposed to the web UI. Each public method here is bound 1:1
// to a whitelisted JS-callable function in main.cpp (via WebView::bind) --
// there is no generic eval/exec channel into native code from the UI.
//
// Holds any number of loaded .PCG files in memory at once, each a "dataset"
// identified by an id this class mints itself on open (never supplied by the
// caller) -- decoupled entirely from "which UI pane displays it". A file has
// 128 Set Lists; the frontend picks one per pane to view/act on and passes
// its index explicitly on every call (this class holds no "current
// selection" state of its own). Any two calls naming the same datasetId
// (including copyEntry's src/dst) act on the one shared PcgFile, so two panes
// pointed at the same dataset edit the same in-memory file -- this is
// deliberate, see docs/content/components/index.md's dataset section. Dataset
// count is unbounded and nothing evicts a dataset except an explicit
// closeDataset() call; nothing is ever written back to disk yet -- move/copy
// only rearrange the in-memory Setlist struct, see README.md/STATE.md.
class EditorBridge {
public:
    choc::value::Value openFile(const choc::value::ValueView& args);    // [path] -> {ok, datasetId, displayName, setlistCount}

    // [base64Data, displayName] -- for files handed over by the browser's
    // File API (e.g. dropped onto a pane), which has no filesystem path to
    // give us. See README.md ("Open File").
    choc::value::Value openFileBytes(const choc::value::ValueView& args);

    // No args -- every currently open dataset, so any UI selector (a pane, or
    // Library) can populate/refresh its options regardless of which pane (if
    // any) originally opened it.
    choc::value::Value listDatasets(const choc::value::ValueView& args);   // [] -> [{datasetId, displayName, setlistCount}]

    // Frees a loaded dataset. A no-op (still returns ok) if datasetId is
    // already gone -- callers don't need to track whether they raced another
    // close. Nothing here checks whether a pane is currently showing it;
    // that's the frontend's job (reset to empty state on the next
    // listDatasets() refresh it was already subscribed to).
    choc::value::Value closeDataset(const choc::value::ValueView& args);   // [datasetId]

    choc::value::Value listSetlists(const choc::value::ValueView& args);  // [datasetId]
    choc::value::Value getEntries(const choc::value::ValueView& args);    // [datasetId, setlistIndex]
    choc::value::Value moveEntry(const choc::value::ValueView& args);     // [datasetId, setlistIndex, fromIndex, toIndex] (swap)
    choc::value::Value copyEntry(const choc::value::ValueView& args);     // [srcDatasetId, srcSetlistIndex, srcIndex, dstDatasetId, dstSetlistIndex, dstIndex]

    // [datasetId, setlistIndex, songIndex, newComment] -- in-memory only,
    // like move/copy; nothing is written back to disk (see README.md/STATE.md).
    choc::value::Value setComment(const choc::value::ValueView& args);

    // Library browser (read-only) -- see docs/README.md and STATE.md's
    // Program/Combi Library Editor plan for scope/roadmap.
    choc::value::Value listPrograms(const choc::value::ValueView& args);          // [datasetId]
    choc::value::Value listCombis(const choc::value::ValueView& args);            // [datasetId]
    choc::value::Value getProgramUsage(const choc::value::ValueView& args);       // [datasetId, bank, number]
    choc::value::Value findDuplicatePrograms(const choc::value::ValueView& args); // [datasetId]

private:
    struct Dataset {
        kronos::PcgFile file;
        std::string displayName;  // shown to the user; not necessarily a real filesystem path (see openFileBytes)
    };

    std::map<int, Dataset> m_datasets;
    int m_nextDatasetId = 1;

    kronos::Setlist* setlistOf(int datasetId, int setlistIndex);
    kronos::PcgFile* fileOf(int datasetId);
    choc::value::Value finishOpen(Dataset dataset);

    static choc::value::Value makeOk();
    static choc::value::Value makeError(const std::string& error);
    static choc::value::Value songToValue(const kronos::Song& song);
    static choc::value::Value programToValue(const kronos::ProgramInfo& program);
    static choc::value::Value combiToValue(const kronos::CombiInfo& combi);
};
