#!/usr/bin/env python3
"""Generates a C++ source/header pair embedding every file under a frontend
asset directory as a byte array, for release builds that ship a single
self-contained binary (see EDITOR_EMBED_RESOURCES in CMakeLists.txt)."""

import os
import sys


def sanitize(relative_path: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in relative_path)


def main() -> int:
    if len(sys.argv) != 4:
        print(f"usage: {sys.argv[0]} <frontend_dir> <output_header> <output_source>", file=sys.stderr)
        return 1

    frontend_dir, out_header, out_source = sys.argv[1:4]

    entries = []
    for root, _dirs, files in os.walk(frontend_dir):
        for name in sorted(files):
            abs_path = os.path.join(root, name)
            rel_path = "/" + os.path.relpath(abs_path, frontend_dir).replace(os.sep, "/")
            entries.append(rel_path)
    entries.sort()

    os.makedirs(os.path.dirname(out_header), exist_ok=True)

    with open(out_header, "w") as h:
        h.write("#pragma once\n\n")
        h.write("#include <cstddef>\n#include <vector>\n\n")
        h.write("namespace editor_embedded {\n\n")
        h.write("struct EmbeddedFile {\n")
        h.write("    const char* path;\n")
        h.write("    const unsigned char* data;\n")
        h.write("    std::size_t size;\n")
        h.write("};\n\n")
        h.write("const std::vector<EmbeddedFile>& getEmbeddedFiles();\n\n")
        h.write("}  // namespace editor_embedded\n")

    with open(out_source, "w") as s:
        header_include = os.path.basename(out_header)
        s.write(f'#include "{header_include}"\n\n')
        s.write("namespace editor_embedded {\n\n")
        s.write("namespace {\n\n")

        var_names = {}
        for rel_path in entries:
            var_name = "kData_" + sanitize(rel_path)
            var_names[rel_path] = var_name
            with open(os.path.join(frontend_dir, rel_path.lstrip("/")), "rb") as f:
                data = f.read()

            s.write(f"const unsigned char {var_name}[] = {{\n")
            for i in range(0, len(data), 20):
                chunk = data[i:i + 20]
                s.write("    " + ",".join(f"0x{b:02x}" for b in chunk) + ",\n")
            s.write("};\n\n")

        s.write("}  // namespace\n\n")
        s.write("const std::vector<EmbeddedFile>& getEmbeddedFiles() {\n")
        s.write("    static const std::vector<EmbeddedFile> files = {\n")
        for rel_path in entries:
            var_name = var_names[rel_path]
            s.write(f'        {{ "{rel_path}", {var_name}, sizeof({var_name}) }},\n')
        s.write("    };\n")
        s.write("    return files;\n")
        s.write("}\n\n")
        s.write("}  // namespace editor_embedded\n")

    print(f"Embedded {len(entries)} file(s) from {frontend_dir} into {out_source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
