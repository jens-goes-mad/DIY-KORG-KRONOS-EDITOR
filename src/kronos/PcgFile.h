#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace kronos {

// Confirmed by diffing a purpose-built test file (setlist_test.PCG) where
// each parameter was varied in isolation across known slots -- see
// README.md's "SBK1" section for the byte-level derivation. Font size and
// Transpose are NOT included here yet -- their encoding isn't solved.
struct SlotParams {
    bool isProgram = true;  // true = Program, false = Combi
    int bank = 0;           // bank index
    int number = 0;         // program/combi number within that bank (0-127)
    int color = 1;          // 1-based color index (1, 2, 4, 16, ... seen)
    int holdTime = 0;       // Hold Time value
    int volume = 127;       // 0-127, MIDI-style
    bool found = false;     // false if this slot had no SBK1 record at all (e.g. SBK1 missing/malformed)
};

// One song/program slot within a Set List.
struct Song {
    int index = 0;       // 0-based slot position within its Set List (0..127)
    std::string name;     // may be empty -- an unused slot
    SlotParams params;    // from SBK1; params.found is false if SBK1 wasn't parseable
    std::string comment;  // free-text comment, may contain \r\n line breaks; may be empty
    // The actual Combi's own name, looked up from the CMB1/CBK1 instrument
    // bank by params.bank/params.number -- only populated when
    // params.isProgram is false. Program-side lookup (PRG1/PBK1/MBK1) is
    // not implemented yet -- its bank layout is more complex, see
    // README.md. Empty if not applicable/not found.
    std::string instrumentName;
};

// One of the Kronos's 128 Set Lists.
struct Setlist {
    int index = 0;                 // 0-based Set List number (0..127)
    std::string name;              // e.g. "Preload Set List", or "Set List 005" if never renamed
    std::vector<Song> songs;       // always 128 entries (a real Kronos Set List has exactly 128 slots)
};

// Parses a Korg Kronos .PCG/.SNG backup file and extracts all 128 Set Lists
// from its SDB1 ("Set List database") chunk. Loads the whole file into
// memory -- fine for desktop use at the ~50-70MB sizes these files run.
//
// Chunk format and the SDB1 record layout are documented in README.md.
class PcgFile {
public:
    // Returns false and fills `error` on failure (bad magic, missing chunk,
    // truncated/malformed data). Does not throw.
    bool load(const std::string& path, std::string& error);

    // Same as load(), but from bytes already in memory (e.g. a file dropped
    // onto the UI and read via the browser's File API, which has no
    // filesystem path to give us -- see README.md's "Open File" section).
    bool loadFromMemory(std::vector<uint8_t> data, std::string& error);

    const std::vector<Setlist>& setlists() const { return setlists_; }
    std::vector<Setlist>& setlists() { return setlists_; }

private:
    std::vector<Setlist> setlists_;
};

}  // namespace kronos
