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
// closeDataset() call; nothing is ever written back to *disk* yet (no Save
// mechanism exists) -- Setlist moveEntry()/copyEntry() only rearrange the
// in-memory Setlist struct, but copyProgram() and putSongRecordBytes() write
// directly into the dataset's own retained raw bytes -- see README.md/STATE.md.
class EditorBridge {
public:
    choc::value::Value openFile(const choc::value::ValueView& args);    // [path] -> {ok, datasetId, displayName, setlistCount}

    // No args -- shows a native "Open" dialog (src/platform/NativeFileDialog.h),
    // invoked directly rather than through CHOC's own WebView-triggered
    // picker (see NativeFileDialog.cpp for why that distinction matters).
    // This is the only UI-reachable way to open a file (drag-and-drop-to-
    // open was removed once this worked -- see STATE.md). Returns the same
    // shape as openFile(), or `{ok: true, cancelled: true}` if the user
    // cancelled (not an error -- see makeCancelled()), or
    // `{ok: true, ..., alreadyOpen: true}` if this exact path was already
    // open (see openFileAtPath() -- opening the same file twice reuses the
    // existing dataset rather than duplicating it in memory). Currently
    // macOS-only; returns an error on platforms NativeFileDialog.cpp
    // doesn't support yet.
    choc::value::Value openFileDialog(const choc::value::ValueView& args);

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
    // Superseded by getSongRecordBytes()/putSongRecordBytes() for the real
    // Setlist row editors (frontend/pane.js), which read-modify-write the
    // Comment field through the same raw-byte path Color/Volume use --
    // this older struct-only setter is unused by them, kept only in case
    // something else still calls it directly.
    choc::value::Value setComment(const choc::value::ValueView& args);

    // [datasetId, setlistIndex, songIndex] -> {ok, bytes:[0-255 x 542]} or
    // {ok:false, error}. The raw SBK1 record for one Set List slot -- see
    // PcgFile::songRecordBytes()'s doc comment. Decoded/edited entirely in
    // JS (frontend/components/kronos/setlist-comment.js and
    // setlist-slot-params.js), the same two-tier data-flow idea
    // decodeProgram()/decodeCombi() already use for detail views.
    choc::value::Value getSongRecordBytes(const choc::value::ValueView& args);

    // [datasetId, setlistIndex, songIndex, bytes[0-255 x 542]] -> {ok} or
    // {ok:false, error}. Writes straight into the dataset's retained raw
    // bytes via PcgFile::putSongRecordBytes(), which also re-derives the
    // decoded Song fields (params/comment) from what was just written --
    // see that method's doc comment for why. This is the Setlist-side
    // counterpart to copyProgram(): the second bridge method that writes
    // directly into a dataset's retained raw bytes rather than only
    // mutating in-memory bookkeeping.
    choc::value::Value putSongRecordBytes(const choc::value::ValueView& args);

    // Library browser (read-only) -- see docs/README.md and STATE.md's
    // Program/Combi Library Editor plan for scope/roadmap.
    choc::value::Value listPrograms(const choc::value::ValueView& args);          // [datasetId]
    choc::value::Value listCombis(const choc::value::ValueView& args);            // [datasetId]
    choc::value::Value getProgramUsage(const choc::value::ValueView& args);       // [datasetId, bank, number]
    choc::value::Value findDuplicatePrograms(const choc::value::ValueView& args); // [datasetId]

    // [datasetId] -> [{bank, bankType}] for every Program bank in this file --
    // lighter than listPrograms() for UI that labels a *bank* rather than a
    // specific Program row (bank-filter buttons, a Set List slot's Bank-jump
    // button). See PcgFile::programBankTypes()'s doc comment.
    choc::value::Value getProgramBankTypes(const choc::value::ValueView& args);

    // [srcDatasetId, srcBank, srcNumber, dstDatasetId, dstBank, dstNumber] ->
    // {ok} or {ok:false, error}. Copies a Program's raw bytes from the source
    // slot into the destination slot -- see PcgFile::copyProgramFrom()'s own
    // doc comment for the exact validation guards (bank type must match,
    // target slot must be empty, no byte-identical duplicate may already
    // exist in the destination dataset). Same-dataset or cross-dataset both
    // work (srcDatasetId may equal dstDatasetId). This is the first bridge
    // method that writes directly into a dataset's retained raw bytes rather
    // than only mutating in-memory bookkeeping -- see STATE.md.
    choc::value::Value copyProgram(const choc::value::ValueView& args);

private:
    struct Dataset {
        kronos::PcgFile file;
        std::string displayName;  // the path it was opened from (both openFile() and openFileDialog() set this to the real path)
    };

    std::map<int, Dataset> m_datasets;
    int m_nextDatasetId = 1;

    kronos::Setlist* setlistOf(int datasetId, int setlistIndex);
    kronos::PcgFile* fileOf(int datasetId);
    choc::value::Value finishOpen(Dataset dataset);
    static choc::value::Value datasetResultValue(int datasetId, const Dataset& dataset);

    // Shared by openFile() (JS supplies the path -- not currently reachable
    // from any UI control) and openFileDialog() (path comes from the native
    // dialog instead). If `path` is already open (an exact displayName
    // match against an existing dataset), returns that dataset's info
    // (with `alreadyOpen: true`) instead of loading a second copy.
    choc::value::Value openFileAtPath(const std::string& path);

    static choc::value::Value makeOk();
    static choc::value::Value makeCancelled();  // user closed the dialog without choosing a file -- not an error
    static choc::value::Value makeError(const std::string& error);
    static choc::value::Value songToValue(const kronos::Song& song);
    static choc::value::Value programToValue(const kronos::ProgramInfo& program);
    static choc::value::Value combiToValue(const kronos::CombiInfo& combi);
};
