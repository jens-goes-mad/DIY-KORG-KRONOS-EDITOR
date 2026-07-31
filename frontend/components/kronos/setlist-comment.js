// SetlistComment: a Comment textarea + font-size button bar (XS/S/M/L/XL)
// for one SBK1 Set List song record. Deliberately standalone -- reads and
// writes a raw 542-byte record (see docs/README.md's "SBK1" section), with
// no dependency on the rest of this app, choc, or a native build at all.
// Open setlist-comment.test.html directly (via a static file server, see
// its own comment) to develop/test this file in complete isolation.
//
// Comment (offset +18, NUL-terminated ASCII, may contain literal \r\n) and
// Font size (below) are both CONFIRMED -- see docs/README.md §4.3-4.4 and
// src/kronos/PcgFile.cpp's readSlotParams() for the C++ side of the same
// derivation.
//
// Font size is 3 bits split across two bytes that are each ALSO used by a
// different field: +12's top 2 bits (that byte's other bits are Type+
// Color) and +17's bit 4 (that byte's other bits are Transpose's low 3
// bits, plus some still-unexplained ones). Every read/write below masks
// to exactly the bits Font size owns -- clearing only those bits before
// OR-ing in the new value -- so this component never clobbers Color,
// Transpose, or anything else packed into the same bytes.
export const RECORD_SIZE = 542; // SBK1 song record stride (docs/README.md §4.2)
const TYPE_COLOR_OFFSET = 12; // docs/README.md §4.3 -- bits6-7 are Font size's low 2 bits
const FONT_SIZE_LOW_MASK = 0xc0; // bits 6-7 of +12
const FONT_TRANSPOSE_OFFSET = 17; // docs/README.md §4.3 -- bit4 is Font size's high bit
const FONT_SIZE_HIGH_MASK = 0x10; // bit 4 of +17
const COMMENT_OFFSET = 18; // docs/README.md §4.3

export const FONT_SIZES = ["XS", "S", "M", "L", "XL"]; // UI display order (small to large)
// The real confirmed encoding value per size (docs/README.md §4.4) -- NOT
// the same order as FONT_SIZES above: 0=S is the true baseline/default
// (zero extra bits set), not XS.
const FONT_SIZE_VALUE = { S: 0, XS: 1, M: 2, L: 3, XL: 4 };
const FONT_SIZE_BY_VALUE = ["S", "XS", "M", "L", "XL"]; // index by value directly
const DEFAULT_FONT_SIZE = "S";
// Purely cosmetic mapping for the live-preview textarea font -- no relation
// to any real Kronos value (font size is a discrete named size on the
// Kronos, not a point size).
const FONT_SIZE_PX = { XS: 10, S: 12, M: 14, L: 18, XL: 24 };

// bytes: a 542-byte Uint8Array/Array-like, one SBK1 song record.
// Returns { comment, fontSize }.
export function decodeSetlistComment(bytes) {
  if (bytes.length !== RECORD_SIZE) {
    throw new Error(`decodeSetlistComment: expected ${RECORD_SIZE} bytes, got ${bytes.length}`);
  }
  let end = COMMENT_OFFSET;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const comment = bytesToLatin1String(bytes.slice(COMMENT_OFFSET, end));

  const typeColor = bytes[TYPE_COLOR_OFFSET];
  const fontTranspose = bytes[FONT_TRANSPOSE_OFFSET];
  const fontValue =
    (fontTranspose & FONT_SIZE_HIGH_MASK ? 4 : 0) | (typeColor & 0x80 ? 2 : 0) | (typeColor & 0x40 ? 1 : 0);
  const fontSize = FONT_SIZE_BY_VALUE[fontValue] || DEFAULT_FONT_SIZE;

  return { comment, fontSize };
}

// Returns a NEW 542-byte Uint8Array: the Comment region replaced with
// `state.comment` (NUL-terminated, zero-padded to record end), and the
// Font size bits set per `state.fontSize` -- everything else, including
// every OTHER bit of the two bytes Font size shares with Color/Transpose,
// byte-identical to the input.
export function encodeSetlistComment(bytes, state) {
  if (bytes.length !== RECORD_SIZE) {
    throw new Error(`encodeSetlistComment: expected ${RECORD_SIZE} bytes, got ${bytes.length}`);
  }
  const out = Uint8Array.from(bytes);

  const value = FONT_SIZE_VALUE[state.fontSize] ?? FONT_SIZE_VALUE[DEFAULT_FONT_SIZE];
  const lowBits = (value & 2 ? 0x80 : 0) | (value & 1 ? 0x40 : 0);
  // Clear only Font size's own bits first (& ~mask), THEN OR in the new
  // value -- never a plain assignment, or this would silently destroy
  // whatever Color/Transpose/unexplained bits already lived in that byte.
  out[TYPE_COLOR_OFFSET] = (bytes[TYPE_COLOR_OFFSET] & ~FONT_SIZE_LOW_MASK) | lowBits;
  out[FONT_TRANSPOSE_OFFSET] =
    (bytes[FONT_TRANSPOSE_OFFSET] & ~FONT_SIZE_HIGH_MASK) | (value & 4 ? FONT_SIZE_HIGH_MASK : 0);

  const commentBytes = latin1StringToBytes(state.comment || "");
  const maxLen = RECORD_SIZE - COMMENT_OFFSET - 1; // leave room for the NUL terminator
  const truncated = commentBytes.slice(0, maxLen);
  out.fill(0, COMMENT_OFFSET, RECORD_SIZE);
  out.set(truncated, COMMENT_OFFSET);
  // out[COMMENT_OFFSET + truncated.length] is already 0 from the fill() above.
  return out;
}

function bytesToLatin1String(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function latin1StringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

// Mounts the editor into `container` (any Element), seeded from
// `initialBytes` (a 542-byte record). Calls `onChange(newBytes)` -- a
// fresh Uint8Array from encodeSetlistComment() -- on every edit.
// Returns { getBytes(), setBytes(bytes) } so a host app can push updates
// in (e.g. after loading a different slot) without remounting.
export function createSetlistCommentEditor(container, initialBytes, { onChange } = {}) {
  container.innerHTML = "";
  container.classList.add("setlist-comment-editor");

  const bar = document.createElement("div");
  bar.className = "setlist-comment-fontbar";
  const buttons = {};
  for (const size of FONT_SIZES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = size;
    btn.addEventListener("click", () => setFontSize(size));
    buttons[size] = btn;
    bar.appendChild(btn);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "setlist-comment-textarea";
  textarea.spellcheck = false;

  container.append(bar, textarea);

  let state = decodeSetlistComment(initialBytes);
  applyState();

  function applyState() {
    textarea.value = state.comment;
    textarea.style.fontSize = `${FONT_SIZE_PX[state.fontSize] || FONT_SIZE_PX[DEFAULT_FONT_SIZE]}px`;
    for (const size of FONT_SIZES) buttons[size].classList.toggle("active", size === state.fontSize);
  }

  function setFontSize(size) {
    state = { ...state, fontSize: size };
    initialBytes = encodeSetlistComment(initialBytes, state);
    applyState();
    onChange && onChange(initialBytes);
  }

  textarea.addEventListener("input", () => {
    state = { ...state, comment: textarea.value };
    initialBytes = encodeSetlistComment(initialBytes, state);
    onChange && onChange(initialBytes);
  });

  return {
    getBytes: () => encodeSetlistComment(initialBytes, state),
    setBytes: (bytes) => {
      initialBytes = bytes;
      state = decodeSetlistComment(bytes);
      applyState();
    },
  };
}
