#include "EditorBridge.h"

namespace {

std::string stringArg(const choc::value::ValueView& args, size_t index) {
    if (args.isArray() && args.size() > index) return args[static_cast<uint32_t>(index)].getWithDefault<std::string>({});
    return {};
}

int intArg(const choc::value::ValueView& args, size_t index, int fallback = -1) {
    if (!args.isArray() || args.size() <= index) return fallback;
    return static_cast<int>(args[static_cast<uint32_t>(index)].getWithDefault<double>(fallback));
}

// Bounds-checked lookup into the `[bank][number]` counts PcgFile::setlistUsageCounts()
// returns -- a bank/number beyond what any slot referenced simply has no entry, i.e. 0 uses.
int countAt(const std::vector<std::vector<int>>& counts, int bank, int number) {
    if (bank < 0 || bank >= static_cast<int>(counts.size())) return 0;
    if (number < 0 || number >= static_cast<int>(counts[bank].size())) return 0;
    return counts[bank][number];
}

choc::value::Value setlistUsagesToValue(const std::vector<kronos::SetlistUsage>& usages) {
    auto result = choc::value::createEmptyArray();
    for (const auto& usage : usages) {
        auto v = choc::value::createObject("SetlistUsage");
        v.setMember("setlistIndex", usage.setlistIndex);
        v.setMember("setlistName", usage.setlistName);
        v.setMember("songIndex", usage.songIndex);
        result.addArrayElement(v);
    }
    return result;
}

// Standard base64 (RFC 4648), decoding whatever the browser's
// FileReader/btoa-equivalent side produced. Returns false on malformed input
// rather than throwing -- this is untrusted data from the UI.
bool decodeBase64(const std::string& in, std::vector<uint8_t>& out) {
    auto valueOf = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };

    out.clear();
    out.reserve(in.size() / 4 * 3);

    int buffer = 0;
    int bitsCollected = 0;
    for (char c : in) {
        if (c == '=' || c == '\n' || c == '\r') continue;
        int v = valueOf(c);
        if (v < 0) return false;

        buffer = (buffer << 6) | v;
        bitsCollected += 6;
        if (bitsCollected >= 8) {
            bitsCollected -= 8;
            out.push_back(static_cast<uint8_t>((buffer >> bitsCollected) & 0xFF));
        }
    }
    return true;
}

}  // namespace

choc::value::Value EditorBridge::makeOk() {
    auto v = choc::value::createObject("Result");
    v.setMember("ok", true);
    return v;
}

choc::value::Value EditorBridge::makeError(const std::string& error) {
    auto v = choc::value::createObject("Result");
    v.setMember("ok", false);
    v.setMember("error", error);
    return v;
}

choc::value::Value EditorBridge::songToValue(const kronos::Song& song) {
    auto v = choc::value::createObject("SongEntry");
    v.setMember("index", song.index);
    v.setMember("label", song.name);
    // From SBK1 -- see README.md ("SBK1") for how these were decoded.
    // Font size and Transpose aren't included: their encoding isn't solved yet.
    v.setMember("paramsFound", song.params.found);
    v.setMember("isProgram", song.params.isProgram);
    v.setMember("bank", song.params.bank);
    v.setMember("number", song.params.number);
    v.setMember("color", song.params.color);
    v.setMember("holdTime", song.params.holdTime);
    v.setMember("volume", song.params.volume);
    v.setMember("comment", song.comment);
    // The actual Combi's own name (cross-referenced from CMB1/CBK1) --
    // empty for Programs (not implemented yet) or if not found.
    v.setMember("instrumentName", song.instrumentName);
    return v;
}

choc::value::Value EditorBridge::programToValue(const kronos::ProgramInfo& program) {
    auto v = choc::value::createObject("ProgramInfo");
    v.setMember("bank", program.bank);
    v.setMember("number", program.number);
    v.setMember("name", program.name);
    return v;
}

choc::value::Value EditorBridge::combiToValue(const kronos::CombiInfo& combi) {
    auto v = choc::value::createObject("CombiInfo");
    v.setMember("bank", combi.bank);
    v.setMember("number", combi.number);
    v.setMember("name", combi.name);
    return v;
}

kronos::Setlist* EditorBridge::setlistOf(const std::string& paneId, int setlistIndex) {
    auto it = m_panes.find(paneId);
    if (it == m_panes.end()) return nullptr;
    auto& setlists = it->second.file.setlists();
    if (setlistIndex < 0 || setlistIndex >= static_cast<int>(setlists.size())) return nullptr;
    return &setlists[static_cast<size_t>(setlistIndex)];
}

kronos::PcgFile* EditorBridge::fileOf(const std::string& paneId) {
    auto it = m_panes.find(paneId);
    if (it == m_panes.end()) return nullptr;
    return &it->second.file;
}

choc::value::Value EditorBridge::finishOpen(const std::string& paneId, Pane pane) {
    m_panes[paneId] = std::move(pane);

    auto& setlists = m_panes[paneId].file.setlists();
    auto result = makeOk();
    result.setMember("setlistCount", static_cast<int>(setlists.size()));
    return result;
}

choc::value::Value EditorBridge::openFile(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const std::string path = stringArg(args, 1);
    if (paneId.empty() || path.empty()) return makeError("openFile requires a pane id and a file path");

    Pane pane;
    pane.sourcePath = path;
    std::string error;
    if (!pane.file.load(path, error)) return makeError(error);

    return finishOpen(paneId, std::move(pane));
}

choc::value::Value EditorBridge::openFileBytes(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const std::string base64Data = stringArg(args, 1);
    const std::string displayName = stringArg(args, 2);
    if (paneId.empty() || base64Data.empty()) return makeError("openFileBytes requires a pane id and file data");

    std::vector<uint8_t> bytes;
    if (!decodeBase64(base64Data, bytes)) return makeError("Malformed file data (base64 decode failed)");

    Pane pane;
    pane.sourcePath = displayName.empty() ? "(dropped file)" : displayName;
    std::string error;
    if (!pane.file.loadFromMemory(std::move(bytes), error)) return makeError(error);

    return finishOpen(paneId, std::move(pane));
}

choc::value::Value EditorBridge::listSetlists(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    auto it = m_panes.find(paneId);
    if (it == m_panes.end()) return choc::value::createEmptyArray();

    auto result = choc::value::createEmptyArray();
    for (const auto& setlist : it->second.file.setlists()) {
        auto v = choc::value::createObject("Setlist");
        v.setMember("index", setlist.index);
        v.setMember("name", setlist.name.empty() ? "(unnamed)" : setlist.name);
        result.addArrayElement(v);
    }
    return result;
}

choc::value::Value EditorBridge::getEntries(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const int setlistIndex = intArg(args, 1);

    const auto* setlist = setlistOf(paneId, setlistIndex);
    if (setlist == nullptr) return choc::value::createEmptyArray();

    auto result = choc::value::createEmptyArray();
    for (const auto& song : setlist->songs) result.addArrayElement(songToValue(song));
    return result;
}

choc::value::Value EditorBridge::moveEntry(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const int setlistIndex = intArg(args, 1);
    const int fromIndex = intArg(args, 2);
    const int toIndex = intArg(args, 3);

    auto* setlist = setlistOf(paneId, setlistIndex);
    if (setlist == nullptr) return makeError("Pane '" + paneId + "' has no such Set List loaded");

    const int count = static_cast<int>(setlist->songs.size());
    if (fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count) {
        return makeError("Entry index out of range");
    }

    std::swap(setlist->songs[fromIndex], setlist->songs[toIndex]);
    // Swapping moved the .index fields along with the songs -- put them back
    // so song.index always reflects the slot's current position, not its origin.
    std::swap(setlist->songs[fromIndex].index, setlist->songs[toIndex].index);
    return makeOk();
}

choc::value::Value EditorBridge::copyEntry(const choc::value::ValueView& args) {
    const std::string srcPaneId = stringArg(args, 0);
    const int srcSetlistIndex = intArg(args, 1);
    const int srcIndex = intArg(args, 2);
    const std::string dstPaneId = stringArg(args, 3);
    const int dstSetlistIndex = intArg(args, 4);
    const int dstIndex = intArg(args, 5);

    auto* srcSetlist = setlistOf(srcPaneId, srcSetlistIndex);
    auto* dstSetlist = setlistOf(dstPaneId, dstSetlistIndex);
    if (srcSetlist == nullptr || dstSetlist == nullptr) {
        return makeError("Source or destination Set List not loaded");
    }

    const int srcCount = static_cast<int>(srcSetlist->songs.size());
    const int dstCount = static_cast<int>(dstSetlist->songs.size());
    if (srcIndex < 0 || srcIndex >= srcCount || dstIndex < 0 || dstIndex >= dstCount) {
        return makeError("Entry index out of range");
    }

    const int dstOriginalIndex = dstSetlist->songs[dstIndex].index;
    kronos::Song copied = srcSetlist->songs[srcIndex];
    copied.index = dstOriginalIndex;  // keep destination slot's position, only its content changes
    dstSetlist->songs[dstIndex] = std::move(copied);
    return makeOk();
}

choc::value::Value EditorBridge::setComment(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const int setlistIndex = intArg(args, 1);
    const int songIndex = intArg(args, 2);
    const std::string newComment = stringArg(args, 3);

    auto* setlist = setlistOf(paneId, setlistIndex);
    if (setlist == nullptr) return makeError("Pane '" + paneId + "' has no such Set List loaded");

    if (songIndex < 0 || songIndex >= static_cast<int>(setlist->songs.size())) {
        return makeError("Entry index out of range");
    }

    setlist->songs[songIndex].comment = newComment;
    return makeOk();
}

choc::value::Value EditorBridge::listPrograms(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    auto* file = fileOf(paneId);
    if (file == nullptr) return choc::value::createEmptyArray();

    // Computed once here rather than per-row (programSetlistUsages() per
    // Program would be O(programs x songs) instead of O(songs)) -- see
    // PcgFile::setlistUsageCounts()'s doc comment.
    auto setlistCounts = file->setlistUsageCounts(/*isProgram=*/true);

    auto result = choc::value::createEmptyArray();
    for (const auto& program : file->programs()) {
        auto v = programToValue(program);
        v.setMember("setlistReferenceCount", countAt(setlistCounts, program.bank, program.number));
        // Combi-internal Program references aren't parsed yet -- omit
        // rather than claim 0 (see docs/README.md's Phase 2 roadmap).
        v.setMember("combiReferenceCountAvailable", false);
        result.addArrayElement(v);
    }
    return result;
}

choc::value::Value EditorBridge::listCombis(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    auto* file = fileOf(paneId);
    if (file == nullptr) return choc::value::createEmptyArray();

    auto setlistCounts = file->setlistUsageCounts(/*isProgram=*/false);

    auto result = choc::value::createEmptyArray();
    for (const auto& combi : file->combis()) {
        auto v = combiToValue(combi);
        const int count = countAt(setlistCounts, combi.bank, combi.number);
        v.setMember("setlistReferenceCount", count);
        // Full usage list too (not just the count) so the UI can show Set
        // List name "badges" for combis with few enough references --
        // skip the per-row query entirely when the bulk count says zero.
        v.setMember("setlistUsages", count > 0
                                          ? setlistUsagesToValue(file->combiSetlistUsages(combi.bank, combi.number))
                                          : choc::value::createEmptyArray());
        result.addArrayElement(v);
    }
    return result;
}

choc::value::Value EditorBridge::getProgramUsage(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    const int bank = intArg(args, 1);
    const int number = intArg(args, 2);

    auto* file = fileOf(paneId);
    if (file == nullptr) return makeError("Pane '" + paneId + "' has no file loaded");

    auto result = makeOk();
    result.setMember("setlistUsages", setlistUsagesToValue(file->programSetlistUsages(bank, number)));
    // Combi-internal Program references aren't parsed yet (see
    // docs/README.md's Phase 2 roadmap) -- this flag is what lets the UI
    // say so honestly instead of implying "zero Combi usages found".
    result.setMember("combiUsagesAvailable", false);
    return result;
}

choc::value::Value EditorBridge::findDuplicatePrograms(const choc::value::ValueView& args) {
    const std::string paneId = stringArg(args, 0);
    auto* file = fileOf(paneId);
    if (file == nullptr) return choc::value::createEmptyArray();

    auto result = choc::value::createEmptyArray();
    for (const auto& group : file->findDuplicatePrograms()) {
        auto groupValue = choc::value::createEmptyArray();
        for (const auto& program : group) {
            auto v = programToValue(program);
            v.setMember("setlistUsageCount",
                        static_cast<int>(file->programSetlistUsages(program.bank, program.number).size()));
            groupValue.addArrayElement(v);
        }
        result.addArrayElement(groupValue);
    }
    return result;
}
